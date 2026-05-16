/**
 * Pyodide Web Worker bridge.
 *
 * Spawns a Web Worker that runs Pyodide off the main thread.
 * Exposes a reactive store for loading state and a runPython() function
 * for executing Python code.
 */

// Iframe control bridge source — injected verbatim into the app preview
// iframe as an inline module script. Factored as its own module so the
// dispatch logic can be unit-tested against jsdom/happy-dom. See
// src/lib/iframe-bridge.js and its tests.
import _iframeBridgeSource from './iframe-bridge.js?raw';
import {
    runTestApp as appControlRunTestApp,
    runLiveApp as appControlRunLiveApp,
    setLiveIframe as appControlSetLiveIframe,
    getLiveIframe as appControlGetLiveIframe,
} from './app-control.js';
import { read as readAppStorage } from './app-storage.js';
// `?url` makes vite emit `esbuild-bridge.js` as a static asset and
// hand back its resolved URL (hashed in production, /src/... in dev).
// Forwarded to the py worker via the init postMessage so worker.js
// can fetch the same vite-bundled bridge the TS kernel uses.
import _esbuildBridgeUrl from './esbuild-bridge.js?url';

/** @type {Worker | null} */
let worker = null;

/** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void, onToken?: (token: any) => void }>} */
const pending = new Map();
let nextId = 1;

/** @type {((state: LoadingState) => void)[]} */
let subscribers = [];

/**
 * @typedef {Object} LoadingState
 * @property {'idle'|'loading'|'ready'|'error'} status
 *     ``ready`` corresponds to Wave 3 finished — full agent capability.
 * @property {'idle'|'loading'|'history-ready'|'send-ready'} stage
 *     Finer-grained boot progress. `history-ready` fires after Wave 2
 *     (agex + pandas/plotly installed and bridges wired). `send-ready`
 *     fires after Wave 3 (calgebra installed) and is equivalent to
 *     `status === 'ready'`.
 * @property {string} message
 * @property {number} progress - 0 to 1
 */

/** @type {LoadingState} */
let state = {
    status: "idle",
    stage: "idle",
    message: "",
    progress: 0,
};

function notify() {
    for (const fn of subscribers) fn(state);
}

function update(/** @type {Partial<LoadingState>} */ patch) {
    state = { ...state, ...patch };
    notify();
}

/**
 * Svelte-compatible store for loading state.
 */
export const pyodideStore = {
    subscribe(fn) {
        subscribers.push(fn);
        fn(state);
        return () => {
            subscribers = subscribers.filter((s) => s !== fn);
        };
    },
};

/**
 * Start the Pyodide worker and install packages.
 * Safe to call multiple times.
 */
export function startWorker() {
    if (state.status === "loading" || state.status === "ready") return;

    update({
        status: "loading",
        stage: "loading",
        message: "Starting worker...",
        progress: 0,
    });

    worker = new Worker(`/worker.js?v=${__APP_VERSION__}`);

    worker.onmessage = (e) => {
        const msg = e.data;

        if (msg.type === "progress") {
            update({ message: msg.message, progress: msg.progress });
        } else if (msg.type === "stage") {
            // Worker emits intermediate stage events. Today only
            // `history-ready` is sent between Wave 2 and Wave 3; the
            // final transition lands via the `ready` message below.
            update({ stage: msg.stage });
        } else if (msg.type === "ready") {
            update({
                status: "ready",
                stage: "send-ready",
                message: "Ready",
                progress: 1,
            });
        } else if (msg.type === "init-error") {
            update({ status: "error", message: `Failed: ${msg.message}` });
        } else if (msg.type === "stdout") {
            console.log("[py]", msg.message);
        } else if (msg.type === "stderr") {
            console.warn("[py]", msg.message);
        } else if (msg.type === "result") {
            const p = pending.get(msg.id);
            if (p) {
                p.resolve(msg.value);
                // Defer cleanup so late-arriving token messages still
                // find their pending entry and reach onToken.
                setTimeout(() => pending.delete(msg.id), 0);
            }
        } else if (msg.type === "run-error") {
            const p = pending.get(msg.id);
            if (p) {
                p.reject(new Error(msg.message));
                setTimeout(() => pending.delete(msg.id), 0);
            }
        } else if (msg.type === "token") {
            const p = pending.get(msg.id);
            const tok = JSON.parse(msg.json);
            if (localStorage.getItem("agex-debug-tokens") === "1") {
                console.log("[llm token]", tok);
            }
            if (p?.onToken) p.onToken(tok);
        } else if (msg.type === "plotly-render") {
            renderPlotlyOffscreen(msg.figureJson, msg.id);
        } else if (msg.type === "pdf-render") {
            renderPdfPages(msg.pdfBase64, msg.pagesJson, msg.scale, msg.id);
        } else if (msg.type === "pdf-page-count") {
            getPdfPageCount(msg.pdfBase64, msg.id);
        } else if (msg.type === "test-app") {
            _handleTestApp(msg.appFilesJson, msg.actionsJson, msg.fresh, msg.id);
        } else if (msg.type === "live-app") {
            _handleLiveApp(msg.actionsJson, msg.id);
        } else if (msg.type === "llm-fetch") {
            handleLlmFetch(msg.requestJson, msg.id);
        } else if (msg.type === "llm-stream") {
            handleLlmStream(msg.requestJson, msg.id);
        } else if (msg.type === "llm-stream-cancel") {
            cancelLlmStream(msg.id);
        }
    };

    worker.onerror = (e) => {
        update({ status: "error", message: `Worker error: ${e.message}` });
    };

    worker.postMessage({ type: "init", esbuildBridgeUrl: _esbuildBridgeUrl });
}

/**
 * Render a Plotly figure to a base64 PNG offscreen using Plotly.js.
 */
async function renderPlotlyOffscreen(figureJson, requestId) {
    try {
        // Ensure Plotly.js is loaded
        if (!window.Plotly) {
            await new Promise((resolve, reject) => {
                const script = document.createElement("script");
                script.src = "https://cdn.plot.ly/plotly-2.35.2.min.js";
                script.onload = () => resolve();
                script.onerror = () => reject(new Error("Failed to load Plotly.js"));
                document.head.appendChild(script);
            });
        }

        const figure = JSON.parse(figureJson);
        // Create an offscreen container
        const div = document.createElement("div");
        div.style.position = "absolute";
        div.style.left = "-9999px";
        div.style.width = "800px";
        div.style.height = "600px";
        document.body.appendChild(div);

        try {
            await window.Plotly.newPlot(div, figure.data || [], figure.layout || {});
            const dataUrl = await window.Plotly.toImage(div, {
                format: "png",
                width: 800,
                height: 600,
            });
            // Strip data:image/png;base64, prefix
            const base64 = dataUrl.split(",")[1];
            worker.postMessage({ type: "plotly-rendered", id: requestId, base64 });
        } finally {
            window.Plotly.purge(div);
            div.remove();
        }
    } catch (e) {
        console.error("Plotly offscreen render failed:", e);
        worker.postMessage({ type: "plotly-rendered", id: requestId, base64: null });
    }
}

// PDF rendering implementation moved to `pdf-render.js` so the TS
// kernel can share the same pdf.js loader + page-render path. This
// file keeps the py-bridge wrappers — they base64-encode/decode at
// the boundary because the agex-py worker round-trips through JSON
// strings, while the shared module operates on raw bytes.
import {
    renderPdfPagesToBytes as _renderPdfPagesToBytes,
    getPdfPageCount as _getPdfPageCount,
} from "./pdf-render.js";
import { bytesToBase64 } from "./bytes.js";
import {
    buildAssetsScript,
    buildAssetUrlMap,
    rewriteCssAssetRefs,
    rewriteHtmlAssetRefs,
} from "./app-assets.js";

/**
 * Render PDF pages and post results back to the py worker as a
 * JSON-encoded list of base64 strings. Out-of-range pages are sent
 * as `null` to preserve the indices/positions the py side expects.
 */
async function renderPdfPages(pdfBase64, pagesJson, scale, requestId) {
    try {
        const pdfData = Uint8Array.from(atob(pdfBase64), (c) =>
            c.charCodeAt(0),
        );
        const pages = pagesJson ? JSON.parse(pagesJson) : null;
        const pageBytes = await _renderPdfPagesToBytes(
            pdfData,
            pages,
            scale || 2,
        );
        // Empty Uint8Array (out-of-range marker from the shared
        // module) → null in the py-shaped result list.
        const results = pageBytes.map((b) =>
            b.length === 0 ? null : bytesToBase64(b),
        );
        worker.postMessage({
            type: "pdf-rendered",
            id: requestId,
            pagesJson: JSON.stringify(results),
        });
    } catch (e) {
        console.error("PDF render failed:", e);
        worker.postMessage({
            type: "pdf-rendered",
            id: requestId,
            pagesJson: JSON.stringify([]),
        });
    }
}

/**
 * Get PDF page count and post back to the py worker.
 */
async function getPdfPageCount(pdfBase64, requestId) {
    try {
        const pdfData = Uint8Array.from(atob(pdfBase64), (c) =>
            c.charCodeAt(0),
        );
        const numPages = await _getPdfPageCount(pdfData);
        worker.postMessage({
            type: "pdf-rendered",
            id: requestId,
            pagesJson: JSON.stringify(numPages),
        });
    } catch (e) {
        console.error("PDF page count failed:", e);
        worker.postMessage({
            type: "pdf-rendered",
            id: requestId,
            pagesJson: JSON.stringify(0),
        });
    }
}

// --- LLM bridge: main-thread fetch with key from localStorage ---

const SETTINGS_STORAGE_KEY = "agex-settings";

/**
 * Read the OpenRouter / Anthropic API key from localStorage.
 * Done per-request so key rotation via the Settings drawer takes effect
 * immediately without requiring a worker restart.
 */
function _readApiKey() {
    try {
        const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
        if (!raw) return "";
        const settings = JSON.parse(raw);
        return settings.apiKey || "";
    } catch {
        return "";
    }
}

/**
 * Choose the auth header shape based on the request URL's host.
 * OpenRouter / OpenAI-compatible endpoints use `Authorization: Bearer`;
 * Anthropic's direct API uses `x-api-key`.
 */
function _injectAuth(headers, url) {
    const key = _readApiKey();
    if (!key) return headers;
    if (url.includes("api.anthropic.com")) {
        headers["x-api-key"] = key;
    } else {
        headers["Authorization"] = `Bearer ${key}`;
    }
    return headers;
}

/**
 * Handle non-streaming LLM fetch request from the worker.
 * Reads key from localStorage, does fetch, posts JSON-serialized
 * { ok, data?, status?, error? } envelope back to the worker.
 */
async function handleLlmFetch(requestJson, requestId) {
    const send = (result) => worker.postMessage({
        type: "llm-fetch-result",
        id: requestId,
        resultJson: JSON.stringify(result),
    });

    let req;
    try {
        req = JSON.parse(requestJson);
    } catch (e) {
        send({ ok: false, status: 0, error: `Bad request envelope: ${e.message}` });
        return;
    }

    try {
        const headers = _injectAuth({ ...req.headers }, req.url);
        const resp = await fetch(req.url, {
            method: req.method || "POST",
            headers,
            body: req.body,
        });
        if (!resp.ok) {
            let errorMsg;
            try {
                const errBody = await resp.json();
                errorMsg = errBody?.error?.message || JSON.stringify(errBody);
            } catch {
                errorMsg = `HTTP ${resp.status}`;
            }
            send({ ok: false, status: resp.status, error: errorMsg });
            return;
        }
        const data = await resp.json();
        send({ ok: true, data });
    } catch (e) {
        send({ ok: false, status: 0, error: e.message || String(e) });
    }
}

// Outstanding streaming LLM requests keyed by stream id.
// Used by `cancelLlmStream` to abort an in-flight fetch when the
// Python consumer side signals it's done reading.
/** @type {Map<number, AbortController>} */
const llmStreamControllers = new Map();

/**
 * Abort an in-flight streaming LLM request. Called in response to a
 * `llm-stream-cancel` message from the worker, which Python posts
 * from its ``fetch_stream`` adapter's ``finally`` before destroying
 * its callback proxies. Aborting here stops the SSE reader loop and
 * prevents any further `llm-stream-chunk` messages from going to
 * a consumer that's torn down.
 */
function cancelLlmStream(requestId) {
    const ctrl = llmStreamControllers.get(requestId);
    if (!ctrl) return;
    llmStreamControllers.delete(requestId);
    try { ctrl.abort(); } catch { /* already aborted */ }
}

/**
 * Handle streaming LLM request from the worker.
 * Pipes SSE-style text chunks back to the worker as they arrive, then
 * sends either `llm-stream-done` on success or `llm-stream-error` on
 * failure. The worker's JS side invokes Python callbacks for each chunk.
 *
 * Respects cancellation: if the worker posts `llm-stream-cancel` for
 * this stream id (which ``cancelLlmStream`` handles), the fetch is
 * aborted and the reader loop drops out silently — no `done`/`error`
 * is posted back, since the consumer is already gone.
 */
async function handleLlmStream(requestJson, requestId) {
    const controller = new AbortController();
    llmStreamControllers.set(requestId, controller);
    const isCancelled = () => !llmStreamControllers.has(requestId);

    const sendChunk = (chunk) => {
        if (isCancelled()) return;
        worker.postMessage({ type: "llm-stream-chunk", id: requestId, chunk });
    };
    const sendDone = () => {
        if (isCancelled()) return;
        llmStreamControllers.delete(requestId);
        worker.postMessage({ type: "llm-stream-done", id: requestId });
    };
    const sendError = (msg) => {
        if (isCancelled()) return;
        llmStreamControllers.delete(requestId);
        worker.postMessage({ type: "llm-stream-error", id: requestId, error: msg });
    };

    let req;
    try {
        req = JSON.parse(requestJson);
    } catch (e) {
        sendError(`Bad request envelope: ${e.message}`);
        return;
    }

    try {
        const headers = _injectAuth({ ...req.headers }, req.url);
        const resp = await fetch(req.url, {
            method: req.method || "POST",
            headers,
            body: req.body,
            signal: controller.signal,
        });
        if (!resp.ok) {
            let errorMsg;
            try {
                const errBody = await resp.json();
                errorMsg = errBody?.error?.message || JSON.stringify(errBody);
            } catch {
                errorMsg = `HTTP ${resp.status}`;
            }
            sendError(`API error (${resp.status}): ${errorMsg}`);
            return;
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder("utf-8");
        while (true) {
            if (isCancelled()) return;
            const { done, value } = await reader.read();
            if (done) break;
            // stream: true to retain incomplete multi-byte sequences
            const text = decoder.decode(value, { stream: true });
            if (text) sendChunk(text);
        }
        // Flush trailing bytes
        const final = decoder.decode();
        if (final) sendChunk(final);
        sendDone();
    } catch (e) {
        // AbortError on a cancelled stream is the expected shutdown
        // path; don't bubble it up as an error to the consumer.
        if (isCancelled() || e?.name === "AbortError") return;
        sendError(e.message || String(e));
    }
}

// --- App testing and live interaction ---

/** @type {((code: string, resultVars: string[] | null) => Promise<any>) | null} */
let queryHandler = null;

/**
 * Register the query handler for app testing/interaction.
 * Called by agent.js after init to avoid circular imports.
 * @param {(code: string, resultVars: string[] | null) => Promise<any>} fn
 */
export function setQueryHandler(fn) {
    queryHandler = fn;
}

/**
 * Tell the worker it's safe to begin Wave 3 (calgebra) install.
 * Called once by the host after Wave-2 work (basics init + history
 * load) has finished — Pyodide serializes runPythonAsync calls, so
 * deferring Wave 3 keeps basics fast.
 */
export function startWave3() {
    if (worker) worker.postMessage({ type: "start-wave3" });
}

/**
 * Register the live preview iframe for live_app().
 * Called by AppPreview.svelte when the iframe is mounted. Re-exports
 * the app-control module's setter so AppPreview's existing
 * `import { setLiveIframe } from './pyodide.js'` keeps working —
 * the module-level state lives in app-control.js so the TS adapter
 * can also read it.
 * @param {HTMLIFrameElement | null} iframe
 */
export function setLiveIframe(iframe) {
    appControlSetLiveIframe(iframe);
}

// Console interceptor script — injected into both test and live iframes.
// Captures console.log/warn/error, window.onerror, unhandled rejections.
// Also (temporarily) posts resource-load errors back to the parent so
// we can diagnose the "Not allowed to load local resource: blob:..."
// warnings — those fire as error events on elements (img/script/etc.)
// and DON'T bubble to window.onerror, so a capture-phase listener is
// needed to see them.
const CONSOLE_INTERCEPTOR = `
<script>
(function() {
    window.__agex_logs = [];
    var _origLog = console.log, _origWarn = console.warn, _origErr = console.error;
    function capture(level, args) {
        var msg = Array.prototype.map.call(args, function(a) {
            try { return typeof a === 'object' ? JSON.stringify(a) : String(a); }
            catch(e) { return String(a); }
        }).join(' ');
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
            }, '*');
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
        }, '*');
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
        }, '*');
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
                }, '*');
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
    "htm": "https://esm.sh/htm@3.1.1",
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
                `<script([^>]*?)\\bsrc=["']\\./${_escapeRegex(name)}["']([^>]*)>[\\s\\S]*?</script>`,
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

/**
 * Build the full HTML string for an app preview or test iframe.
 * Injects console interceptor, query bridge, CDN scripts, and resolves
 * multi-file app projects (JS via import map with data URIs, CSS inlined).
 *
 * @param {Record<string, string>} appFiles - map of filename → content
 * @param {{
 *   appBinaries?: Record<string, Uint8Array>,
 *   appStorage?: { seed?: Record<string,string>, writeable?: boolean }
 * }} [opts]
 * @returns {string} complete HTML document
 */
export function buildAppHtml(appFiles, opts = {}) {
    const storageShim = buildAppStorageShim(opts.appStorage || {});
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
            const injected = CONSOLE_INTERCEPTOR + storageShim + assetsScript + QUERY_BRIDGE_SCRIPT + AGENT_CONTROL_BRIDGE_SCRIPT + cdnScripts;
            html = html.replace('<head>', '<head>' + injected);
            if (!html.includes('<head>')) {
                html = injected + html;
            }
        } else {
            // HTML already includes the query bridge (pre-built bundle);
            // still inject the console interceptor, storage shim, and
            // control bridge so test_app / live_app work.
            const injected = CONSOLE_INTERCEPTOR + storageShim + assetsScript + AGENT_CONTROL_BRIDGE_SCRIPT;
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

/**
 * Worker-message wrappers around the kernel-agnostic
 * `runTestApp` / `runLiveApp` orchestration in `app-control.js`.
 *
 * The bulk of the iframe-control logic now lives in `app-control.js`
 * so the TS adapter can register `test_app` / `live_app` as
 * `agent.fn(...)` host-resident calls without going through the
 * py-only worker round-trip. These wrappers keep the py side's
 * existing `_js_test_app` / `_js_live_app` JS-bridge contract
 * unchanged: parse the worker payload, invoke the orchestrator with
 * the py-shaped query handler (no cache handler — py apps use
 * `runQuery` for app↔agent data passing, not `getCacheValue`), and
 * post results back to the worker.
 */

async function _handleTestApp(appFilesJson, actionsJson, fresh, requestId) {
    let appStorageSeed = {};
    if (!fresh) {
        const branch = localStorage.getItem("agex-current-branch") || "";
        if (branch) appStorageSeed = readAppStorage("py", branch);
    }
    try {
        const results = await appControlRunTestApp({
            appFiles: JSON.parse(appFilesJson),
            actions: actionsJson ? JSON.parse(actionsJson) : [],
            appStorageSeed,
            buildAppHtml,
            queryHandler: queryHandler
                ? (code, resultVars) => queryHandler(code, resultVars)
                : null,
            cacheHandler: null,
        });
        worker.postMessage({
            type: "test-app-result",
            id: requestId,
            resultsJson: JSON.stringify(results),
        });
    } catch (e) {
        worker.postMessage({
            type: "test-app-result",
            id: requestId,
            resultsJson: JSON.stringify([
                { type: "log", level: "error", message: "test_app failed: " + e.message },
            ]),
        });
    }
}

async function _handleLiveApp(actionsJson, requestId) {
    try {
        const results = await appControlRunLiveApp({
            iframe: appControlGetLiveIframe(),
            actions: actionsJson ? JSON.parse(actionsJson) : [],
        });
        worker.postMessage({
            type: "live-app-result",
            id: requestId,
            resultsJson: JSON.stringify(results),
        });
    } catch (e) {
        worker.postMessage({
            type: "live-app-result",
            id: requestId,
            resultsJson: JSON.stringify([
                { type: "log", level: "error", message: "live_app failed: " + e.message },
            ]),
        });
    }
}

/**
 * Stages at which the worker is ready to accept Python runs. We allow
 * `history-ready` (Wave 2 done — agex + pandas/plotly installed) so
 * the host can run `initAgentBasics` + `loadHistory` while Wave 3 is
 * still installing in the background. The worker queues run() calls
 * fine in that interval; pyodide's asyncio event loop interleaves
 * them with the in-flight Wave 3 install.
 */
function _runReady() {
    return (
        worker &&
        (state.stage === "history-ready" || state.stage === "send-ready")
    );
}

/**
 * Run Python code in the worker and return the result.
 *
 * @param {string} code - Python code to execute
 * @returns {Promise<string | null>}
 */
export function runPython(code) {
    if (!_runReady()) {
        return Promise.reject(new Error("Pyodide not ready"));
    }

    const id = nextId++;
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ type: "run", id, code });
    });
}

/**
 * Run Python code with streaming token support.
 * The code can call _post_token(run_id, token_dict) to stream tokens.
 * The run_id is injected as `_run_id` in the code.
 *
 * @param {string} code - Python code (may reference _run_id)
 * @param {(token: any) => void} onToken - called for each streamed token
 * @returns {Promise<string | null>}
 */
export function runPythonStreaming(code, onToken) {
    // Streaming is only triggered by sendMessage / app exports, both of
    // which are gated on `agentReady` (== Wave 3 done). The same
    // history-ready threshold as runPython is fine here too.
    if (!_runReady()) {
        return Promise.reject(new Error("Pyodide not ready"));
    }

    const id = nextId++;
    const wrappedCode = `_run_id = ${id}\n${code}`;
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, onToken });
        worker.postMessage({ type: "run", id, code: wrappedCode });
    });
}

/**
 * Request cancellation of the running task.
 * Uses two mechanisms: an in-memory flag checked at iteration boundaries,
 * and asyncio Task.cancel() for immediate interruption mid-iteration.
 */
export function cancelTask() {
    if (!worker || state.status !== "ready") return;
    worker.postMessage({ type: "cancel" });
}

/**
 * Terminate the worker and reject all pending tasks.
 * The caller is responsible for re-initializing (startWorker + initAgent).
 */
export function terminateWorker() {
    if (!worker) return;

    worker.terminate();
    worker = null;

    // Reject all in-flight tasks
    for (const [id, p] of pending) {
        p.reject(new Error("Cancelled"));
    }
    pending.clear();

    update({ status: "idle", message: "", progress: 0 });
}
