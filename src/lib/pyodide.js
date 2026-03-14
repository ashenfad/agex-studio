/**
 * Pyodide Web Worker bridge.
 *
 * Spawns a Web Worker that runs Pyodide off the main thread.
 * Exposes a reactive store for loading state and a runPython() function
 * for executing Python code.
 */

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
 * @property {string} message
 * @property {number} progress - 0 to 1
 */

/** @type {LoadingState} */
let state = {
    status: "idle",
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

    update({ status: "loading", message: "Starting worker...", progress: 0 });

    worker = new Worker(`/worker.js?v=${__APP_VERSION__}`);

    worker.onmessage = (e) => {
        const msg = e.data;

        if (msg.type === "progress") {
            update({ message: msg.message, progress: msg.progress });
        } else if (msg.type === "ready") {
            update({ status: "ready", message: "Ready", progress: 1 });
        } else if (msg.type === "init-error") {
            update({ status: "error", message: `Failed: ${msg.message}` });
        } else if (msg.type === "result") {
            const p = pending.get(msg.id);
            if (p) {
                pending.delete(msg.id);
                p.resolve(msg.value);
            }
        } else if (msg.type === "run-error") {
            const p = pending.get(msg.id);
            if (p) {
                pending.delete(msg.id);
                p.reject(new Error(msg.message));
            }
        } else if (msg.type === "token") {
            const p = pending.get(msg.id);
            if (p?.onToken) p.onToken(JSON.parse(msg.json));
        } else if (msg.type === "plotly-render") {
            renderPlotlyOffscreen(msg.figureJson, msg.id);
        } else if (msg.type === "test-app") {
            runTestApp(msg.appFilesJson, msg.actionsJson, msg.id);
        } else if (msg.type === "live-app") {
            runLiveApp(msg.actionsJson, msg.id);
        }
    };

    worker.onerror = (e) => {
        update({ status: "error", message: `Worker error: ${e.message}` });
    };

    worker.postMessage({ type: "init" });
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

/** @type {HTMLIFrameElement | null} */
let liveIframe = null;

/**
 * Register the live preview iframe for live_app().
 * Called by AppPreview.svelte when the iframe is mounted.
 * @param {HTMLIFrameElement | null} iframe
 */
export function setLiveIframe(iframe) {
    liveIframe = iframe;
}

// Console interceptor script — injected into both test and live iframes.
// Captures console.log/warn/error, window.onerror, unhandled rejections.
export const CONSOLE_INTERCEPTOR = `
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
})();
<\/script>`;

export const QUERY_BRIDGE_SCRIPT = `
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
<\/script>`;

const CDN_IMPORTS = {
    "preact": "https://esm.sh/preact@10.25.4",
    "preact/": "https://esm.sh/preact@10.25.4/",
    "htm": "https://esm.sh/htm@3.1.1",
};

const PLOTLY_SCRIPT = `<script src="https://cdn.plot.ly/plotly-2.35.2.min.js"><\/script>`;

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
 * Rewrite local relative import/export specifiers in JS code to use bare
 * prefixed specifiers that resolve via the import map.
 *
 * ./foo.js  → __app/foo.js
 * ./components/Bar.js → __app/components/Bar.js
 *
 * Only rewrites specifiers whose target file exists in knownFiles.
 *
 * @param {string} code - JS source code
 * @param {Set<string>} knownFiles - set of relative paths (e.g. "App.js", "utils/helpers.js")
 * @returns {string} rewritten code
 */
export function _rewriteLocalImports(code, knownFiles) {
    // Static import/export-from: import ... from './foo.js'  /  export ... from './foo.js'
    code = code.replace(
        /((?:import|export)\s(?:[^'"]*?\s)?from\s*|import\s*)(['"])(\.\/([^'"]+))\2/g,
        (match, before, quote, _specifier, relative) => {
            if (knownFiles.has(relative)) {
                return `${before}${quote}${APP_MODULE_PREFIX}${relative}${quote}`;
            }
            return match;
        },
    );
    // Dynamic import: import('./foo.js')
    code = code.replace(
        /import\s*\(\s*(['"])(\.\/([^'"]+))\1\s*\)/g,
        (match, quote, _specifier, relative) => {
            if (knownFiles.has(relative)) {
                return `import(${quote}${APP_MODULE_PREFIX}${relative}${quote})`;
            }
            return match;
        },
    );
    return code;
}

/**
 * Collect JS and CSS files from appFiles, build an import map with data URIs,
 * and inline CSS/script-src references in the HTML.
 *
 * @param {Record<string, string>} appFiles
 * @param {string} html - the index.html content
 * @returns {{ html: string, importMap: Record<string, string> }}
 */
function _resolveAppModules(appFiles, html) {
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

    // Inline CSS: <link ... href="./style.css"> → <style>contents</style>
    for (const [name, content] of cssFiles) {
        const pattern = new RegExp(
            `<link[^>]*href=["']\\./${_escapeRegex(name)}["'][^>]*/?>`,
            'g',
        );
        html = html.replace(pattern, `<style>${content}</style>`);
    }

    // Build import map entries for JS files
    const appImports = {};
    const knownFiles = new Set(jsFiles.keys());

    if (knownFiles.size > 0) {
        for (const [name, content] of jsFiles) {
            const rewritten = _rewriteLocalImports(content, knownFiles);
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
 * @returns {string} complete HTML document
 */
export function buildAppHtml(appFiles) {
    let html = appFiles['app/index.html'] || appFiles['index.html'];
    if (html) {
        // Resolve multi-file references (JS import map, CSS inlining)
        const resolved = _resolveAppModules(appFiles, html);
        html = resolved.html;
        const importMapTag = _buildImportMapTag(resolved.importMap);
        const cdnScripts = importMapTag + '\n' + PLOTLY_SCRIPT;

        if (!html.includes('agex-query')) {
            html = html.replace('<head>', '<head>' + CONSOLE_INTERCEPTOR + QUERY_BRIDGE_SCRIPT + cdnScripts);
            if (!html.includes('<head>')) {
                html = CONSOLE_INTERCEPTOR + QUERY_BRIDGE_SCRIPT + cdnScripts + html;
            }
        } else {
            html = html.replace('<head>', '<head>' + CONSOLE_INTERCEPTOR);
            if (!html.includes('<head>')) {
                html = CONSOLE_INTERCEPTOR + html;
            }
        }
    } else {
        const mainJs = appFiles['app/main.js'] || appFiles['main.js'] || '';
        const importMapTag = _buildImportMapTag({});
        html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
${CONSOLE_INTERCEPTOR}
${QUERY_BRIDGE_SCRIPT}
${importMapTag}
${PLOTLY_SCRIPT}
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
 * Wait for an iframe to become idle (no pending queries for 2s).
 * @param {HTMLIFrameElement} iframe
 * @param {number} maxMs
 */
function waitForIdle(iframe, maxMs = 15000) {
    return new Promise((resolve) => {
        let idleTimer = null;
        let maxTimer = setTimeout(() => {
            clearTimeout(idleTimer);
            resolve();
        }, maxMs);

        function resetIdle() {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
                clearTimeout(maxTimer);
                resolve();
            }, 2000);
        }

        iframe.__onQueryDone = () => resetIdle();
        resetIdle();
    });
}

/**
 * Execute actions against an iframe and collect results.
 * Shared by runTestApp and runLiveApp.
 *
 * @param {HTMLIFrameElement} iframe
 * @param {Array<object>} actions
 * @returns {Promise<Array<object>>} action results (read/eval entries)
 */
async function executeActions(iframe, actions) {
    const results = [];
    for (const action of actions) {
        const doc = iframe.contentDocument;
        if (action.click) {
            const el = doc.querySelector(action.click);
            if (el) el.click();
        } else if (action.type) {
            const el = doc.querySelector(action.type);
            if (el) {
                el.value = action.value || '';
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }
        } else if (action.select) {
            const el = doc.querySelector(action.select);
            if (el) {
                el.value = action.value || '';
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }
        } else if (action.wait) {
            await new Promise(r => setTimeout(r, action.wait));
        } else if (action.read) {
            const el = doc.querySelector(action.read);
            const prop = action.prop || 'textContent';
            results.push({
                type: 'read',
                selector: action.read,
                value: el ? String(el[prop] ?? '') : null,
            });
        } else if (action.eval) {
            try {
                const val = iframe.contentWindow.eval(action.eval);
                results.push({
                    type: 'eval',
                    expr: action.eval,
                    value: val != null ? String(val) : null,
                });
            } catch (e) {
                results.push({
                    type: 'eval',
                    expr: action.eval,
                    value: null,
                    error: e.message,
                });
            }
        }
        // Wait for any triggered queries/effects to settle
        await waitForIdle(iframe, 10000);
    }
    return results;
}

/**
 * Collect console logs and action results from an iframe.
 * @param {HTMLIFrameElement} iframe
 * @param {Array<object>} actionResults
 * @returns {Array<object>}
 */
function collectResults(iframe, actionResults) {
    let logs = [];
    try {
        logs = (iframe.contentWindow.__agex_logs || []).map(
            (e) => ({ type: 'log', level: e.level, message: e.message })
        );
    } catch { /* ignore */ }
    return [...logs, ...actionResults].slice(0, 200);
}

/**
 * Run a headless app test: build a hidden iframe, optionally interact,
 * and collect console output + action results.
 */
async function runTestApp(appFilesJson, actionsJson, requestId) {
    let iframe = null;
    let blobUrl = null;
    let messageHandler = null;

    try {
        const appFiles = JSON.parse(appFilesJson);
        const actions = actionsJson ? JSON.parse(actionsJson) : [];

        const html = buildAppHtml(appFiles);
        blobUrl = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
        iframe = document.createElement('iframe');
        iframe.style.cssText = 'position:absolute;left:-9999px;width:800px;height:600px;';
        iframe.sandbox = 'allow-scripts allow-same-origin';

        // Handle query() messages from the test iframe
        messageHandler = async (event) => {
            if (!iframe || event.source !== iframe.contentWindow) return;
            if (event.data?.type === 'agex-query') {
                const { id, code, result } = event.data;
                try {
                    const data = queryHandler ? await queryHandler(code, result) : {};
                    iframe.contentWindow.postMessage(
                        { type: 'agex-query-result', id, data, error: null }, '*');
                } catch (err) {
                    iframe.contentWindow.postMessage(
                        { type: 'agex-query-result', id, data: null,
                          error: err.message || String(err) }, '*');
                }
                iframe.__onQueryDone?.();
            }
        };
        window.addEventListener('message', messageHandler);

        // Load and wait for initial idle
        await new Promise((resolve) => {
            iframe.onload = resolve;
            iframe.src = blobUrl;
            document.body.appendChild(iframe);
        });
        await waitForIdle(iframe);

        const actionResults = await executeActions(iframe, actions);
        const results = collectResults(iframe, actionResults);

        worker.postMessage({
            type: 'test-app-result', id: requestId,
            resultsJson: JSON.stringify(results),
        });
    } catch (e) {
        worker.postMessage({
            type: 'test-app-result', id: requestId,
            resultsJson: JSON.stringify([{ type: 'log', level: 'error', message: 'test_app failed: ' + e.message }]),
        });
    } finally {
        if (messageHandler) window.removeEventListener('message', messageHandler);
        if (iframe) iframe.remove();
        if (blobUrl) URL.revokeObjectURL(blobUrl);
    }
}

/**
 * Interact with the live preview iframe and collect results.
 */
async function runLiveApp(actionsJson, requestId) {
    try {
        if (!liveIframe || !liveIframe.contentWindow) {
            worker.postMessage({
                type: 'live-app-result', id: requestId,
                resultsJson: JSON.stringify([{ type: 'log', level: 'error', message: 'No live app preview is active' }]),
            });
            return;
        }

        const actions = actionsJson ? JSON.parse(actionsJson) : [];
        const actionResults = await executeActions(liveIframe, actions);
        const results = collectResults(liveIframe, actionResults);

        worker.postMessage({
            type: 'live-app-result', id: requestId,
            resultsJson: JSON.stringify(results),
        });
    } catch (e) {
        worker.postMessage({
            type: 'live-app-result', id: requestId,
            resultsJson: JSON.stringify([{ type: 'log', level: 'error', message: 'live_app failed: ' + e.message }]),
        });
    }
}

/**
 * Push a Google access token to the Pyodide worker.
 * Called by google-auth.js when the token changes or is revoked.
 * @param {string|null} token
 */
export function setGoogleToken(token) {
    if (!worker || state.status !== "ready") return;
    worker.postMessage({ type: "set-google-token", token });
}

/**
 * Run Python code in the worker and return the result.
 *
 * @param {string} code - Python code to execute
 * @returns {Promise<string | null>}
 */
export function runPython(code) {
    if (!worker || state.status !== "ready") {
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
    if (!worker || state.status !== "ready") {
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
