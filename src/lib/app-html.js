/**
 * Kernel-agnostic app-preview HTML builder + iframe bootloader.
 *
 * Builds the self-contained HTML document (with console interceptor,
 * asset/import rewriting, storage shim, and plotly preloading) that is
 * injected into the app-preview iframe. Shared by both the Pyodide (py)
 * and TypeScript (ts) kernels — it does not reference any worker-side
 * module state.
 */

import _iframeBridgeSource from './iframe-bridge.js?raw';
import {
    buildAssetsScript,
    buildAssetUrlMap,
    rewriteCssAssetRefs,
    rewriteHtmlAssetRefs,
} from './app-assets.js';

const CONSOLE_INTERCEPTOR = `
<script>
(function() {
    window.__agex_logs = [];
    var _origLog = console.log, _origWarn = console.warn, _origErr = console.error;
    // Per-message cap. Mirrors MAX_VALUE_BYTES in iframe-bridge.js:
    // an in-iframe console.log(bigObject) would otherwise flow into
    // testApp's collected logs and from there into the agent's
    // next-turn context. 50 KB per log entry stays generous for
    // useful debugging output while preventing single-log context
    // blowups.
    var MAX_LOG_BYTES = 50000;
    function capture(level, args) {
        var msg = Array.prototype.map.call(args, function(a) {
            try { return typeof a === 'object' ? JSON.stringify(a) : String(a); }
            catch(e) { return String(a); }
        }).join(' ');
        if (msg.length > MAX_LOG_BYTES) {
            msg = '[truncated: log was ' + msg.length + ' bytes (cap ' +
                MAX_LOG_BYTES + '). First ' + MAX_LOG_BYTES + ' bytes: ' +
                msg.slice(0, MAX_LOG_BYTES) + ']';
        }
        window.__agex_logs.push({ level: level, message: msg });
    }
    console.log = function() { capture('log', arguments); _origLog.apply(console, arguments); };
    console.warn = function() { capture('warn', arguments); _origWarn.apply(console, arguments); };
    console.error = function() { capture('error', arguments); _origErr.apply(console, arguments); };
    window.onerror = function(msg, src, line, col, err) {
        window.__agex_logs.push({ level: 'error', message: msg + (err && err.stack ? '\\n' + err.stack : '') });
    };
    window.addEventListener('unhandledrejection', function(e) {
        var msg = e.reason ? (e.reason.message || String(e.reason)) : 'Unhandled promise rejection';
        window.__agex_logs.push({ level: 'error', message: msg });
    });

    // Capture resource-load errors (img / script / link / etc.)
    // and surface them two ways:
    //   1. Push to __agex_logs so testApp's collected logs include
    //      them — without this the agent sees only the visual symptom
    //      (page renders unstyled / image broken) and has to guess
    //      what 404'd. Agent-reported gap.
    //   2. Forward to parent for live-preview console diagnostics
    //      (see AppPreview.svelte's listener).
    // Resource-load errors don't bubble to window.onerror, so the
    // capture-phase listener is the only way to see them.
    window.addEventListener('error', function(ev) {
        var el = ev.target;
        if (!el || el === window) return;  // uncaught JS errors handled above
        try {
            var tag = el.tagName ? el.tagName.toLowerCase() : '?';
            var url = el.src || el.href || el.data || '';
            var attr = el.src ? 'src' : (el.href ? 'href' : 'data');
            var logMsg = '[resource load failed] <' + tag + ' ' + attr + '="' + String(url) + '"> failed to load';
            window.__agex_logs.push({ level: 'error', message: logMsg });
            window.parent.postMessage({
                type: 'agex-iframe-resource-error',
                tag: tag,
                attr: attr,
                url: String(url),
                outerHTML: (el.outerHTML || '').slice(0, 200),
            }, window.__AGEX_PARENT_ORIGIN || '*');
        } catch (_) { /* swallow */ }
    }, true);  // capture phase — resource errors don't bubble
})();
<\/script>`;

const QUERY_BRIDGE_SCRIPT = `
<script>
window.query = function(opts) {
    if (typeof opts === 'string') opts = { code: opts };
    var id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    return new Promise(function(resolve, reject) {
        function handler(event) {
            if (event.data && event.data.type === 'agex-query-result' && event.data.id === id) {
                window.removeEventListener('message', handler);
                if (event.data.error) reject(new Error(event.data.error));
                else resolve(event.data.data);
            }
        }
        window.addEventListener('message', handler);
        window.parent.postMessage({
            type: 'agex-query',
            id: id,
            code: opts.code,
            result: opts.result || null,
        }, window.__AGEX_PARENT_ORIGIN || '*');
    });
};

// getCacheValue(key) — read a value the agent stashed via cache.set(key, value).
// Lighter-weight than query(): no code execution, just a cache lookup.
// The agent must have called cache.set on the key before the app reads it.
window.getCacheValue = function(key) {
    var id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    return new Promise(function(resolve, reject) {
        function handler(event) {
            if (event.data && event.data.type === 'agex-cache-get-result' && event.data.id === id) {
                window.removeEventListener('message', handler);
                if (event.data.error) reject(new Error(event.data.error));
                else resolve(event.data.data);
            }
        }
        window.addEventListener('message', handler);
        window.parent.postMessage({
            type: 'agex-cache-get',
            id: id,
            key: key,
        }, window.__AGEX_PARENT_ORIGIN || '*');
    });
};

// spawn(spec, opts?) — run an LLM sub-task on the host: an ephemeral
// clone of the agent fulfils the spec (a SpawnSpec: task, input?,
// output?, primer?, ...) and returns its result. The spec lives inline
// here in your app code — there's no pre-registration. The full LLM
// round-trip happens host-side; this is just the transport. ALWAYS wrap
// in try/catch — a sub-task that fails or is cancelled rejects here, and
// an unhandled rejection means the user clicks a button and nothing
// visibly happens. Pass an opts.signal (AbortSignal) for user-driven
// cancel (e.g. a "Stop thinking" button); aborting posts a cancel to
// the host and rejects with an AbortError.
// NOTE: this whole block is inside a template literal — no backticks.
window.spawn = function(spec, opts) {
    var id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    var signal = opts && opts.signal;
    return new Promise(function(resolve, reject) {
        function cleanup() {
            window.removeEventListener('message', handler);
            if (signal) signal.removeEventListener('abort', onAbort);
        }
        function handler(event) {
            if (!event.data || event.data.id !== id) return;
            if (event.data.type === 'agex-spawn-result') {
                cleanup();
                resolve(event.data.data);
            } else if (event.data.type === 'agex-spawn-error') {
                cleanup();
                reject(new Error(event.data.error || 'spawn failed'));
            }
        }
        function onAbort() {
            cleanup();
            window.parent.postMessage(
                { type: 'agex-cancel-spawn', id: id },
                window.__AGEX_PARENT_ORIGIN || '*'
            );
            reject(new DOMException('Aborted', 'AbortError'));
        }
        if (signal && signal.aborted) { onAbort(); return; }
        window.addEventListener('message', handler);
        if (signal) signal.addEventListener('abort', onAbort);
        window.parent.postMessage({
            type: 'agex-spawn',
            id: id,
            spec: spec === undefined ? null : spec,
        }, window.__AGEX_PARENT_ORIGIN || '*');
    });
};

// notify(title, body?) — show a desktop notification via the host.
// The sandbox can't construct Notifications (or prompt for permission)
// itself, so the studio does it on your behalf, behind a permission
// prompt (first use) and a per-session rate cap. Resolves to true when
// a notification was shown, false otherwise (permission not granted,
// rate-limited, unsupported) — it NEVER rejects, so a denied permission
// won't throw; check the boolean and fall back to in-page UI. Accepts
// either notify('Title', 'Body') or notify({ title, body }). Clicking
// the notification focuses the studio tab and switches to this session.
// NOTE: this whole block is inside a template literal — no backticks.
window.notify = function(title, body) {
    var opts = (title && typeof title === 'object') ? title : { title: title, body: body };
    var id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    return new Promise(function(resolve) {
        function handler(event) {
            if (!event.data || event.data.type !== 'agex-notify-result' || event.data.id !== id) return;
            window.removeEventListener('message', handler);
            resolve(!!event.data.shown);
        }
        window.addEventListener('message', handler);
        window.parent.postMessage({
            type: 'agex-notify',
            id: id,
            title: opts.title == null ? '' : String(opts.title),
            body: opts.body == null ? '' : String(opts.body),
        }, window.__AGEX_PARENT_ORIGIN || '*');
    });
};
<\/script>`;

/**
 * Build the localStorage/sessionStorage/indexedDB shim script tag,
 * with the branch's current app-storage dict baked into the HTML so
 * the shim is synchronously seeded before app modules execute.
 *
 * `writeable=true` makes the shim post `agex-app-storage` messages on
 * every mutation; the parent debounces and persists them. Pass
 * `false` for ephemeral iframes (e.g. test_app) that shouldn't write
 * back to the session.
 *
 * @param {{ seed?: Record<string,string>, writeable?: boolean }} [opts]
 * @returns {string}
 */
// Exported so pyodide.test.js can verify the shim's seed encoding,
// quota, and writeable=false read-only path. Otherwise internal —
// callers should go through buildAppHtml.
export function buildAppStorageShim(opts = {}) {
    const seed = opts.seed || {};
    const writeable = opts.writeable !== false;
    // JSON.stringify is safe inside a script tag as long as we escape
    // the "</" sequence that would otherwise close the element.
    const seedJson = JSON.stringify(seed).replace(/<\/script/gi, '<\\/script');
    return `
<script>
(function() {
    var __seed = ${seedJson};
    var __writeable = ${writeable};
    var QUOTA = 5 * 1024 * 1024;

    function buildStore(persist, seed) {
        var data = Object.assign({}, seed || {});
        function size() {
            try { return JSON.stringify(data).length; } catch (e) { return 0; }
        }
        function notify() {
            if (!persist || !__writeable) return;
            try {
                window.parent.postMessage({
                    type: 'agex-app-storage',
                    data: JSON.parse(JSON.stringify(data)),
                }, window.__AGEX_PARENT_ORIGIN || '*');
            } catch (e) { /* parent gone — swallow */ }
        }
        return {
            get length() { return Object.keys(data).length; },
            key: function(i) {
                var k = Object.keys(data);
                return i >= 0 && i < k.length ? k[i] : null;
            },
            getItem: function(k) {
                var s = String(k);
                return Object.prototype.hasOwnProperty.call(data, s) ? data[s] : null;
            },
            setItem: function(k, v) {
                var sk = String(k), sv = String(v);
                var had = Object.prototype.hasOwnProperty.call(data, sk);
                var prev = data[sk];
                data[sk] = sv;
                if (size() > QUOTA) {
                    if (had) data[sk] = prev; else delete data[sk];
                    var err = new Error('app storage quota exceeded (' + QUOTA + ' bytes)');
                    err.name = 'QuotaExceededError';
                    throw err;
                }
                notify();
            },
            removeItem: function(k) {
                var sk = String(k);
                if (Object.prototype.hasOwnProperty.call(data, sk)) {
                    delete data[sk];
                    notify();
                }
            },
            clear: function() {
                if (Object.keys(data).length === 0) return;
                data = {};
                notify();
            },
        };
    }

    function install(name, store) {
        try {
            Object.defineProperty(window, name, {
                value: store, configurable: true, writable: false, enumerable: true,
            });
        } catch (e) {
            try { window[name] = store; } catch (_) { /* give up */ }
        }
    }

    install('localStorage', buildStore(true, __seed));
    install('sessionStorage', buildStore(false, {}));

    // IndexedDB is not supported inside agex artifacts. Stub every
    // access with a clear error so agents see the contract violation
    // immediately rather than debugging a silent no-op.
    var idbErr = function() {
        throw new Error('IndexedDB is not supported in agex artifacts — use localStorage instead');
    };
    var idbStub = new Proxy(function() { idbErr(); }, {
        get: function() { return idbErr; },
        apply: idbErr,
        construct: idbErr,
    });
    install('indexedDB', idbStub);
})();
<\/script>`;
}

// Agent control bridge — receives postMessage action commands from the
// parent (click/type/read/eval/screenshot/get-logs) and dispatches them
// against the iframe's own DOM. Required so executeActions/collectResults
// work when the iframe has an opaque origin (sandbox without
// allow-same-origin). The dispatch logic lives in ./iframe-bridge.js;
// this is just the inline-module shim that imports it by text and wires
// to the iframe's window.
const AGENT_CONTROL_BRIDGE_SCRIPT = `
<script type="module">
${_iframeBridgeSource}
installControlBridge(window);
// Signal the parent that the iframe is past document parse and the
// control bridge is installed. Used by app-control.js's runTestApp
// as the post-render readiness signal — the 'load' event on the
// iframe element doesn't fire after the bootloader's document.write
// replaces the document, so we need an in-doc signal instead. Module
// scripts run after the document parses, so by the time this runs
// the app's other scripts have also had a chance to start.
window.parent.postMessage(
    { type: 'agex-bridge-ready' },
    window.__AGEX_PARENT_ORIGIN || '*'
);
<\/script>`;

const CDN_IMPORTS = {
    "preact": "https://esm.sh/preact@10.25.4",
    "preact/": "https://esm.sh/preact@10.25.4/",
    // htm: JSX-like template literals without a build step. Tiny
    // (~3KB) and the standard "JSX without esbuild" companion to
    // preact. Used by the TS-side interactive-app skill since esbuild
    // isn't yet wired on that kernel.
    "htm": "https://esm.sh/htm@3.1.1",
    // Alias 'react' → preact/compat so agent code that writes
    // idiomatic React (`import { useState } from 'react'`) runs on
    // the lighter Preact runtime.  Most React component libraries
    // (radix, recharts, react-aria, etc.) work transparently this way.
    //
    // Note the per-subpath split: 'react-dom/client' (the React-18
    // root API exposing createRoot) maps to 'preact/compat/client',
    // a separate Preact bundle.  Pointing it at plain 'preact/compat'
    // produces a "no export named 'createRoot'" failure at runtime.
    "react": "https://esm.sh/preact@10.25.4/compat",
    "react-dom": "https://esm.sh/preact@10.25.4/compat",
    "react-dom/client": "https://esm.sh/preact@10.25.4/compat/client",
    "react/jsx-runtime": "https://esm.sh/preact@10.25.4/jsx-runtime",
    "marked": "https://esm.sh/marked@17.0.4",
    "dayjs": "https://esm.sh/dayjs@1.11.20",
    "dayjs/": "https://esm.sh/dayjs@1.11.20/",
    "dompurify": "https://esm.sh/dompurify@3.3.3",
};

const PLOTLY_URL = "https://cdn.plot.ly/plotly-2.35.2.min.js";
const PLOTLY_SCRIPT_FALLBACK = `<script src="${PLOTLY_URL}"><\/script>`;

// Sandboxed iframes have an opaque origin — Chrome's HTTP cache
// partitions by origin, so every session switch re-downloads Plotly.js
// from the CDN (3–4s on a slow connection). Fetch it once on the
// parent origin (which caches normally) and hand each iframe a `data:`
// URL pointing at the bytes. blob URLs won't work here — opaque-origin
// iframes can't access parent-origin blobs. data URLs are embedded,
// so they sidestep both the HTTP cache partitioning *and* the
// cross-origin blob restriction, and there's no `</script>` escaping
// hazard (the content is base64-encoded).
let _plotlyDataUrl = null;
let _plotlyPreloadPromise = null;

/**
 * Kick off a background fetch of Plotly.js. Safe to call multiple times
 * (second call reuses the in-flight promise). Called early from the
 * app shell so the script is ready by the time the first iframe builds.
 */
export function preloadPlotly() {
    if (_plotlyDataUrl) return Promise.resolve();
    if (_plotlyPreloadPromise) return _plotlyPreloadPromise;
    _plotlyPreloadPromise = fetch(PLOTLY_URL)
        .then((r) => {
            if (!r.ok) throw new Error(`Plotly fetch ${r.status}`);
            return r.blob();
        })
        .then((blob) => new Promise((resolve, reject) => {
            // FileReader.readAsDataURL is the fast path — native
            // base64 encode, no stack overflow on 3MB like
            // String.fromCharCode(...bytes) would have.
            const fr = new FileReader();
            fr.onload = () => {
                _plotlyDataUrl = /** @type {string} */ (fr.result);
                resolve();
            };
            fr.onerror = () => reject(fr.error);
            fr.readAsDataURL(blob);
        }))
        .catch((e) => {
            console.warn("[plotly] preload failed; falling back to <script src>", e);
            _plotlyDataUrl = null;
            // Drop the cached (failed) promise so a later call retries the
            // preload instead of re-returning the failed attempt.
            _plotlyPreloadPromise = null;
        });
    return _plotlyPreloadPromise;
}

/** Serve plotly via a data URL if preload succeeded; otherwise fall
 *  back to the CDN URL directly. */
function _plotlyScriptTag() {
    if (_plotlyDataUrl) {
        return `<script src="${_plotlyDataUrl}"><\/script>`;
    }
    return PLOTLY_SCRIPT_FALLBACK;
}

/** Prefix used for bare specifiers in the import map for local app files. */
const APP_MODULE_PREFIX = '__app/';

/**
 * Is this an npm-style bare specifier (vs a relative path, absolute
 * URL, data URL, or app-local prefix)?
 *
 * @param {string} spec
 * @returns {boolean}
 */
function _isBareSpecifier(spec) {
    if (!spec) return false;
    if (spec.startsWith('.')) return false;
    if (spec.startsWith('/')) return false;
    if (spec.startsWith(APP_MODULE_PREFIX)) return false;
    if (spec.includes('://')) return false;
    if (spec.startsWith('data:')) return false;
    return true;
}

/**
 * Reduce a bare specifier to its package root.
 *
 *   'recharts'                      → 'recharts'
 *   'recharts/lib/Cell'             → 'recharts'
 *   '@radix-ui/react-dialog'        → '@radix-ui/react-dialog'
 *   '@radix-ui/react-dialog/dist/x' → '@radix-ui/react-dialog'
 *   'recharts@2.10.0'               → 'recharts@2.10.0' (esm.sh accepts versioned URL fragments)
 *
 * @param {string} spec
 * @returns {string}
 */
function _packageRoot(spec) {
    if (spec.startsWith('@')) {
        const parts = spec.split('/');
        return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : spec;
    }
    const slash = spec.indexOf('/');
    return slash === -1 ? spec : spec.slice(0, slash);
}

/**
 * Scan JS source for bare module specifiers. Catches static
 * `import ... from 'pkg'` / `import 'pkg'` / `export ... from 'pkg'`
 * and dynamic `import('pkg')`. Returns a Set of unique package roots
 * (sub-paths collapsed). Best-effort regex — false positives (e.g.
 * `from 'foo'` text inside a string literal or comment) just produce
 * unused import-map entries, which are harmless.
 *
 * @param {string} source
 * @returns {Set<string>}
 */
function _extractBareImports(source) {
    const out = new Set();
    // Static `import ... from 'spec'` / `import 'spec'` / `export ... from 'spec'`.
    // The leading `[^\w$]` prevents matching mid-identifier (e.g. `_import`).
    const staticRe =
        /(?:^|[^\w$])(?:import|export)(?:\s*[\w*{},$\s]*?\s*from)?\s*['"]([^'"]+)['"]/g;
    const dynamicRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    for (const re of [staticRe, dynamicRe]) {
        let m;
        while ((m = re.exec(source)) !== null) {
            const spec = m[1];
            if (_isBareSpecifier(spec)) out.add(_packageRoot(spec));
        }
    }
    return out;
}

/**
 * Escape a string for use in a RegExp.
 * @param {string} s
 */
function _escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Resolve a relative import path against the importing file's directory.
 * "./constants.js" from "game/logic.js" → "game/constants.js"
 * "./utils/helpers.js" from "App.js" → "utils/helpers.js"
 *
 * @param {string} specifier - the relative path (after stripping "./")
 * @param {string} baseDir - directory of the importing file (e.g. "game/")
 * @returns {string} resolved relative path
 */
function _resolveRelative(specifier, baseDir) {
    if (!baseDir) return specifier;
    const parts = (baseDir + specifier).split('/');
    const resolved = [];
    for (const p of parts) {
        if (p === '..') resolved.pop();
        else if (p && p !== '.') resolved.push(p);
    }
    return resolved.join('/');
}

/**
 * Rewrite local relative import/export specifiers in JS code to use bare
 * prefixed specifiers that resolve via the import map.
 *
 * ./foo.js  → __app/foo.js
 * ./components/Bar.js → __app/components/Bar.js
 *
 * Only rewrites specifiers whose target file exists in knownFiles.
 * When baseDir is provided, relative paths are resolved against it
 * (e.g. "./constants.js" from "game/" resolves to "game/constants.js").
 *
 * @param {string} code - JS source code
 * @param {Set<string>} knownFiles - set of relative paths (e.g. "App.js", "utils/helpers.js")
 * @param {string} [baseDir=''] - directory of the importing file
 * @returns {string} rewritten code
 */
export function _rewriteLocalImports(code, knownFiles, baseDir = '') {
    // Helper: try to resolve a specifier and return the knownFiles key, or null
    function resolve(specifier) {
        // Relative paths (./foo.js, ../foo.js, ../../foo.js) — resolved
        // against baseDir.  _resolveRelative handles `..` segment traversal.
        if (specifier.startsWith('./') || specifier.startsWith('../')) {
            const relPath = specifier.startsWith('./') ? specifier.slice(2) : specifier;
            const resolved = _resolveRelative(relPath, baseDir);
            return knownFiles.has(resolved) ? resolved : null;
        }
        // /app/foo.js — absolute path agents sometimes use
        if (specifier.startsWith('/app/')) {
            const resolved = specifier.slice(5);
            return knownFiles.has(resolved) ? resolved : null;
        }
        return null;
    }

    // Static import/export-from: import ... from './foo.js', '../foo.js', or '/app/foo.js'
    code = code.replace(
        /((?:import|export)\s(?:[^'"]*?\s)?from\s*|import\s*)(['"])((?:\.{1,2}\/|\/app\/)[^'"]+)\2/g,
        (match, before, quote, specifier) => {
            const resolved = resolve(specifier);
            if (resolved) {
                return `${before}${quote}${APP_MODULE_PREFIX}${resolved}${quote}`;
            }
            return match;
        },
    );
    // Dynamic import: import('./foo.js'), import('../foo.js'), or import('/app/foo.js')
    code = code.replace(
        /import\s*\(\s*(['"])((?:\.{1,2}\/|\/app\/)[^'"]+)\1\s*\)/g,
        (match, quote, specifier) => {
            const resolved = resolve(specifier);
            if (resolved) {
                return `import(${quote}${APP_MODULE_PREFIX}${resolved}${quote})`;
            }
            return match;
        },
    );
    return code;
}

/**
 * Collect JS and CSS files from appFiles, build an import map with data URIs,
 * and inline CSS/script-src references in the HTML. Also rewrites binary
 * asset references (img / link / CSS url()) to data URLs when `assetUrls`
 * is non-empty.
 *
 * @param {Record<string, string>} appFiles
 * @param {string} html - the index.html content
 * @param {Record<string, string>} assetUrls - relative-path → data URL for binaries
 * @returns {{ html: string, importMap: Record<string, string> }}
 */
function _resolveAppModules(appFiles, html, assetUrls = {}) {
    // Collect non-HTML files
    const jsFiles = new Map();   // relative path → content
    const cssFiles = new Map();  // relative path → content

    for (const [path, content] of Object.entries(appFiles)) {
        const relative = path.replace(/^app\//, '');
        if (relative === 'index.html') continue;
        if (path.endsWith('.js')) {
            jsFiles.set(relative, content);
        } else if (path.endsWith('.css')) {
            cssFiles.set(relative, content);
        }
    }

    // Inline CSS: `<link ... href="./style.css">` (or `href="style.css"`,
    // no prefix) → `<style>contents</style>`. Both prefix forms are
    // valid HTML — agents commonly write the no-prefix form, and
    // without inlining the browser tries to fetch relative to the
    // iframe's blob: URL (which has no meaningful directory) and the
    // stylesheet 404s silently. The `(?:\\./)?` group makes the prefix
    // optional. The matched name is escaped, so `<link href="https://
    // fonts.googleapis.com/...">` (full external URL) doesn't match
    // any of our `cssFiles` entries and stays as a `<link>` for the
    // browser to fetch.
    //
    // Before inlining, rewrite any `url(...)` references in the CSS
    // body to point at the binary-asset data URLs. Has to happen
    // pre-inline because once it's in a `<style>` block, the
    // HTML-level rewriter only touches src/href/poster attrs (CSS
    // url() refs live inside the element body, not in attrs).
    for (const [name, content] of cssFiles) {
        const rewritten = Object.keys(assetUrls).length > 0
            ? rewriteCssAssetRefs(content, assetUrls)
            : content;
        const pattern = new RegExp(
            `<link[^>]*href=["'](?:\\./)?${_escapeRegex(name)}["'][^>]*/?>`,
            'g',
        );
        html = html.replace(pattern, `<style>${rewritten}</style>`);
    }

    // Build import map entries for JS files
    const appImports = {};
    const knownFiles = new Set(jsFiles.keys());

    if (knownFiles.size > 0) {
        for (const [name, content] of jsFiles) {
            const dir = name.includes('/') ? name.replace(/[^/]+$/, '') : '';
            const rewritten = _rewriteLocalImports(content, knownFiles, dir);
            const encoded = encodeURIComponent(rewritten);
            appImports[APP_MODULE_PREFIX + name] = `data:text/javascript;charset=utf-8,${encoded}`;
        }

        // Rewrite imports in inline <script type="module"> blocks
        html = html.replace(
            /(<script\b[^>]*type\s*=\s*["']module["'][^>]*>)([\s\S]*?)(<\/script>)/gi,
            (match, open, body, close) => {
                // Skip scripts with src attribute (handled below)
                if (/\bsrc\s*=/.test(open)) return match;
                return open + _rewriteLocalImports(body, knownFiles) + close;
            },
        );

        // Replace <script type="module" src="./foo.js"> with import via import map
        for (const name of jsFiles.keys()) {
            const pattern = new RegExp(
                `<script([^>]*?)\\bsrc=["'](?:\\./)?${_escapeRegex(name)}["']([^>]*)>[\\s\\S]*?</script>`,
                'g',
            );
            html = html.replace(pattern, (match, before, after) => {
                if (/type\s*=\s*["']module["']/.test(before + after)) {
                    // Module script → import via import map
                    const attrs = (before + after).replace(/type\s*=\s*["']module["']\s*/g, '').trim();
                    return `<script type="module" ${attrs}>import '${APP_MODULE_PREFIX}${name}';<\/script>`;
                }
                // Non-module script → inline directly
                const attrs = (before + after).trim();
                return `<script${attrs ? ' ' + attrs : ''}>${jsFiles.get(name)}<\/script>`;
            });
        }
    }

    // Auto-resolve bare npm specifiers to esm.sh. Scan every JS file
    // plus every inline `<script type="module">` block for bare
    // imports (e.g. `import { Bar } from 'recharts'`,
    // `import * as Dialog from '@radix-ui/react-dialog'`). For each
    // package root not already covered by CDN_IMPORTS, add both the
    // bare and trailing-slash forms pointing at esm.sh.
    //
    // Means agents can use any npm package transparently — no studio-
    // side import-map config per library, no direct-URL imports
    // required. CDN_IMPORTS still wins on the libs we ship pinned
    // (preact aliasing, etc.) because `_buildImportMapTag` spreads
    // CDN_IMPORTS first but we filter them out here before adding to
    // `appImports`, so there's no collision either way.
    const moduleScripts = [...jsFiles.values()];
    for (const match of html.matchAll(
        /<script\b[^>]*type\s*=\s*["']module["'][^>]*>([\s\S]*?)<\/script>/gi,
    )) {
        moduleScripts.push(match[1]);
    }
    const bareSpecs = _extractBareImports(moduleScripts.join('\n'));
    for (const pkg of bareSpecs) {
        if (pkg in CDN_IMPORTS) continue;
        appImports[pkg] = `https://esm.sh/${pkg}`;
        appImports[pkg + '/'] = `https://esm.sh/${pkg}/`;
    }

    // Binary-asset rewrites — applied last so they see the final
    // HTML (post CSS / script inlining). Two passes:
    //   1. HTML-level: src / href / poster attrs throughout the doc
    //      get their references swapped for data URLs.
    //   2. CSS-level: any inline `<style>` blocks (including the
    //      ones we just produced from inlining .css files) have
    //      their `url(...)` references rewritten.
    if (Object.keys(assetUrls).length > 0) {
        html = rewriteHtmlAssetRefs(html, assetUrls);
        html = html.replace(
            /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
            (_m, open, body, close) =>
                open + rewriteCssAssetRefs(body, assetUrls) + close,
        );
    }

    return { html, importMap: appImports };
}

/**
 * Build the import map script tag, merging CDN and app-local entries.
 * @param {Record<string, string>} appImports
 * @returns {string}
 */
function _buildImportMapTag(appImports) {
    const imports = { ...CDN_IMPORTS, ...appImports };
    return `<script type="importmap">${JSON.stringify({ imports })}<\/script>`;
}

/** A file is a worker entry if it ends in `.worker.js`. */
const WORKER_FILE_RE = /\.worker\.js$/;

/**
 * Bundle each `*.worker.js` app file into a self-contained ES module
 * suitable for `new Worker(url, { type: 'module' })`. Bare imports are
 * rewritten to absolute `https://esm.sh/...` URLs because a worker
 * never sees the page's import map (so the bare-specifier resolution
 * the main app relies on wouldn't work there); relative sibling files
 * bundle inline.
 *
 * Returns `{ '<path without app/ prefix>': '<bundled source>' }` —
 * an empty object (and NO esbuild load) when there are no worker
 * files, so the common worker-free app pays nothing. Throws with a
 * worker-scoped message on a build error so the agent sees which
 * worker failed and why.
 *
 * @param {Record<string, string>} appFiles
 * @returns {Promise<Record<string, string>>}
 */
export async function bundleAppWorkers(appFiles) {
    const entries = Object.keys(appFiles).filter((k) => WORKER_FILE_RE.test(k));
    if (entries.length === 0) return {};
    const { runEsbuild } = await import('./esbuild-bridge.js');
    const out = {};
    for (const key of entries) {
        const result = await runEsbuild({
            files: appFiles,
            entryPoint: key,
            format: 'esm',
            bareImports: 'esm-url',
        });
        if (result.errors && result.errors.length > 0) {
            const msg = result.errors.map((e) => e.text || String(e)).join('; ');
            throw new Error(`worker build failed for ${key}: ${msg}`);
        }
        out[key.replace(/^app\//, '')] = result.contents ?? '';
    }
    return out;
}

/**
 * Classic <script> that exposes the bundled worker sources and a
 * `window.appWorker(name)` launcher. Runs during parse (before the
 * deferred app module scripts), so `appWorker` is defined by the time
 * app code runs. The blob URL is minted inside the frame, so the
 * worker is same-origin to the app. '' when there are no workers.
 */
function _workerRegistryScript(workerSources) {
    if (Object.keys(workerSources).length === 0) return '';
    // Escape `<` so an embedded `</script>` in bundled source can't
    // terminate this tag; `<` is a valid JS string escape.
    const json = JSON.stringify(workerSources).replace(/</g, '\\u003c');
    // One Object URL per worker name, cached in the closure — repeated
    // appWorker(name) calls (apps that recreate workers) reuse it
    // rather than leaking a fresh un-revoked blob URL each time.
    return (
        `<script>(function(){var S=${json};var U={};window.__agexWorkerSrc=S;` +
        `window.appWorker=function(n){var s=S[n];` +
        `if(s==null)throw new Error('appWorker: no worker named "'+n+'\" (expected an app/*.worker.js file)');` +
        `if(!U[n])U[n]=URL.createObjectURL(new Blob([s],{type:"text/javascript"}));` +
        `return new Worker(U[n],{type:"module"});};})();<\/script>`
    );
}

/**
 * Build the full HTML string for an app preview or test iframe.
 * Injects console interceptor, query bridge, CDN scripts, and resolves
 * multi-file app projects (JS via import map with data URIs, CSS inlined).
 *
 * Async because any `*.worker.js` files are bundled (esbuild) into
 * self-contained module sources and exposed via `window.appWorker`.
 * Callers can pass `opts.workerSources` to supply pre-bundled sources
 * (and skip the esbuild load) — used by tests.
 *
 * @param {Record<string, string>} appFiles - map of filename → content
 * @param {{
 *   appBinaries?: Record<string, Uint8Array>,
 *   appStorage?: { seed?: Record<string,string>, writeable?: boolean },
 *   workerSources?: Record<string, string>,
 * }} [opts]
 * @returns {Promise<string>} complete HTML document
 */
export async function buildAppHtml(appFiles, opts = {}) {
    const storageShim = buildAppStorageShim(opts.appStorage || {});
    const workerSources = opts.workerSources ?? (await bundleAppWorkers(appFiles));
    const workerScript = _workerRegistryScript(workerSources);
    // Build the binary-asset URL map up-front so it can flow into
    // both the module resolver (which rewrites HTML / inlined CSS
    // refs) and the injected script that exposes
    // `window.appAssets` + the fetch monkey-patch.
    const assetUrls = buildAssetUrlMap(opts.appBinaries || {});
    const assetsScript = buildAssetsScript(assetUrls);
    let html = appFiles['app/index.html'] || appFiles['index.html'];
    if (html) {
        // Resolve multi-file references (JS import map, CSS inlining,
        // binary asset rewrites).
        const resolved = _resolveAppModules(appFiles, html, assetUrls);
        html = resolved.html;
        const importMapTag = _buildImportMapTag(resolved.importMap);
        const cdnScripts = importMapTag + '\n' + _plotlyScriptTag();

        if (!html.includes('agex-query')) {
            // Storage shim must run before app code (including the CDN
            // scripts below — a CDN library might poke localStorage on
            // import) and before the query bridge (which the shim could
            // one day use). Keep it right after the console interceptor.
            // `assetsScript` goes early too so the fetch monkey-patch
            // is in place before any agent JS runs.
            const injected = CONSOLE_INTERCEPTOR + storageShim + assetsScript + workerScript + QUERY_BRIDGE_SCRIPT + AGENT_CONTROL_BRIDGE_SCRIPT + cdnScripts;
            html = html.replace('<head>', '<head>' + injected);
            if (!html.includes('<head>')) {
                html = injected + html;
            }
        } else {
            // HTML already includes the query bridge (pre-built bundle);
            // still inject the console interceptor, storage shim, and
            // control bridge so test_app / live_app work.
            const injected = CONSOLE_INTERCEPTOR + storageShim + assetsScript + workerScript + AGENT_CONTROL_BRIDGE_SCRIPT;
            html = html.replace('<head>', '<head>' + injected);
            if (!html.includes('<head>')) {
                html = injected + html;
            }
        }
    } else {
        const mainJs = appFiles['app/main.js'] || appFiles['main.js'] || '';
        const importMapTag = _buildImportMapTag({});
        html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
${CONSOLE_INTERCEPTOR}
${storageShim}
${assetsScript}
${workerScript}
${QUERY_BRIDGE_SCRIPT}
${AGENT_CONTROL_BRIDGE_SCRIPT}
${importMapTag}
${_plotlyScriptTag()}
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #1a1a2e; color: #e0e0e0; padding: 1rem; }
</style>
</head><body>
<div id="app"></div>
<script type="module">${mainJs}<\/script>
</body></html>`;
    }
    return html;
}
