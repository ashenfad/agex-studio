/**
 * Pyodide Web Worker.
 *
 * Runs Pyodide off the main thread. Communicates via postMessage:
 *
 * Main → Worker:
 *   { type: 'init' }                      — load Pyodide and install packages
 *   { type: 'run', id, code }            — execute Python code
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

const AGEX_DEPS = [
    "kvgit>=0.1.7",
    "monkeyfs>=0.1.4",
    "reprobate>=0.1.1",
    "sandtrap>=0.1.8",
    "termish>=0.1.3",
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

        const total = AGEX_DEPS.length + 3;
        for (let i = 0; i < AGEX_DEPS.length; i++) {
            const pkg = AGEX_DEPS[i];
            progress(`Installing ${pkg}...`, 0.15 + (0.8 * i) / total);
            await pyodide.runPythonAsync(`
import micropip
await micropip.install("${pkg}")
            `);
        }

        // Install icalendar with deps=False — its deps (python-dateutil, tzdata)
        // are already satisfied above or bundled with Pyodide.
        progress("Installing icalendar...", 0.15 + (0.8 * AGEX_DEPS.length) / total);
        await pyodide.runPythonAsync(`
import micropip
await micropip.install("icalendar", deps=False)
        `);

        // Install agex and calgebra last (deps already satisfied above)
        progress("Installing agex...", 0.15 + (0.8 * (AGEX_DEPS.length + 1)) / total);
        await pyodide.runPythonAsync(`
import micropip
await micropip.install("agex>=0.9.1", deps=False)
        `);

        progress("Installing calgebra...", 0.15 + (0.8 * (AGEX_DEPS.length + 2)) / total);
        await pyodide.runPythonAsync(`
import micropip
await micropip.install("calgebra>=0.10.8", deps=False)
        `);

        progress("Verifying installation...", 0.95);
        await pyodide.runPythonAsync("import agex");

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
