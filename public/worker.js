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
 *
 * Worker → Main:
 *   { type: 'progress', message, progress } — loading progress (0–1)
 *   { type: 'ready' }                      — Pyodide loaded, packages installed
 *   { type: 'init-error', message }        — loading failed
 *   { type: 'result', id, value }          — Python code result
 *   { type: 'run-error', id, message }     — Python code error
 *   { type: 'token', id, token }           — streaming token during run
 */

const PYODIDE_CDN = "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/";

// Our packages — cache-busted so version bumps take effect immediately
const OWN_DEPS = [
    "kvgit>=0.1.7",
    "monkeyfs>=0.1.4",
    "reprobate>=0.1.1",
    "sandtrap>=0.1.10",
    "termish>=0.1.3",
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

        progress("Installing packages...", 0.15);
        await pyodide.loadPackage("micropip");

        // Cache-bust PyPI index for our own packages so version bumps
        // take effect immediately. Only applied to OWN_DEPS to avoid
        // breaking Pyodide's built-in resolution for compiled packages.
        const appVersion = new URL(self.location.href).searchParams.get("v") || "0";
        const freshIndex = `https://pypi.org/pypi/{package_name}/json?v=${appVersion}`;

        const allDeps = [...OWN_DEPS, ...VENDOR_DEPS];
        const total = allDeps.length + 3;
        for (let i = 0; i < allDeps.length; i++) {
            const pkg = allDeps[i];
            const isOwn = i < OWN_DEPS.length;
            progress(`Installing ${pkg}...`, 0.15 + (0.8 * i) / total);
            await pyodide.runPythonAsync(`
import micropip
await micropip.install("${pkg}"${isOwn ? `, index_urls="${freshIndex}"` : ""})
            `);
        }

        // Install icalendar with deps=False — its deps (python-dateutil, tzdata)
        // are already satisfied above or bundled with Pyodide.
        progress("Installing icalendar...", 0.15 + (0.8 * allDeps.length) / total);
        await pyodide.runPythonAsync(`
import micropip
await micropip.install("icalendar", deps=False, index_urls="${freshIndex}")
        `);

        // Install agex and calgebra last (deps already satisfied above)
        progress("Installing agex...", 0.15 + (0.8 * (allDeps.length + 1)) / total);
        await pyodide.runPythonAsync(`
import micropip
await micropip.install("agex>=0.9.1", deps=False, index_urls="${freshIndex}")
        `);

        progress("Installing calgebra...", 0.15 + (0.8 * (allDeps.length + 2)) / total);
        await pyodide.runPythonAsync(`
import micropip
await micropip.install("calgebra>=0.10.8", deps=False, index_urls="${freshIndex}")
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
        let _plotlyRenderId = 0;
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

// Pending test-app requests: id → resolve function
const testAppPending = new Map();
let _testAppId = 0;

// Pending live-app requests: id → resolve function
const liveAppPending = new Map();
let _liveAppId = 0;

self.onmessage = (e) => {
    const { type } = e.data;
    if (type === "init") {
        init();
    } else if (type === "set-google-token") {
        if (pyodide) {
            const val = e.data.token ? `"${e.data.token}"` : "None";
            pyodide.runPython(`_google_access_token = ${val}`);
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
    }
};
