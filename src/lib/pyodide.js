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
import { sendControl } from './iframe-bridge.js';

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

const PDFJS_CDN = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build";

/**
 * Ensure pdf.js is loaded (lazily, once).
 */
async function ensurePdfJs() {
    if (window.pdfjsLib) return;
    const mod = await import(/* @vite-ignore */ `${PDFJS_CDN}/pdf.min.mjs`);
    window.pdfjsLib = mod;
    mod.GlobalWorkerOptions.workerSrc = `${PDFJS_CDN}/pdf.worker.min.mjs`;
}

/**
 * Render PDF pages to base64 PNGs using pdf.js.
 */
async function renderPdfPages(pdfBase64, pagesJson, scale, requestId) {
    try {
        await ensurePdfJs();

        const pdfData = Uint8Array.from(atob(pdfBase64), (c) => c.charCodeAt(0));
        const pdf = await window.pdfjsLib.getDocument({ data: pdfData }).promise;

        const pages = pagesJson ? JSON.parse(pagesJson) : null;
        const pageNums = pages || Array.from({ length: Math.min(pdf.numPages, 20) }, (_, i) => i);

        const results = [];
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");

        for (const pageIdx of pageNums) {
            if (pageIdx < 0 || pageIdx >= pdf.numPages) {
                results.push(null);
                continue;
            }
            const page = await pdf.getPage(pageIdx + 1); // pdf.js is 1-indexed
            const viewport = page.getViewport({ scale: scale || 2 });
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            await page.render({ canvasContext: ctx, viewport }).promise;
            const dataUrl = canvas.toDataURL("image/png");
            results.push(dataUrl.split(",")[1]);
        }

        canvas.remove();
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
 * Get PDF page count using pdf.js.
 */
async function getPdfPageCount(pdfBase64, requestId) {
    try {
        await ensurePdfJs();

        const pdfData = Uint8Array.from(atob(pdfBase64), (c) => c.charCodeAt(0));
        const pdf = await window.pdfjsLib.getDocument({ data: pdfData }).promise;

        worker.postMessage({
            type: "pdf-rendered",
            id: requestId,
            pagesJson: JSON.stringify(pdf.numPages),
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

// Agent control bridge — receives postMessage action commands from the
// parent (click/type/read/eval/screenshot/get-logs) and dispatches them
// against the iframe's own DOM. Required so executeActions/collectResults
// work when the iframe has an opaque origin (sandbox without
// allow-same-origin). The dispatch logic lives in ./iframe-bridge.js;
// this is just the inline-module shim that imports it by text and wires
// to the iframe's window.
export const AGENT_CONTROL_BRIDGE_SCRIPT = `
<script type="module">
${_iframeBridgeSource}
installControlBridge(window);
<\/script>`;

const CDN_IMPORTS = {
    "preact": "https://esm.sh/preact@10.25.4",
    "preact/": "https://esm.sh/preact@10.25.4/",
    "htm": "https://esm.sh/htm@3.1.1",
    "marked": "https://esm.sh/marked@17.0.4",
    "dayjs": "https://esm.sh/dayjs@1.11.20",
    "dayjs/": "https://esm.sh/dayjs@1.11.20/",
    "dompurify": "https://esm.sh/dompurify@3.3.3",
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
            const injected = CONSOLE_INTERCEPTOR + QUERY_BRIDGE_SCRIPT + AGENT_CONTROL_BRIDGE_SCRIPT + cdnScripts;
            html = html.replace('<head>', '<head>' + injected);
            if (!html.includes('<head>')) {
                html = injected + html;
            }
        } else {
            // HTML already includes the query bridge (pre-built bundle);
            // still inject the console interceptor and control bridge so
            // test_app / live_app work.
            const injected = CONSOLE_INTERCEPTOR + AGENT_CONTROL_BRIDGE_SCRIPT;
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
${QUERY_BRIDGE_SCRIPT}
${AGENT_CONTROL_BRIDGE_SCRIPT}
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
 * Action dispatch happens inside the iframe via the control bridge
 * (see iframe-bridge.js). This avoids reaching into iframe.contentDocument
 * from the parent, which would fail once the iframe has an opaque origin.
 *
 * @param {HTMLIFrameElement} iframe
 * @param {Array<object>} actions
 * @returns {Promise<Array<object>>} action results (read/eval/screenshot entries)
 */
async function executeActions(iframe, actions) {
    const results = [];
    for (const action of actions) {
        if (action.wait) {
            // Pure parent-side delay; no bridge call needed
            await new Promise(r => setTimeout(r, action.wait));
        } else {
            try {
                const data = await sendControl(iframe, action);
                if (data != null) {
                    results.push(data);
                }
            } catch (e) {
                // Bridge-level errors (unknown action, bridge not installed,
                // etc.) surface here. Sub-errors (eval that threw,
                // screenshot target missing) are captured into the data
                // payload by dispatchAction and resolve normally.
                results.push({
                    type: 'log', level: 'error',
                    message: `Action failed: ${e.message}`,
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
 * Logs are fetched from inside the iframe via the control bridge.
 *
 * @param {HTMLIFrameElement} iframe
 * @param {Array<object>} actionResults
 * @returns {Promise<Array<object>>}
 */
async function collectResults(iframe, actionResults) {
    let logs = [];
    try {
        const data = await sendControl(iframe, { 'get-logs': true });
        logs = (data?.logs || []).map(
            (e) => ({ type: 'log', level: e.level, message: e.message })
        );
    } catch { /* ignore — collecting logs is best-effort */ }
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
    // Promises for currently-running query handler invocations. The
    // handler is an async arrow fired by a synchronous event listener,
    // so the awaits inside it can outlive the executeActions loop. We
    // drain this list before teardown so in-flight responses don't try
    // to postMessage to a detached iframe.
    let pendingHandlers = [];

    try {
        const appFiles = JSON.parse(appFilesJson);
        const actions = actionsJson ? JSON.parse(actionsJson) : [];

        const html = buildAppHtml(appFiles);
        blobUrl = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
        iframe = document.createElement('iframe');
        iframe.style.cssText = 'position:absolute;left:-9999px;width:800px;height:600px;';
        iframe.sandbox = 'allow-scripts allow-same-origin';

        // Handle query() messages from the test iframe
        messageHandler = (event) => {
            if (!iframe || event.source !== iframe.contentWindow) return;
            if (event.data?.type !== 'agex-query') return;
            const { id, code, result } = event.data;
            const p = (async () => {
                try {
                    const data = queryHandler ? await queryHandler(code, result) : {};
                    iframe.contentWindow?.postMessage(
                        { type: 'agex-query-result', id, data, error: null }, '*');
                } catch (err) {
                    iframe.contentWindow?.postMessage(
                        { type: 'agex-query-result', id, data: null,
                          error: err.message || String(err) }, '*');
                }
                iframe.__onQueryDone?.();
            })();
            pendingHandlers.push(p);
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

        // Drain any query handler promises that were spawned by the
        // actions but haven't resolved yet (e.g. a long-running chunk
        // generation kicked off by the final click). Handlers added
        // while we're awaiting get picked up by the loop.
        while (pendingHandlers.length > 0) {
            const batch = pendingHandlers;
            pendingHandlers = [];
            await Promise.allSettled(batch);
        }

        const results = await collectResults(iframe, actionResults);

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
        const results = await collectResults(liveIframe, actionResults);

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
 * Push picked Google Drive files to the Pyodide worker.
 * Updates the /drive/ virtual filesystem mount.
 * @param {Array<{id: string, name: string, mimeType: string}>} files
 */
export function setDriveFiles(files) {
    if (!worker || state.status !== "ready") return;
    worker.postMessage({ type: "set-drive-files", files });
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
