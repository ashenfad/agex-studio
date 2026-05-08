/**
 * Pyodide Web Worker.
 *
 * Runs Pyodide off the main thread. Communicates via postMessage:
 *
 * Main → Worker:
 *   { type: 'init' }                      — load Pyodide and install packages
 *   { type: 'run', id, code }            — execute Python code
 *   { type: 'cancel' }                   — cancel the running task
 *   { type: 'write-downloaded-file', id, path, bytes }  — write main-
 *       thread-fetched bytes (e.g. Drive import) into the agent's VFS
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

// Wave 2: everything the chat needs to read history and operate the
// agent — installed first so the UI can become history-ready as fast
// as possible. pandas + plotly stay in this wave because chat events
// can hold pickled DataFrames / Figures that won't deserialize without
// them.
//
// Split by install mechanism:
// - WAVE2_OWN:    our PyPI packages; need version pinning + cache-bust
//                 index, so they go through micropip.install.
// - WAVE2_VENDOR: Pyodide-distributed built-ins; load via
//                 pyodide.loadPackage directly, which skips micropip's
//                 PyPI metadata resolution and is measurably faster
//                 than micropip.install for the same set.
const WAVE2_OWN = [
    "kvgit>=0.2.2",
    "monkeyfs>=0.1.4",
    "reprobate>=0.1.1",
    "sandtrap>=0.2.1",
];
// Pyodide's built-in package set — loadPackage resolves these from
// the runtime's lockfile. plotly / others not in that lockfile must
// go through micropip instead (see WAVE2_VENDOR_MICROPIP below).
const WAVE2_VENDOR = [
    "pydantic",
    "pygments",
    "pandas",
    "numpy",
    "python-dateutil",
    "sortedcontainers",
    "typing-extensions",
    "tzdata",
    // Dep of plotly — pre-loading in parallel shortens the micropip
    // critical path since plotly's install doesn't have to serialize
    // on fetching narwhals afterwards.
    "narwhals",
];

// Vendor packages that aren't in Pyodide's built-in lockfile — still
// need micropip, but they don't need cache-bust or version pinning.
const WAVE2_VENDOR_MICROPIP = [
    "plotly",
    "pypdf",
    "openpyxl",
    // Pure-Python; backs kvgit's Disk store (which we use over the
    // OPFS mount set up later in init). agex declares it as a dep
    // but installs with deps=False, so we add it here explicitly.
    "diskcache",
];

// Wave 3: capabilities that aren't on the critical path for reading
// history or sending most chats. Installed in the background after
// Wave 2; Send + app preview wait until Wave 3 finishes so the agent
// never tries to import a Wave 3 module before it's ready.  Currently
// just calgebra (loaded via micropip below); the heavier ML / plotting
// / document-authoring set was cut to keep the runtime footprint
// inside iOS Safari's per-tab memory budget.
const WAVE3_VENDOR = [];

importScripts(`${PYODIDE_CDN}pyodide.js`);

let pyodide = null;

// One-shot signal: Wave 3 install waits for the host to tell us that
// basics + history have loaded. Resolved exactly once, by a
// `start-wave3` message from the main thread.
let _startWave3 = null;
const _wave3Started = new Promise((resolve) => { _startWave3 = resolve; });

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
        // sqlite3 is a Pyodide built-in but isn't in core stdlib —
        // it's loaded as a package. Required for kvgit[disk] (via
        // diskcache) over the OPFS mount we set up below.
        await pyodide.loadPackage(["micropip", "Pillow", "sqlite3"]);

        // Mount the browser's Origin Private File System at /persist
        // so Python file I/O (used by kvgit's Disk backend via
        // diskcache+sqlite) lands somewhere persistent. Survives
        // reload, GB-scale quota, no JSPI dependency — works on
        // Chrome/Edge, Firefox, and Safari. Workers (us) get sync
        // access handles for best perf.
        //
        // Must run before any Python code touches /persist; that
        // means before the kvgit-using session/agent code runs, and
        // safely before Wave 2's `import agex` verification too.
        progress("Mounting persistent storage...", 0.18);
        const opfsRoot = await navigator.storage.getDirectory();
        const persistDir = await opfsRoot.getDirectoryHandle(
            "agex_persist",
            { create: true },
        );
        await pyodide.mountNativeFS("/persist", persistDir);

        // Cache-bust PyPI index for our own packages so version bumps
        // take effect immediately. Only applied to OWN_DEPS to avoid
        // breaking Pyodide's built-in resolution for compiled packages.
        const appVersion = new URL(self.location.href).searchParams.get("v") || "0";
        const freshIndex = `https://pypi.org/pypi/{package_name}/json?v=${appVersion}`;

        // Our PyPI packages need cache-busted index + version pinning,
        // so they go through micropip.install. Non-built-in vendors
        // piggyback on the same micropip pass.
        const ownInstallCalls = (own, vendor, extras) => [
            ...own.map(pkg => `micropip.install("${pkg}", index_urls="${freshIndex}")`),
            ...vendor.map(pkg => `micropip.install("${pkg}")`),
            ...extras,
        ];

        const wave2OwnCalls = ownInstallCalls(WAVE2_OWN, WAVE2_VENDOR_MICROPIP, [
            `micropip.install("icalendar", deps=False)`,
            `micropip.install("tabulate", deps=False)`,
            `micropip.install("termish>=0.1.5", deps=False, index_urls="${freshIndex}")`,
            `micropip.install("agex>=0.12.1", deps=False, index_urls="${freshIndex}")`,
        ]);
        const wave3OwnCalls = ownInstallCalls([], [], [
            `micropip.install("calgebra>=0.10.11", deps=False, index_urls="${freshIndex}")`,
        ]);

        // ── Wave 2: minimum needed for history + agent baseline ──
        //
        // Run pyodide.loadPackage (for Pyodide built-in vendors) and
        // micropip.install (for our PyPI packages) in parallel — they
        // use independent resolvers and don't contend for the same
        // dependency graph, so they overlap cleanly.
        progress("Installing core packages...", 0.2);
        await Promise.all([
            pyodide.loadPackage(WAVE2_VENDOR),
            pyodide.runPythonAsync(`
import micropip, asyncio
await asyncio.gather(${wave2OwnCalls.join(", ")})
            `),
        ]);

        progress("Verifying installation...", 0.55);
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
        pyodide.globals.set("_js_test_app", (appFilesJson, actionsJson, fresh) => {
            return new Promise((resolve) => {
                const id = ++_testAppId;
                testAppPending.set(id, resolve);
                self.postMessage({ type: "test-app", id, appFilesJson, actionsJson, fresh });
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

        // Register JS bridge for esbuild bundling.  Unlike test_app /
        // live_app / pdf bridges (which need DOM and round-trip to
        // the main thread), esbuild-wasm runs entirely inside the
        // worker — no postMessage ping-pong.  Lazy-imported so the
        // ~10MB wasm download only happens on first agent invocation.
        let _esbuildBridgePromise = null;
        const getEsbuildBridge = () => {
            if (!_esbuildBridgePromise) {
                _esbuildBridgePromise = import("/esbuild-bridge.js");
            }
            return _esbuildBridgePromise;
        };
        pyodide.globals.set(
            "_js_esbuild",
            async (filesJson, entryPoint, optionsJson) => {
                try {
                    const bridge = await getEsbuildBridge();
                    const files = JSON.parse(filesJson);
                    const options = optionsJson ? JSON.parse(optionsJson) : {};
                    const result = await bridge.runEsbuild({
                        files,
                        entryPoint,
                        ...options,
                    });
                    return JSON.stringify(result);
                } catch (err) {
                    // Surface bridge-level failures (CDN load error,
                    // JSON parse, etc.) as a structured error result
                    // rather than letting the exception escape to
                    // Python opaquely.
                    return JSON.stringify({
                        contents: null,
                        errors: [{ text: `esbuild bridge failed: ${err}` }],
                        warnings: [],
                    });
                }
            },
        );

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
        // (chunk/done/error); the main thread does a streaming fetch
        // and postMessages back chunks / done / error tagged with the
        // id. Python captures the returned id and must call
        // ``_js_llm_stream_cancel(id)`` before destroying the proxies,
        // so the main thread can abort the fetch and stop pushing
        // chunks at a callback that no longer has a consumer.
        const llmStreamFn = (requestJson, onChunk, onDone, onError) => {
            const id = ++_llmStreamId;
            llmStreamPending.set(id, { onChunk, onDone, onError });
            self.postMessage({ type: "llm-stream", id, requestJson });
            return id;
        };
        self._js_llm_stream = llmStreamFn;
        pyodide.globals.set("_js_llm_stream", llmStreamFn);

        // LLM stream cancellation. Idempotent. Removes the entry so
        // any in-flight chunk/done/error messages are dropped by the
        // dispatcher, and forwards the cancel to the main thread so
        // it aborts the underlying fetch.
        const llmStreamCancelFn = (id) => {
            if (!llmStreamPending.has(id)) return;
            llmStreamPending.delete(id);
            self.postMessage({ type: "llm-stream-cancel", id });
        };
        self._js_llm_stream_cancel = llmStreamCancelFn;
        pyodide.globals.set("_js_llm_stream_cancel", llmStreamCancelFn);

        // Wave 2 done — history is now reachable. Block here until the
        // main thread tells us to start Wave 3. Pyodide serializes
        // runPythonAsync calls, so running Wave 3 concurrently with
        // basics + history loading would just stall basics behind it.
        // The host kicks off Wave 3 only after basics + history have
        // landed, so users see chat as soon as Wave 2 is ready.
        progress("Loading session...", 0.7);
        self.postMessage({ type: "stage", stage: "history-ready" });
        await _wave3Started;

        // ── Wave 3: heavier capabilities ──
        // Same pattern as Wave 2: built-ins via loadPackage, own
        // packages via micropip, in parallel.
        progress("Installing additional capabilities...", 0.8);
        await Promise.all([
            pyodide.loadPackage(WAVE3_VENDOR),
            pyodide.runPythonAsync(`
await asyncio.gather(${wave3OwnCalls.join(", ")})
            `),
        ]);

        // Start periodic flush of /persist to OPFS. JS event-loop
        // semantics: setInterval callbacks fire at any await boundary,
        // including the awaits inside agex's async agent loop (LLM
        // calls, tool round-trips). So this fires DURING a long
        // run(), not just between runs — bounding mid-call data loss
        // on a surprise reload to ~PERSIST_FLUSH_INTERVAL_MS instead
        // of "everything since the last completed run()".
        //
        // The per-run flush in run() is still useful as a guaranteed
        // sync at the natural completion boundary; the two compose.
        if (_persistFlushTimer === null) {
            _persistFlushTimer = setInterval(flushPersist, PERSIST_FLUSH_INTERVAL_MS);
        }

        self.postMessage({ type: "ready" });
    } catch (e) {
        self.postMessage({ type: "init-error", message: e.message });
    }
}

// Periodic flush cadence. 1s is a tradeoff: tighter loses less data
// on reload but adds JS↔OPFS round-trips during quiet periods (cheap
// for a clean mirror but not free). 1s feels right for a chat-app
// agent where individual iterations take seconds to tens of seconds.
const PERSIST_FLUSH_INTERVAL_MS = 1000;
let _persistFlushTimer = null;
let _flushInFlight = null;
let _flushQueued = null;

// Emscripten's FS.syncfs takes a (populate, callback) signature and
// does not return a Promise — calling it without a callback throws
// "callback is not a function" from inside the OPFS backend's async
// completion, surfacing as an unhandled rejection that bypasses any
// try/catch around the call site.
function _syncfs() {
    return new Promise((resolve, reject) => {
        pyodide.FS.syncfs(false, (err) => (err ? reject(err) : resolve()));
    });
}

// Flush in-memory FS writes (under /persist, our OPFS mount) to the
// backing Origin Private File System. mountNativeFS buffers writes
// in an in-memory mirror and only persists when syncfs is called —
// without this, kvgit commits land in RAM and are lost on reload.
//
// Single-flight with at-most-one queued follow-up: the per-run flush
// in run() and the 1s setInterval tick can otherwise overlap, which
// Pyodide warns about ("2 FS.syncfs operations in flight"). Callers
// still get the guarantee they need — by the time their await
// resolves, a syncfs that started after their call has completed,
// so any writes dirty at call time are persisted.
//
// Best-effort: a failed syncfs logs and continues; the next call
// will retry against the same dirty mirror.
async function flushPersist() {
    if (!pyodide) return;
    if (_flushInFlight) {
        if (!_flushQueued) {
            _flushQueued = _flushInFlight.then(() => {
                _flushQueued = null;
                return _runFlush();
            });
        }
        return _flushQueued;
    }
    return _runFlush();
}

function _runFlush() {
    _flushInFlight = (async () => {
        try {
            await _syncfs();
        } catch (err) {
            console.error("[worker] FS.syncfs failed:", err);
        } finally {
            _flushInFlight = null;
        }
    })();
    return _flushInFlight;
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
        // Flush any kvgit writes from this turn out to OPFS before
        // signalling completion. Cheap when nothing changed.
        await flushPersist();
        self.postMessage({ type: "result", id, value });
    } catch (e) {
        // Flush even on error — partial commits that did fire should
        // still be preserved.
        await flushPersist();
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
    } else if (type === "start-wave3") {
        // Host signals "history is loaded; safe to install heavy
        // packages now without stalling basics."
        _startWave3?.();
    } else if (type === "write-downloaded-file") {
        // Drive imports (or any main-thread-fetched files) land here.
        // Main thread supplies bytes as a Uint8Array; we write them
        // into the VFS at the given path and acknowledge completion.
        if (pyodide) {
            (async () => {
                const { id, path, bytes } = e.data;
                try {
                    pyodide.globals.set("_dl_path", path);
                    pyodide.globals.set("_dl_bytes", bytes);
                    await pyodide.runPythonAsync(`
_fs = _agent.fs()
_bytes = bytes(_dl_bytes.to_py())
_fs.write(_dl_path, _bytes)
_state = _agent.state("default")
_state.commit()
del _dl_path, _dl_bytes, _bytes
                    `);
                    // Push the just-committed state to OPFS before
                    // signalling completion to the host.
                    await flushPersist();
                    self.postMessage({ type: "write-downloaded-file-result", id });
                } catch (err) {
                    self.postMessage({
                        type: "write-downloaded-file-result",
                        id,
                        error: err.message || String(err),
                    });
                }
            })();
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
