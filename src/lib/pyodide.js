/**
 * Pyodide Web Worker bridge.
 *
 * Spawns a Web Worker that runs Pyodide off the main thread.
 * Exposes a reactive store for loading state and a runPython() function
 * for executing Python code.
 */

import {
    runTestApp as appControlRunTestApp,
    runLiveApp as appControlRunLiveApp,
    setLiveIframe as appControlSetLiveIframe,
    getLiveIframe as appControlGetLiveIframe,
} from './app-control.js';
import { read as readAppStorage } from './app-storage.js';
import { buildAppHtml } from './app-html.js';
// Single source of truth for the settings localStorage key (the worker
// LLM bridge below reads the API key out of it per-request).
import { STORAGE_KEY as SETTINGS_STORAGE_KEY, resolveBaseUrl } from './settings.js';
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
            _handleTestApp(msg.appFilesJson, msg.actionsJson, msg.fresh, msg.viewportJson, msg.id);
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
 * Is `url` on the same origin as the user's configured LLM endpoint?
 *
 * The worker chooses request URLs, so without this gate a compromised
 * worker (or anything that reached the bridge) could ask the main
 * thread to attach the API key to an arbitrary destination. The
 * allowed origin derives from the same `resolveBaseUrl` the kernel
 * adapters use — OpenRouter in managed mode, the user's own base URL
 * in custom mode — so there's no separate list to keep in sync.
 */
function _isConfiguredLlmOrigin(url) {
    try {
        const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
        const base = resolveBaseUrl(raw ? JSON.parse(raw) : {});
        if (!base) return false;
        return new URL(url).origin === new URL(base).origin;
    } catch {
        return false;
    }
}

/**
 * Choose the auth header shape based on the request URL's host.
 * OpenRouter / OpenAI-compatible endpoints use `Authorization: Bearer`;
 * Anthropic's direct API uses `x-api-key`.
 *
 * Only injects when the request targets the configured provider's
 * origin — otherwise the request goes out unauthenticated (and
 * presumably 401s, which surfaces to the agent as an ordinary error).
 */
function _injectAuth(headers, url) {
    const key = _readApiKey();
    if (!key) return headers;
    if (!_isConfiguredLlmOrigin(url)) {
        console.warn(
            `LLM bridge: not attaching API key — ${url} is not on the configured provider origin`,
        );
        return headers;
    }
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

async function _handleTestApp(appFilesJson, actionsJson, fresh, viewportJson, requestId) {
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
            viewport: viewportJson ? JSON.parse(viewportJson) : null,
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
