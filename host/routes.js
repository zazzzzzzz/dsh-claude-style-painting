/**
 * The plugin's host routes: everything the browser half cannot reach itself.
 *
 * These are the surfaces D11 describes — the model copy document, the webfonts,
 * the OS user, the HDSL account, Deepy's sheets, session deletion and the usage
 * and search roll-ups — each registered on the host's web server under this
 * plugin's route prefix. Registration is defensive: a host without a web server
 * must still activate the skin, so every route is registered in its own try and
 * a refusal only warns.
 */
import { createReadStream, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHdslAccount } from './hdsl.js'
import { QUERY_MAX, createSessionSearch } from './search.js'
import { createUsage } from './usage.js'

/** Route prefix this plugin owns; the browser half reads `${ROUTE_PREFIX}/${COPY_FILE}`. */
const ROUTE_PREFIX = '/dsh-claude-painting'
/** The copy document, built from `src/model-descriptions.json` by scripts/build.mjs. */
const COPY_FILE = 'model-descriptions.json'
/**
 * Webfonts this plugin serves under `${ROUTE_PREFIX}/fonts/`, mapped to their
 * content type. The table is a whitelist: the filename is the whole request
 * contract, so nothing below the package's `fonts/` directory is reachable
 * and no path traversal is possible. The JetBrains Mono files ship in the
 * npm package; the Anthropic faces do not (copyright) — their entries exist so
 * a user-supplied copy in `fonts/` is served, and readFileSync's ENOENT turns
 * into a 404 the browser half's font stacks fall back from.
 */
const FONT_FILES = {
  'JetBrainsMonoVariable.ttf': 'font/ttf',
  'JetBrainsMonoItalicVariable.ttf': 'font/ttf',
  'AnthropicSansWebText.ttf': 'font/ttf',
  'AnthropicSerifWebText.ttf': 'font/ttf',
}
/**
 * Deepy's animation sheets, served under `${ROUTE_PREFIX}/deepy/` from the
 * build output in `lib/deepy/`. The file name is the whole request contract
 * and its shape admits no separator and no dot segment, so nothing outside
 * that directory is reachable; a name with no sheet is a 404. The browser
 * half puts its build id in the query, so a long cache never serves a sheet
 * from another build.
 */
const DEEPY_FILE = /^[a-z]+(?:-[a-z]+)*\.png$/
/**
 * The artwork table and the character files it names, served under
 * `${ROUTE_PREFIX}/artwork/` from the package's own `assets/` directory.
 *
 * The path is the whole request contract: its first segment is a character id
 * the table carries, every later segment a file inside that character's
 * directory. Segments that could climb out of that directory are refused
 * before resolution and the resolved path is checked against the directory
 * again afterwards, so nothing beside a shipped file is reachable.
 */
const ARTWORK_ROUTE = '/artwork/'
const ARTWORK_TABLE_FILE = 'themes.json'
const ARTWORK_ID = /^[a-z0-9][a-z0-9-]*$/
const ARTWORK_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
/** The bytes an artwork file can be served as; anything else is a download. */
const ARTWORK_TYPES = {
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
}
/** One-shot host OS user route; the browser half caches the response. */
const USERNAME_PATH = `${ROUTE_PREFIX}/username`

/**
 * The HDSL launcher's account contract, as this half forwards it.
 *
 * HDSL publishes who the player is through `HDSL_`-prefixed variables (its
 * plugin guide lives in the launcher's own repository). The browser half cannot
 * read a process environment, and the player's avatar is a PNG that only exists
 * under the launcher's data directory, so both are served from here: this route
 * answers the metadata, the sibling route below answers the bytes.
 */
const HDSL_PATH = `${ROUTE_PREFIX}/hdsl`
/** The player's own avatar PNG, forwarded; the absolute path never leaves this half. */
const HDSL_SKIN_PATH = `${ROUTE_PREFIX}/hdsl-skin.png`

/**
 * Session deletion.
 *
 * The harness gives the browser half no deletion API of its own: the workspace
 * controller archives and unarchives, and the agent protocol's session delete is
 * the host delegating to an ACP agent that owns the storage. The archived row's
 * delete button therefore comes here, where the stored session directory under
 * the harness home is removed and the id is dropped from the workspace
 * registry's archive set — the stored-directory miss included, so an archive
 * entry whose storage is already gone leaves the set instead of pinning its
 * row to the list. The path is also spelled in
 * src/constants.js (SESSION_DELETE_ROUTE) for the browser half; keep the two in
 * step.
 */
const SESSION_DELETE_PATH = `${ROUTE_PREFIX}/session-delete`
/**
 * Cross-session usage roll-up for the home dashboard.
 *
 * The browser half cannot reach the host's `sessionQuery` service and cannot
 * read the cost-meter ledger, so the day buckets are assembled here and handed
 * over as one small JSON document. The route answers immediately with whatever
 * is already known: a cold pass reports `computing` and the browser half keeps
 * its skeleton up while it polls.
 */
const USAGE_PATH = `${ROUTE_PREFIX}/usage`
/** How long a computed roll-up is served before a background refresh is kicked. */
const USAGE_TTL_MS = 5 * 60 * 1000
/**
 * Message-content search for the search palette (host/search.js). `?q=` is
 * the query; without one the route only brings its message cache up to date,
 * which the palette asks for as it opens so the first real query is quick.
 */
const SESSION_SEARCH_PATH = `${ROUTE_PREFIX}/session-search`
/** Session ids are the harness's own shape; anything else is refused before it reaches a path. */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
/** Largest deletion request body read; a real one carries one id. */
const DELETE_BODY_MAX = 4096

/**
 * Why a request to the username route must be refused, or undefined when it
 * may proceed.
 *
 * `webServer.register()` hands a plugin route raw requests: the host's own
 * `/api` sits behind a Host/Origin fence and the browser-session cookie, but
 * nothing puts a plugin route there, and this route reads the OS user. So it
 * borrows the host's own check, `connection.requestRejection()` — the fence and
 * authentication `/api` applies. The browser passes it with a same-origin
 * request that carries the session cookie; the desktop shell passes it because
 * it forwards to a loopback Host, drops the page's Origin and attaches the
 * cookie itself. A host without that service cannot authenticate anyone, so the
 * stand-in below serves loopback only: a loopback Host (which also defeats DNS
 * rebinding), no cross-site marker, and an Origin, when sent, naming that Host.
 *
 * @param ctx - host plugin context.
 * @param req - node request.
 * @returns 401 / 403, or undefined when the request may proceed.
 */
function refusalOf(ctx, req) {
  try {
    const connection = ctx.get('connection')
    if (typeof connection?.requestRejection === 'function') return connection.requestRejection(req)
  } catch { /* no connection service: the local fence below */ }
  const host = req.headers.host
  if (host !== undefined) {
    let name
    try {
      name = new URL(`http://${host}`).hostname
    } catch {
      return 403
    }
    if (name !== 'localhost' && name !== '[::1]' && !/^127\.\d+\.\d+\.\d+$/.test(name)) return 403
  }
  const site = req.headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return 403
  const origin = req.headers.origin
  if (origin === undefined) return undefined
  try {
    return new URL(origin).host === host ? undefined : 403
  } catch {
    return 403
  }
}

/** Send one JSON response. */
function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** The harness sessions root: `<DSH home>/sessions`, resolved the host's own way. */
function sessionsRoot(ctx) {
  try {
    const dshHomePath = ctx.get('dshHomePath')
    if (typeof dshHomePath === 'function') return dshHomePath('sessions')
  } catch { /* no home-path service: fall back to the environment */ }
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'sessions')
}

/**
 * Whether the host holds this session open right now.
 *
 * A live session's log is open and being appended to, so its directory must not
 * be removed under the writer. When the live set cannot be read, the answer is
 * "live": an unreadable set cannot authorize the deletion.
 */
function sessionIsLive(ctx, sessionId) {
  let sessions = null
  try {
    sessions = ctx.get('sessions')
  } catch {
    sessions = null
  }
  if (sessions === null || sessions === undefined) return false
  try {
    if (typeof sessions.get === 'function') {
      const found = sessions.get(sessionId)
      return found !== undefined && found !== null
    }
    if (typeof sessions.list === 'function') {
      const listed = sessions.list()
      if (Array.isArray(listed)) {
        return listed.some((item) => (typeof item === 'string' ? item : item?.id ?? item?.sessionId) === sessionId)
      }
    }
  } catch {
    return true
  }
  return true
}

/** One bounded request body, or null when it is oversized or unreadable. */
function readRequestBody(req, limit) {
  return new Promise((settle) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        settle(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => settle(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => settle(null))
  })
}

/**
 * Drop one id from the workspace registry's archive set, durably.
 *
 * The registry is read at request time: it mounts with the workspace domain and
 * can complete after this plugin. A host without one has no archive set to
 * update — and no archived list to delete from — while a failing unarchive
 * propagates: the route answers 500, the row stays, and the next delete
 * retries through the miss branch.
 */
async function unarchiveSession(ctx, sessionId) {
  const registry = ctx.get?.('workspaceRegistry')
  if (typeof registry?.unarchiveSession !== 'function') return
  await registry.unarchiveSession(sessionId)
}

/**
 * Delete one stored session: the directory named by the id under one of the
 * sessions root's working-directory directories, and the id's entry in the
 * workspace registry's archive set.
 *
 * The id never reaches a path unchecked — it must match the harness's own
 * shape, the lookup is by exact name, and the resolved directory must stay
 * inside the sessions root.
 *
 * The archive set can name a session whose stored directory is already gone —
 * an earlier removal took the directory while the registry entry stayed, and
 * the stale session summary keeps its row on the archived list. The miss
 * answers success too: the registry's unarchive runs no existence check and
 * resolves without writing for an id that is not archived, so the entry leaves
 * the set either way and the row is gone for good instead of coming back on
 * the next reload.
 */
async function deleteSession(ctx, req, res) {
  const refused = refusalOf(ctx, req)
  if (refused !== undefined) {
    sendJson(res, refused, { ok: false, error: refused === 401 ? 'unauthorized' : 'forbidden' })
    return
  }
  const raw = await readRequestBody(req, DELETE_BODY_MAX)
  let request = null
  try {
    request = raw === null ? null : JSON.parse(raw)
  } catch {
    request = null
  }
  const sessionId = request !== null && typeof request.sessionId === 'string' ? request.sessionId : ''
  if (!SESSION_ID_RE.test(sessionId)) {
    sendJson(res, 400, { ok: false, error: 'invalid session id' })
    return
  }
  if (sessionIsLive(ctx, sessionId)) {
    sendJson(res, 409, { ok: false, error: 'session is open' })
    return
  }
  const root = resolve(sessionsRoot(ctx))
  let dir = null
  // The root listing is the storage's own answer, so a failure there is a
  // fault and propagates to the route's 500 answer; a candidate that stats as
  // absent is the OS's "not under this entry" — the expected state the scan
  // moves past.
  for (const entry of readdirSync(root)) {
    const candidate = join(root, entry, sessionId)
    let stat
    try {
      stat = statSync(candidate)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      dir = candidate
      break
    }
  }
  if (dir === null) {
    await unarchiveSession(ctx, sessionId)
    sendJson(res, 200, { ok: true, ghost: true })
    return
  }
  if (!resolve(dir).startsWith(root + sep)) {
    sendJson(res, 403, { ok: false, error: 'session directory outside the sessions root' })
    return
  }
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch (error) {
    // A storage fault answers 500 with the OS error — nothing is swallowed.
    sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    return
  }
  await unarchiveSession(ctx, sessionId)
  sendJson(res, 200, { ok: true, ghost: false })
}

/**
 * Register the plugin's host routes.
 *
 * @param ctx - host plugin context.
 * @param scope - the inject scope that carries the `webServer` declaration, or
 *     `ctx` itself on a host whose context injects nothing.
 */
export function registerRoutes(ctx, scope) {
  const here = dirname(fileURLToPath(import.meta.url))
  // The copy document is build output beside the client bundle in lib/.
  const file = join(here, '..', 'lib', COPY_FILE)
  const fontsDir = join(here, '..', 'fonts')
  const deepyDir = join(here, '..', 'lib', 'deepy')
  const artworkDir = join(here, '..', 'assets')

  /**
   * Answer one request under the route prefix with a static file.
   * @param res - node response.
   * @param method - request method; HEAD sends headers only.
   * @param path - absolute file to read.
   * @param headers - content-type / cache-control pair for the payload.
   */
  const sendFile = (res, method, path, headers) => {
    let body
    try {
      // Read per request: the files are small, and an in-place edit then
      // shows up on reload without restarting the host.
      body = readFileSync(path)
    } catch {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, {
      ...headers,
      'content-length': String(body.byteLength),
    })
    res.end(method === 'HEAD' ? undefined : body)
  }

  /**
   * Answer one request for a character's artwork.
   *
   * The bytes are streamed rather than read into memory: a motion character is
   * a multi-megabyte video and the browser seeks inside it, so a Range request
   * is answered with 206.
   *
   * @param req - node request.
   * @param res - node response.
   * @param tail - the path under `${ROUTE_PREFIX}/artwork/`, still URL-encoded.
   */
  const sendArtwork = (req, res, tail) => {
    if (tail === ARTWORK_TABLE_FILE) {
      sendFile(res, req.method, join(artworkDir, ARTWORK_TABLE_FILE), {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-cache',
      })
      return
    }
    let decoded
    try {
      decoded = decodeURIComponent(tail)
    } catch {
      res.writeHead(400)
      res.end()
      return
    }
    const parts = decoded.split('/')
    const id = parts.shift()
    if (id === undefined || !ARTWORK_ID.test(id) || parts.length === 0) {
      res.writeHead(404)
      res.end()
      return
    }
    /* Every later segment is a file name inside that character's directory;
       one that is empty, or that could climb out of it, is refused here and
       the resolved path is checked against the directory again below. */
    if (parts.some((part) => !ARTWORK_SEGMENT.test(part))) {
      res.writeHead(404)
      res.end()
      return
    }
    const root = join(artworkDir, id)
    const path = join(root, ...parts)
    if (!path.startsWith(root + sep)) {
      res.writeHead(404)
      res.end()
      return
    }
    let stat
    try {
      stat = statSync(path)
    } catch {
      res.writeHead(404)
      res.end()
      return
    }
    if (!stat.isFile()) {
      res.writeHead(404)
      res.end()
      return
    }
    const headers = {
      'content-type': ARTWORK_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
      'accept-ranges': 'bytes',
      'cache-control': 'public, max-age=3600',
    }
    const range = req.headers?.range
    const match = typeof range === 'string' ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null
    if (match === null) {
      res.writeHead(200, { ...headers, 'content-length': String(stat.size) })
      if (req.method === 'HEAD') res.end()
      else createReadStream(path).pipe(res)
      return
    }
    let start = match[1] === '' ? 0 : Number.parseInt(match[1], 10)
    let end = match[2] === '' ? stat.size - 1 : Number.parseInt(match[2], 10)
    if (!Number.isFinite(start) || start < 0) start = 0
    if (!Number.isFinite(end) || end >= stat.size) end = stat.size - 1
    if (start > end) {
      res.writeHead(416, { 'content-range': `bytes */${stat.size}` })
      res.end()
      return
    }
    res.writeHead(206, {
      ...headers,
      'content-range': `bytes ${start}-${end}/${stat.size}`,
      'content-length': String(end - start + 1),
    })
    if (req.method === 'HEAD') res.end()
    else createReadStream(path, { start, end }).pipe(res)
  }

  scope.effect(() => {
    const disposers = []
    const warn = (message) => ctx.logger?.warn?.(`dsh-claude-painting: ${message}`)
    const usage = createUsage(ctx)
    const hdsl = createHdslAccount(ctx)
    const sessionSearch = createSessionSearch(ctx)

    try {
      disposers.push(scope.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { allow: 'GET, HEAD' })
            res.end()
            return
          }
          /* v8 ignore next -- node:http always sets url on server requests. */
          const sub = new URL(req.url ?? '/', 'http://x').pathname.slice(ROUTE_PREFIX.length)
          if (sub === `/${COPY_FILE}`) {
            sendFile(res, req.method, file, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-cache',
            })
            return
          }
          const font = sub.startsWith('/fonts/') ? FONT_FILES[sub.slice('/fonts/'.length)] : undefined
          if (font !== undefined) {
            // The filename changes with the package, so a long cache is safe
            // and keeps the code face off the network after first paint.
            sendFile(res, req.method, join(fontsDir, sub.slice('/fonts/'.length)), {
              'content-type': font,
              'cache-control': 'public, max-age=86400',
            })
            return
          }
          const sheet = sub.startsWith('/deepy/') ? sub.slice('/deepy/'.length) : ''
          if (DEEPY_FILE.test(sheet)) {
            sendFile(res, req.method, join(deepyDir, sheet), {
              'content-type': 'image/png',
              'cache-control': 'public, max-age=31536000, immutable',
            })
            return
          }
          if (sub.startsWith(ARTWORK_ROUTE)) {
            sendArtwork(req, res, sub.slice(ARTWORK_ROUTE.length))
            return
          }
          res.writeHead(404)
          res.end()
        },
      }))
    } catch (error) {
      warn(`model copy route unavailable: ${error?.message ?? error}`)
    }

    try {
      // One-shot OS user resolution for the browser half; it caches the
      // response and never polls. The exact route wins over the prefix above.
      disposers.push(scope.webServer.register({
        kind: 'exact',
        path: USERNAME_PATH,
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { allow: 'GET, HEAD' })
            res.end()
            return
          }
          const refused = refusalOf(ctx, req)
          if (refused !== undefined) {
            sendJson(res, refused, { ok: false, error: refused === 401 ? 'unauthorized' : 'forbidden' })
            return
          }
          let username = ''
          try {
            username = userInfo().username || ''
          } catch { /* no OS user: the browser falls back to 'User' */ }
          const body = Buffer.from(JSON.stringify({ ok: true, username }))
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': String(body.byteLength),
            'cache-control': 'no-cache',
          })
          res.end(req.method === 'HEAD' ? undefined : body)
        },
      }))
    } catch (error) {
      warn(`username route unavailable: ${error?.message ?? error}`)
    }

    try {
      // The HDSL launcher's account contract. Read-only, same-origin only, and
      // the player's avatar path is dropped here: the browser half needs a
      // picture, not the home directory it lives in.
      disposers.push(scope.webServer.register({
        kind: 'exact',
        path: HDSL_PATH,
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { allow: 'GET, HEAD' })
            res.end()
            return
          }
          const refused = refusalOf(ctx, req)
          if (refused !== undefined) {
            sendJson(res, refused, { ok: false, error: refused === 401 ? 'unauthorized' : 'forbidden' })
            return
          }
          hdsl.read().then((profile) => {
            const { skinFile, ...account } = profile
            sendJson(res, 200, { ok: true, ...account })
          }, (error) => {
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          })
        },
      }))
    } catch (error) {
      warn(`HDSL account route unavailable: ${error?.message ?? error}`)
    }

    try {
      // The player's own avatar. The path comes from the environment and never
      // from the request, so this route cannot be pointed anywhere; a missing
      // file is a 404 and the browser half falls back to the brand mark.
      disposers.push(scope.webServer.register({
        kind: 'exact',
        path: HDSL_SKIN_PATH,
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { allow: 'GET, HEAD' })
            res.end()
            return
          }
          const refused = refusalOf(ctx, req)
          if (refused !== undefined) {
            sendJson(res, refused, { ok: false, error: refused === 401 ? 'unauthorized' : 'forbidden' })
            return
          }
          hdsl.read().then((profile) => {
            let body = null
            if (profile.skinFile !== null) {
              try {
                body = readFileSync(profile.skinFile)
              } catch { /* the file was removed under the launcher */ }
            }
            if (body === null) {
              res.writeHead(404, { 'cache-control': 'no-store' })
              res.end()
              return
            }
            res.writeHead(200, {
              'content-type': 'image/png',
              'content-length': String(body.byteLength),
              'cache-control': 'no-cache',
            })
            res.end(req.method === 'HEAD' ? undefined : body)
          }, () => {
            res.writeHead(404, { 'cache-control': 'no-store' })
            res.end()
          })
        },
      }))
    } catch (error) {
      warn(`HDSL skin route unavailable: ${error?.message ?? error}`)
    }

    try {
      // The archived row's delete button. POST only: the browser half sends
      // one id, and a GET must never reach the filesystem.
      disposers.push(scope.webServer.register({
        kind: 'exact',
        path: SESSION_DELETE_PATH,
        handler: (req, res) => {
          if (req.method !== 'POST') {
            res.writeHead(405, { allow: 'POST' })
            res.end()
            return
          }
          void deleteSession(ctx, req, res).catch((error) => {
            try {
              sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
            } catch { /* the response may already be gone */ }
          })
        },
      }))
    } catch (error) {
      warn(`session delete route unavailable: ${error?.message ?? error}`)
    }

    try {
      // The home dashboard's day buckets. Read-only and same-origin only: the
      // answer is the plugin's own aggregate over the user's session history,
      // which is why it runs the same fence as the username route.
      disposers.push(scope.webServer.register({
        kind: 'exact',
        path: USAGE_PATH,
        handler: (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { allow: 'GET, HEAD' })
            res.end()
            return
          }
          const refused = refusalOf(ctx, req)
          if (refused !== undefined) {
            sendJson(res, refused, { ok: false, error: refused === 401 ? 'unauthorized' : 'forbidden' })
            return
          }
          let snapshot = usage.snapshot()
          const stale = snapshot.value === null
            || snapshot.computing === true
            || Date.now() - (snapshot.value?.computedAt ?? 0) > USAGE_TTL_MS
          if (stale) {
            void usage.refresh()
            snapshot = usage.snapshot()
          }
          sendJson(res, 200, {
            ok: true,
            value: snapshot.value,
            computing: snapshot.computing === true,
            ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
          })
        },
      }))
    } catch (error) {
      warn(`usage route unavailable: ${error?.message ?? error}`)
    }

    try {
      // The search palette's message hits. Read-only, behind the same fence
      // as the usage route: the answer quotes the user's own conversations.
      disposers.push(scope.webServer.register({
        kind: 'exact',
        path: SESSION_SEARCH_PATH,
        handler: (req, res) => {
          if (req.method !== 'GET') {
            res.writeHead(405, { allow: 'GET' })
            res.end()
            return
          }
          const refused = refusalOf(ctx, req)
          if (refused !== undefined) {
            sendJson(res, refused, { ok: false, error: refused === 401 ? 'unauthorized' : 'forbidden' })
            return
          }
          const query = (new URL(req.url ?? '/', 'http://local').searchParams.get('q') ?? '').trim().slice(0, QUERY_MAX)
          const answer = query === ''
            ? sessionSearch.warm().then(() => ({ sessions: [] }))
            : sessionSearch.search(query)
          void answer.then((value) => {
            sendJson(res, 200, { ok: true, ...value })
          }, (error) => {
            sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          })
        },
      }))
    } catch (error) {
      warn(`session search route unavailable: ${error?.message ?? error}`)
    }

    return () => {
      try {
        usage.dispose()
      } catch { /* the service may already be gone */ }
      for (const dispose of disposers) {
        try {
          dispose()
        } catch { /* the route may already be gone */ }
      }
    }
  }, 'dsh-claude-painting: host routes')
}
