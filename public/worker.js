/**
 * Pyodide Web Worker.
 *
 * Runs Pyodide off the main thread. Communicates via postMessage:
 *
 * Main → Worker:
 *   { type: 'init' }                      — load Pyodide and install packages
 *   { type: 'run', id, code }            — execute Python code
 *   { type: 'cancel' }                   — cancel the running task
 *   { type: 'set-google-token', token }  — push Google OAuth token
 *   { type: 'set-drive-files', files }  — update Drive mount picked files
 *
 * Worker → Main:
 *   { type: 'progress', message, progress } — loading progress (0–1)
 *   { type: 'ready' }                      — Pyodide loaded, packages installed
 *   { type: 'init-error', message }        — loading failed
 *   { type: 'result', id, value }          — Python code result
 *   { type: 'run-error', id, message }     — Python code error
 *   { type: 'token', id, token }           — streaming token during run
 *   { type: 'pdf-render', id, pdfBase64, pagesJson, scale } — render PDF pages
 */

const PYODIDE_CDN = "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/";

// Our packages — cache-busted so version bumps take effect immediately
const OWN_DEPS = [
    "kvgit>=0.1.8",
    "monkeyfs>=0.1.4",
    "reprobate>=0.1.1",
    "sandtrap>=0.1.10",
    // termish installed from local wheel below
];

// Third-party packages — use default index (includes Pyodide built-ins)
const VENDOR_DEPS = [
    "pydantic",
    "pygments",
    "pandas",
    "numpy",
    "plotly",
    "pypdf",
    "openpyxl",
    "scipy",
    "scikit-learn",
    "scikit-image",
    "python-dateutil",
    "sortedcontainers",
    "typing-extensions",
    "tzdata",
];

importScripts(`${PYODIDE_CDN}pyodide.js`);

let pyodide = null;

function progress(message, value) {
    self.postMessage({ type: "progress", message, progress: value });
}

async function init() {
    try {
        progress("Loading Pyodide...", 0);
        pyodide = await loadPyodide({ indexURL: PYODIDE_CDN });

        // Relay Python stdout/stderr to the main thread so debug prints
        // (e.g. agex.llm.pyfetch_openai's DEBUG_RAW_STREAM) appear in the
        // page console. Without this, prints land in the worker's
        // dedicated console which is hidden by default in DevTools.
        pyodide.setStdout({
            batched: (msg) => self.postMessage({ type: "stdout", message: msg }),
        });
        pyodide.setStderr({
            batched: (msg) => self.postMessage({ type: "stderr", message: msg }),
        });

        progress("Installing packages...", 0.15);
        await pyodide.loadPackage(["micropip", "Pillow"]);

        // Cache-bust PyPI index for our own packages so version bumps
        // take effect immediately. Only applied to OWN_DEPS to avoid
        // breaking Pyodide's built-in resolution for compiled packages.
        const appVersion = new URL(self.location.href).searchParams.get("v") || "0";
        const freshIndex = `https://pypi.org/pypi/{package_name}/json?v=${appVersion}`;

        // Install all packages in parallel where possible.
        // OWN_DEPS use cache-busted index; VENDOR_DEPS use default index.
        progress("Installing packages...", 0.2);

        const ownInstalls = OWN_DEPS.map(
            pkg => `micropip.install("${pkg}", index_urls="${freshIndex}")`
        );
        const vendorInstalls = VENDOR_DEPS.map(
            pkg => `micropip.install("${pkg}")`
        );
        const extraInstalls = [
            `micropip.install("icalendar", deps=False)`,
            `micropip.install("tabulate", deps=False)`,
            `micropip.install("kvgit>=0.2.1", deps=False, index_urls="${freshIndex}")`,
            `micropip.install("termish>=0.1.5", deps=False, index_urls="${freshIndex}")`,
            `micropip.install("agex>=0.10.2", deps=False, index_urls="${freshIndex}")`,
            `micropip.install("calgebra>=0.10.11", deps=False, index_urls="${freshIndex}")`,
        ];
        const allInstalls = [...ownInstalls, ...vendorInstalls, ...extraInstalls];

        await pyodide.runPythonAsync(`
import micropip, asyncio
await asyncio.gather(${allInstalls.join(", ")})
        `);

        progress("Verifying installation...", 0.95);
        await pyodide.runPythonAsync("import agex");

        // Patch cancellation to use an in-memory flag (set from JS via
        // pyodide.globals.set) instead of IndexedDB, which can't be
        // accessed synchronously from the worker's cancel message handler.
        await pyodide.runPythonAsync(`
import agex.agent.loop.async_loop as _aloop_mod

_agex_running_task = None

def _patched_check_cancellation(task_name, versioned_state, exec_state,
                                _orig=_aloop_mod.check_cancellation):
    flag_name = f"__agex_cancel_{task_name}"
    import __main__
    if getattr(__main__, flag_name, False):
        delattr(__main__, flag_name)
        return True
    return _orig(task_name, versioned_state, exec_state)

_aloop_mod.check_cancellation = _patched_check_cancellation
del _aloop_mod, _patched_check_cancellation
        `);

        // Install JS bridge for token streaming from Python.
        // We register a JS function that Python can call directly.
        pyodide.globals.set("_js_post_token", (runId, jsonStr) => {
            self.postMessage({ type: "token", id: runId, json: jsonStr });
        });

        await pyodide.runPythonAsync(`
import json as _json

def _post_token(run_id, token_dict):
    _js_post_token(run_id, _json.dumps(token_dict))
        `);

        // Register JS function for rendering Plotly figures via main thread.
        // Python awaits this function, which round-trips to the main
        // thread's Plotly.js and returns a base64 PNG string.
        pyodide.globals.set("_js_render_plotly", (figureJson) => {
            return new Promise((resolve) => {
                const id = ++_plotlyRenderId;
                plotlyPending.set(id, resolve);
                self.postMessage({ type: "plotly-render", id, figureJson });
            });
        });

        // Override view_image with an async wrapper that pre-renders Plotly
        // figures via browser-side Plotly.js before passing to agex.
        // Agent code runs inside sandtrap's aexec (async def), so await works.
        await pyodide.runPythonAsync(`
import agex.eval.bridge.namespace as _ns_mod

_orig_vi_call = _ns_mod._ViewImage.__call__

async def _async_vi_call(self, image, detail="high"):
    if hasattr(image, 'to_json') and hasattr(image, 'layout'):
        image = await _js_render_plotly(image.to_json())
    _orig_vi_call(self, image, detail)

_ns_mod._ViewImage.__call__ = _async_vi_call
        `);

        // Register JS bridge for rendering PDF pages via main thread pdf.js.
        // Python awaits this function, which round-trips to the main thread
        // and returns a JSON array of base64 PNG strings.
        pyodide.globals.set("_js_render_pdf", (pdfBase64, pagesJson, scale) => {
            return new Promise((resolve) => {
                const id = ++_pdfRenderId;
                pdfPending.set(id, resolve);
                self.postMessage({ type: "pdf-render", id, pdfBase64, pagesJson, scale });
            });
        });

        // Register JS bridge for getting PDF page count via main thread pdf.js.
        pyodide.globals.set("_js_pdf_page_count", (pdfBase64) => {
            return new Promise((resolve) => {
                const id = ++_pdfRenderId;
                pdfPending.set(id, resolve);
                self.postMessage({ type: "pdf-page-count", id, pdfBase64 });
            });
        });

        // Register JS bridge for headless app testing.
        // Python awaits this, which round-trips to the main thread to build
        // a hidden iframe, run the app, and collect console messages.
        pyodide.globals.set("_js_test_app", (appFilesJson, actionsJson) => {
            return new Promise((resolve) => {
                const id = ++_testAppId;
                testAppPending.set(id, resolve);
                self.postMessage({ type: "test-app", id, appFilesJson, actionsJson });
            });
        });

        // Register JS bridge for live app interaction.
        pyodide.globals.set("_js_live_app", (actionsJson) => {
            return new Promise((resolve) => {
                const id = ++_liveAppId;
                liveAppPending.set(id, resolve);
                self.postMessage({ type: "live-app", id, actionsJson });
            });
        });

        // LLM bridge — non-streaming. Main thread reads the API key
        // from localStorage, injects Authorization, does the fetch,
        // returns a JSON-serialized { ok, data? , status?, error? }.
        // Python (JsBridgeAdapter.fetch_json) unwraps the envelope.
        //
        // Attached to `self` (worker globalThis) so Python code in
        // imported modules can `from js import _js_llm_fetch`.
        // pyodide.globals.set only exposes the name to inline Python
        // running in __main__, which wouldn't reach a module like
        // bridge_llm.py.
        const llmFetchFn = (requestJson) => {
            return new Promise((resolve) => {
                const id = ++_llmRequestId;
                llmFetchPending.set(id, resolve);
                self.postMessage({ type: "llm-fetch", id, requestJson });
            });
        };
        self._js_llm_fetch = llmFetchFn;
        pyodide.globals.set("_js_llm_fetch", llmFetchFn);

        // LLM bridge — streaming. Python passes three proxied callbacks
        // (chunk/done/error). Main thread does a streaming fetch and
        // postMessages back chunks / done / error tagged with the id.
        // We look up the callbacks by id and invoke accordingly.
        const llmStreamFn = (requestJson, onChunk, onDone, onError) => {
            const id = ++_llmStreamId;
            llmStreamPending.set(id, { onChunk, onDone, onError });
            self.postMessage({ type: "llm-stream", id, requestJson });
        };
        self._js_llm_stream = llmStreamFn;
        pyodide.globals.set("_js_llm_stream", llmStreamFn);

        self.postMessage({ type: "ready" });
    } catch (e) {
        self.postMessage({ type: "init-error", message: e.message });
    }
}

async function run(id, code) {
    try {
        // Clear any stale cancel flag from a previous run
        if (pyodide.globals.has("__agex_cancel_chat")) {
            pyodide.globals.delete("__agex_cancel_chat");
        }
        const result = await pyodide.runPythonAsync(code);
        // Convert Python objects to JS strings
        const value = result != null ? result.toString() : null;
        self.postMessage({ type: "result", id, value });
    } catch (e) {
        self.postMessage({ type: "run-error", id, message: e.message });
    }
}

// Pending Plotly render requests: id → resolve function
const plotlyPending = new Map();
let _plotlyRenderId = 0;

// Pending PDF render requests: id → resolve function
const pdfPending = new Map();
let _pdfRenderId = 0;

// Pending test-app requests: id → resolve function
const testAppPending = new Map();
let _testAppId = 0;

// Pending live-app requests: id → resolve function
const liveAppPending = new Map();
let _liveAppId = 0;

// Pending LLM fetch (non-streaming) requests: id → resolve function
const llmFetchPending = new Map();
let _llmRequestId = 0;

// Pending LLM stream requests: id → { onChunk, onDone, onError } proxies.
// Python destroys the proxies in a finally block after done/error fires,
// so the main thread should not invoke them further once the stream is
// terminated.
const llmStreamPending = new Map();
let _llmStreamId = 0;

self.onmessage = (e) => {
    const { type } = e.data;
    if (type === "init") {
        init();
    } else if (type === "set-google-token") {
        if (pyodide) {
            const val = e.data.token ? `"${e.data.token}"` : "None";
            pyodide.runPython(`_google_access_token = ${val}`);
        }
    } else if (type === "set-drive-files") {
        if (pyodide) {
            const json = JSON.stringify(e.data.files || []).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
            pyodide.runPython(`_update_drive_files('${json}')`);
        }
    } else if (type === "cancel") {
        if (pyodide) {
            // Set in-memory flag for graceful cancellation at next iteration boundary.
            pyodide.globals.set("__agex_cancel_chat", true);
            // Also cancel the asyncio task for immediate interruption.
            // Task.cancel() is a simple flag-set (no I/O), safe from sync context.
            try {
                pyodide.runPython(
                    "if _agex_running_task is not None: _agex_running_task.cancel()"
                );
            } catch (e) {
                // Fallback: in-memory flag still provides cancellation
            }
        }
    } else if (type === "run") {
        run(e.data.id, e.data.code);
    } else if (type === "plotly-rendered") {
        const resolve = plotlyPending.get(e.data.id);
        if (resolve) {
            plotlyPending.delete(e.data.id);
            resolve(e.data.base64);
        }
    } else if (type === "pdf-rendered") {
        const resolve = pdfPending.get(e.data.id);
        if (resolve) {
            pdfPending.delete(e.data.id);
            resolve(e.data.pagesJson);
        }
    } else if (type === "test-app-result") {
        const resolve = testAppPending.get(e.data.id);
        if (resolve) {
            testAppPending.delete(e.data.id);
            resolve(e.data.resultsJson);
        }
    } else if (type === "live-app-result") {
        const resolve = liveAppPending.get(e.data.id);
        if (resolve) {
            liveAppPending.delete(e.data.id);
            resolve(e.data.resultsJson);
        }
    } else if (type === "llm-fetch-result") {
        const resolve = llmFetchPending.get(e.data.id);
        if (resolve) {
            llmFetchPending.delete(e.data.id);
            resolve(e.data.resultJson);
        }
    } else if (type === "llm-stream-chunk") {
        const entry = llmStreamPending.get(e.data.id);
        if (entry) entry.onChunk(e.data.chunk);
    } else if (type === "llm-stream-done") {
        const entry = llmStreamPending.get(e.data.id);
        if (entry) {
            llmStreamPending.delete(e.data.id);
            entry.onDone();
        }
    } else if (type === "llm-stream-error") {
        const entry = llmStreamPending.get(e.data.id);
        if (entry) {
            llmStreamPending.delete(e.data.id);
            entry.onError(e.data.error || "Unknown error");
        }
    }
};
