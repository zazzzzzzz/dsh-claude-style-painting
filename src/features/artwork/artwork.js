    /**
     * The artwork layer: a standing character and the decorative line drawings
     * that belong to it, drawn behind the application frame.
     *
     * The layer is one fixed child of <body> at a negative z-index, so it
     * paints above the canvas and below everything the app draws; the
     * stylesheet makes the few surfaces that sit directly on the canvas
     * transparent while ARTWORK_ATTR is present. Where each node lands is
     * decided from the main content column's rectangle, written onto the layer
     * as four custom properties and re-read on every pass — the scheduler owns
     * every observer (D6), so this feature registers none of its own.
     *
     * The character table is data (D5), read from ARTWORK_TABLE_ROUTE: it names
     * each character's files, its aspect ratio and its three line colors.
     * Adding a character is a manifest entry beside its files in `assets/`,
     * which the host half serves under ARTWORK_ASSET_ROUTE.
     */
    function installArtwork(ctx, ui) {
        /**
         * The nodes, in paint order. `role` is the key the table uses for that
         * node's file; two nodes can share one file (the mirrored doodle) and
         * the character's file depends on the polarity.
         */
        const NODES = [
            { cls: 'dsh-claude-art-corner', role: 'corner' },
            { cls: 'dsh-claude-art-upper', role: 'upper' },
            { cls: 'dsh-claude-art-doodle', role: 'doodle' },
            { cls: 'dsh-claude-art-doodle-b', role: 'doodle' },
            { cls: 'dsh-claude-art-character', role: 'character' },
            { cls: 'dsh-claude-art-star-a', role: 'star' },
            { cls: 'dsh-claude-art-star-b', role: 'star' },
            { cls: 'dsh-claude-art-candy-wrapped', role: 'candyWrapped' },
            { cls: 'dsh-claude-art-candy-lollipop', role: 'candyLollipop' },
            { cls: 'dsh-claude-art-acao-heart', role: 'acaoHeart' },
            { cls: 'dsh-claude-art-acao-cheer', role: 'acaoCheer' },
        ]

        /** The table the host half serves; empty until the fetch lands. */
        let table = []
        /** The layer on screen, or null while the preference is off. */
        let layer = null
        /** The table entry the layer draws; the identity that decides a rebuild. */
        let applied = null
        /** The motion character's video, while one is mounted. */
        let video = null

        /**
         * `characterDark` reads as `--dsh-claude-art-img-character-dark`.
         * Custom property names are case-sensitive, so a role key has to be
         * folded into the name the stylesheet reads.
         */
        function kebab(name) {
            return name.replace(/[A-Z]/g, (ch) => '-' + ch.toLowerCase())
        }

        /**
         * The main content column: the rectangle the artwork is laid out
         * against. The renderer's slot anchor is the contract; the conversation
         * pane is the selector this skin already styles the column through, and
         * it stays the column when a shell renders no slot wrapper around it.
         */
        function mainColumn() {
            const slot = document.querySelector('[data-slot="main"]')
            if (slot && slot.parentElement) return slot.parentElement
            const pane = document.querySelector('[data-pane="conversation"]')
            if (pane) return pane
            const overlay = document.querySelector('#root [data-shell-overlay]')
            return overlay ? overlay.parentElement : null
        }

        /**
         * One character's layer: every file it names becomes a CSS variable the
         * stylesheet draws a node from, its line colors the three inks the
         * drawings are masked with.
         */
        function buildLayer(theme) {
            const el = document.createElement('div')
            el.id = ARTWORK_LAYER_ID
            el.setAttribute('aria-hidden', 'true')
            for (const [role, file] of Object.entries(theme.assets)) {
                if (role === 'characterMotion') continue
                el.style.setProperty('--dsh-claude-art-img-' + kebab(role), `url("${ARTWORK_ASSET_ROUTE}${file}")`)
            }
            if (theme.ink && typeof theme.ink === 'object') {
                for (const [name, value] of Object.entries(theme.ink)) {
                    if (typeof value !== 'string' || value === '') continue
                    el.style.setProperty('--dsh-claude-art-' + kebab(name), value)
                }
            }
            if (typeof theme.aspect === 'number' && theme.aspect > 0) {
                el.style.setProperty('--dsh-claude-art-aspect', String(theme.aspect))
            }
            const motion = typeof theme.assets.characterMotion === 'string' && theme.assets.characterMotion !== ''
            for (const node of NODES) {
                if (node.role === 'character' && motion) {
                    el.appendChild(characterVideo(theme))
                    continue
                }
                const span = document.createElement('span')
                span.className = 'dsh-claude-art-node ' + node.cls
                el.appendChild(span)
            }
            return el
        }

        /**
         * The motion character: a looping video over its own still frame. The
         * still stays the poster, so a browser that cannot decode the video, or
         * a reader whose preference holds animation still, still sees the
         * character.
         */
        function characterVideo(theme) {
            const wrapper = document.createElement('div')
            wrapper.className = 'dsh-claude-art-node dsh-claude-art-character dsh-claude-art-motion'
            const element = document.createElement('video')
            element.muted = true
            element.loop = true
            element.autoplay = true
            element.playsInline = true
            element.setAttribute('muted', '')
            element.setAttribute('playsinline', '')
            element.preload = 'auto'
            if (typeof theme.assets.characterDark === 'string') {
                element.poster = ARTWORK_ASSET_ROUTE + theme.assets.characterDark
            }
            element.src = ARTWORK_ASSET_ROUTE + theme.assets.characterMotion
            wrapper.appendChild(element)
            video = element
            return wrapper
        }

        /** The entry the preference names, or null while the preference is off. */
        function wantedTheme() {
            const id = readPrefs().artwork
            if (typeof id !== 'string' || id === '') return null
            for (let i = 0; i < table.length; i++) {
                if (table[i].id === id) return table[i]
            }
            return null
        }

        /** Take the layer down and hand the canvas back. */
        function detach() {
            if (layer === null) return
            if (video !== null) {
                video.pause()
                video.removeAttribute('src')
                video.load()
                video = null
            }
            if (layer.parentElement) layer.parentElement.removeChild(layer)
            layer = null
            applied = null
            document.body.removeAttribute(ARTWORK_ATTR)
            document.body.removeAttribute(ARTWORK_NARROW_ATTR)
            clearPalette()
        }

        function attach(theme) {
            const el = buildLayer(theme)
            document.body.appendChild(el)
            layer = el
            applied = theme
            document.body.setAttribute(ARTWORK_ATTR, theme.id)
            writePalette(theme)
        }

        /* ---- the character's own palette ---- */

        /** `#rgb` / `#rrggbb` to channels; null when the value is not a colour. */
        function parseHex(hex) {
            const value = String(hex).trim().replace(/^#/, '')
            const full = value.length === 3 ? value.split('').map((ch) => ch + ch).join('') : value
            if (!/^[0-9a-f]{6}$/i.test(full)) return null
            return { r: parseInt(full.slice(0, 2), 16), g: parseInt(full.slice(2, 4), 16), b: parseInt(full.slice(4, 6), 16) }
        }

        /** The same colour at an opacity, as `rgb(r g b / a)`. */
        function withAlpha(hex, alpha) {
            const rgb = parseHex(hex)
            if (rgb === null) return hex
            return `rgb(${rgb.r} ${rgb.g} ${rgb.b} / ${alpha})`
        }

        /** A colour moved towards white (positive) or black (negative). */
        function shift(hex, amount) {
            const rgb = parseHex(hex)
            if (rgb === null) return hex
            const move = (channel) => (amount >= 0
                ? Math.round(channel + (255 - channel) * amount)
                : Math.round(channel * (1 + amount)))
            return '#' + [move(rgb.r), move(rgb.g), move(rgb.b)].map((c) => c.toString(16).padStart(2, '0')).join('')
        }

        /** Two colours blended, `t` towards `b`. */
        function mixHex(a, b, t) {
            const ca = parseHex(a)
            const cb = parseHex(b)
            if (ca === null || cb === null) return a
            const mix = (x, y) => Math.round(x + (y - x) * t)
            return '#' + [mix(ca.r, cb.r), mix(ca.g, cb.g), mix(ca.b, cb.b)].map((c) => c.toString(16).padStart(2, '0')).join('')
        }

        /** Black or near-white, whichever reads on the given fill. */
        function readableOn(background) {
            const rgb = parseHex(background)
            if (rgb === null) return '#ffffff'
            const luminance = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255
            return luminance > 0.55 ? '#1a1114' : '#fbf8f6'
        }

        /**
         * The page tokens a character repaints, one value per polarity.
         *
         * The stylesheet decides which polarity applies and maps these onto the
         * tokens the skin paints with (`--dsh-claude-*`) and the ones it hands
         * to the host (`--dsw-alias-*`), so this half only states the colours
         * the table carries, once per character.
         */
        function paletteVars(theme) {
            const dark = theme.palette && theme.palette.dark ? theme.palette.dark : null
            const light = theme.palette && theme.palette.light ? theme.palette.light : null
            if (dark === null || light === null) return {}
            const out = {}
            const set = (name, darkValue, lightValue) => {
                out['--dsh-claude-art-' + name + '-dark'] = darkValue
                out['--dsh-claude-art-' + name + '-light'] = lightValue
            }
            set('canvas', dark.surface, light.surface)
            set('sidebar', dark.sidebar, light.sidebar)
            set('panel', dark.panel, light.panel)
            set('raised', dark.panelStrong, light.panelStrong)
            set('layer-3', shift(dark.panelStrong, 0.04), shift(light.panelStrong, 0.02))
            set('ink', dark.ink, light.ink)
            set('muted', dark.muted, light.muted)
            set('tertiary', withAlpha(dark.muted, 0.68), withAlpha(light.muted, 0.78))
            set('accent', dark.accent, light.accent)
            set('accent-soft', dark.accentSoft, light.accentSoft)
            set('accent-hover', shift(dark.accent, 0.12), shift(light.accent, -0.08))
            set('on-accent', readableOn(dark.accent), readableOn(light.accent))
            set('border', dark.border, light.border)
            set('border-2', withAlpha(dark.accent, 0.22), withAlpha(light.accent, 0.38))
            set('border-3', withAlpha(dark.accent, 0.32), withAlpha(light.accent, 0.5))
            set('hover', withAlpha(dark.accent, 0.08), withAlpha(light.accent, 0.07))
            set('hover-strong', withAlpha(dark.accent, 0.16), withAlpha(light.accent, 0.14))
            set('input', withAlpha(mixHex(dark.panelStrong, dark.accent, 0.08), 0.95), withAlpha(mixHex(light.panelStrong, light.accent, 0.05), 0.96))
            set('scrollbar', withAlpha(dark.accent, 0.26), withAlpha(light.accent, 0.28))
            return out
        }

        /** The palette variables currently written on the document, if any. */
        let paletteWritten = []

        /**
         * Hand one character's palette to the stylesheet.
         *
         * The values go on the document element rather than the body: the
         * canvas is painted by <html>, which cannot read the body's custom
         * properties, and everything below inherits them from there anyway.
         */
        function writePalette(theme) {
            const vars = paletteVars(theme)
            paletteWritten = Object.keys(vars)
            if (paletteWritten.length === 0) return
            for (const name of paletteWritten) document.documentElement.style.setProperty(name, vars[name])
            /* The marker keeps the stylesheet's mapping off a character that
               brought no palette: an empty custom property would leave the
               tokens it maps to unset. */
            document.body.setAttribute(ARTWORK_PALETTE_ATTR, '')
        }

        /** Take the palette back off the document. */
        function clearPalette() {
            for (let i = 0; i < paletteWritten.length; i++) document.documentElement.style.removeProperty(paletteWritten[i])
            paletteWritten = []
            document.body.removeAttribute(ARTWORK_PALETTE_ATTR)
        }

        /** The geometry last written, so a repeated reading writes nothing. */
        let geometry = ''

        /**
         * Lay the layer on the main content column.
         *
         * Called from the pass and from the scheduler's viewport repositioning:
         * a window resize moves the column without mutating the document inside
         * the observer's filter, and the scheduler answers that with
         * `reposition('viewport')` rather than a pass — without this hook the
         * layer kept the geometry of the previous window size and the character
         * drifted towards the window edge.
         */
        function measure() {
            const column = mainColumn()
            const rect = column === null ? null : column.getBoundingClientRect()
            if (rect === null || rect.width < 40 || rect.height < 40) {
                if (layer !== null) layer.setAttribute('data-dsh-claude-art-hidden', '')
                if (video !== null && !video.paused) video.pause()
                return
            }
            const next = [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)].join(',')
            if (next !== geometry) {
                geometry = next
                layer.style.setProperty('--dsh-claude-art-wl', Math.round(rect.left) + 'px')
                layer.style.setProperty('--dsh-claude-art-wt', Math.round(rect.top) + 'px')
                layer.style.setProperty('--dsh-claude-art-ww', Math.round(rect.width) + 'px')
                layer.style.setProperty('--dsh-claude-art-wh', Math.round(rect.height) + 'px')
            }
            layer.removeAttribute('data-dsh-claude-art-hidden')
            if (rect.width < ARTWORK_NARROW_WIDTH) document.body.setAttribute(ARTWORK_NARROW_ATTR, '')
            else document.body.removeAttribute(ARTWORK_NARROW_ATTR)
        }

        /**
         * One pass: keep the layer on the character the preference names, and
         * keep its geometry on the main column. The video follows the reader's
         * animation choice (D26) — every other part of the layer is still.
         */
        function sync() {
            const theme = wantedTheme()
            if (theme === null) {
                detach()
                return
            }
            if (theme !== applied) {
                detach()
                attach(theme)
            }
            measure()
            if (video === null) return
            if (motionReduced()) {
                if (!video.paused) video.pause()
                return
            }
            if (video.paused) {
                const playing = video.play()
                // A browser that refuses playback leaves the poster frame up;
                // the character is still on screen, so this is not a failure.
                if (playing) playing.catch(() => {})
            }
        }

        /**
         * Read the table once. A package without an `assets/` directory answers
         * 404, which is a skin without artwork rather than a fault: the layer
         * stays off and the rest of the skin is untouched.
         */
        function loadTable() {
            fetch(ARTWORK_TABLE_ROUTE, { cache: 'no-store' })
                .then((response) => (response.ok ? response.json() : null))
                .then((data) => {
                    if (data === null || !Array.isArray(data.themes)) return
                    const usable = []
                    for (const entry of data.themes) {
                        if (typeof entry?.id !== 'string' || entry.id === '') continue
                        if (!entry.assets || typeof entry.assets !== 'object') continue
                        usable.push(entry)
                    }
                    table = usable
                    if (typeof ui.schedule === 'function') ui.schedule()
                })
                .catch((error) => {
                    console.warn('[dsh-claude-painting] the artwork table did not load:', error)
                })
        }

        ui.artwork = {
            /** The characters the manifest offers, for the settings page. */
            themes() {
                return table
            },
            sync,
            /** A window resize or a page scroll: re-read the column's rectangle. */
            reposition() {
                if (layer !== null) measure()
            },
        }

        loadTable()

        return () => {
            detach()
        }
    }
