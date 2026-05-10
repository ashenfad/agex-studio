/**
 * Iframe control bridge — installed inside the app preview iframe.
 *
 * The parent (agex-studio) posts control messages to the iframe via
 * window.postMessage; this module dispatches them against the iframe's
 * own DOM and posts results back. Designed to work with
 * `sandbox="allow-scripts"` (opaque origin) where the parent cannot
 * reach into iframe.contentDocument directly.
 *
 * Factored as a pure module so each action dispatcher can be unit-tested
 * with happy-dom/jsdom; installControlBridge wires it to a window for
 * use in the iframe.
 */

let _htmlToImagePromise = null;
async function loadHtmlToImage() {
    // Use html-to-image (SVG foreignObject-based) rather than html2canvas.
    // html2canvas creates a render iframe internally, which under opaque-
    // origin sandbox gets a *different* opaque origin than ours and can't
    // be read back cross-origin. html-to-image serializes to an inline
    // SVG foreignObject embedded as a data URI — no iframes involved.
    if (!_htmlToImagePromise) {
        _htmlToImagePromise = import('https://esm.sh/html-to-image@1.11.11');
    }
    return _htmlToImagePromise;
}

/**
 * Render a DOM target to a base64 PNG.
 * @param {Document} doc
 * @param {string|null} selector
 * @returns {Promise<string>} base64-encoded PNG (no data URI prefix)
 */
async function captureScreenshot(doc, selector) {
    const { toPng } = await loadHtmlToImage();
    const target = selector ? doc.querySelector(selector) : doc.body;
    if (!target) throw new Error(`Screenshot target not found: ${selector}`);

    const dataUrl = await toPng(target, { cacheBust: true });
    return dataUrl.replace(/^data:image\/png;base64,/, '');
}

/**
 * Dispatch a single action against the document.
 *
 * Return-value contract matches the pre-refactor `executeActions`
 * output shape: `null` for actions that produce no result entry
 * (click/type/select), an object with a `type` field for actions that
 * do (read/eval/screenshot/get-logs).
 *
 * @param {Document} doc
 * @param {object} action
 * @param {Window} [global] - scope for eval and log reads; defaults to globalThis
 * @returns {Promise<object|null>}
 */
export async function dispatchAction(doc, action, global) {
    const scope = global || globalThis;

    if (action.click) {
        const el = doc.querySelector(action.click);
        if (el) el.click();
        return null;
    }
    if (action.type) {
        const el = doc.querySelector(action.type);
        if (el) {
            el.value = action.value || '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return null;
    }
    if (action.select) {
        const el = doc.querySelector(action.select);
        if (el) {
            el.value = action.value || '';
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return null;
    }
    if (action.read) {
        const el = doc.querySelector(action.read);
        const prop = action.prop || 'textContent';
        return {
            type: 'read',
            selector: action.read,
            value: el ? String(el[prop] ?? '') : null,
        };
    }
    if (action.eval) {
        try {
            // Indirect eval runs in global scope, seeing app-level bindings
            const val = scope.eval(action.eval);
            return {
                type: 'eval',
                expr: action.eval,
                // JSON-encode the value (always, even primitives) so the
                // Python side can parse and route through reprobate for
                // budget-bounded rendering.  Replacer handles common
                // non-JSON-friendly cases (circular refs, DOM nodes,
                // functions, Dates) without throwing.
                value: _jsonifyEvalResult(val),
            };
        } catch (e) {
            return {
                type: 'eval',
                expr: action.eval,
                value: null,
                error: e.message,
            };
        }
    }
    if (action.assert !== undefined) {
        // One-shot test pattern: evaluate the expression as a JS
        // truthy/falsy check.
        //   - Pass (truthy) → return null so the action surfaces no
        //     entry in the results array. Keeps the array clean for
        //     "verify before taskSuccess" flows where the agent only
        //     cares about failures.
        //   - Fail (falsy or threw) → return an error-level log entry
        //     containing the expression, the actual value (for
        //     diagnostic), and the optional `message`. Agent picks
        //     these out via `results.filter(r => r.level === 'error')`.
        const tag = action.message ? `${action.message} — ` : '';
        try {
            const val = scope.eval(action.assert);
            if (val) return null; // pass — silent
            return {
                type: 'log',
                level: 'error',
                message: `${tag}Assertion failed: ${action.assert} (got ${_jsonifyEvalResult(val)})`,
            };
        } catch (e) {
            return {
                type: 'log',
                level: 'error',
                message: `${tag}Assertion threw: ${action.assert} → ${e.message}`,
            };
        }
    }
    if (action.screenshot !== undefined) {
        const selector = typeof action.screenshot === 'string' ? action.screenshot : null;
        try {
            const data = await captureScreenshot(doc, selector);
            return { type: 'screenshot', data };
        } catch (e) {
            return {
                type: 'log', level: 'error',
                message: `Screenshot failed: ${e.message}`,
            };
        }
    }
    if (action['get-logs']) {
        return { type: 'logs', logs: scope.__agex_logs || [] };
    }

    throw new Error(`Unknown action: ${JSON.stringify(action)}`);
}

/**
 * JSON-encode an eval result.  Returns a string (parseable JSON) or
 * null for null/undefined.  Replacer compactly represents DOM nodes
 * and functions, drops circular refs, and serializes Dates as ISO
 * strings — anything else is left to JSON.stringify's defaults.
 *
 * Always JSON-encoded (even primitives) so the Python side can
 * uniformly JSON.parse and render through reprobate.
 * @param {*} val
 * @returns {string|null}
 */
function _jsonifyEvalResult(val) {
    if (val === null || val === undefined) return null;
    const seen = new WeakSet();
    try {
        return JSON.stringify(val, (key, v) => {
            if (typeof v === "function") {
                return `[function ${v.name || "anonymous"}]`;
            }
            if (v && typeof v === "object") {
                if (seen.has(v)) return "[Circular]";
                seen.add(v);
                if (typeof Element !== "undefined" && v instanceof Element) {
                    const id = v.id ? `#${v.id}` : "";
                    const cls = v.className && typeof v.className === "string"
                        ? `.${v.className.split(/\s+/).filter(Boolean).join(".")}`
                        : "";
                    return `<${v.tagName.toLowerCase()}${id}${cls}>`;
                }
                if (typeof Node !== "undefined" && v instanceof Node) {
                    return `[${v.constructor.name}]`;
                }
                if (v instanceof Date) return v.toISOString();
            }
            return v;
        });
    } catch (e) {
        return JSON.stringify(`[unserializable: ${e.message || e}]`);
    }
}

/**
 * Handle an incoming control message. Returns the response payload,
 * or null if the message wasn't addressed to us.
 * @param {Document} doc
 * @param {object} message
 * @param {Window} [global]
 * @returns {Promise<object|null>}
 */
export async function handleControlMessage(doc, message, global) {
    if (message?.type !== 'agex-control') return null;
    const { id, action } = message;
    try {
        const data = await dispatchAction(doc, action, global);
        return { type: 'agex-control-result', id, data, error: null };
    } catch (e) {
        return {
            type: 'agex-control-result',
            id,
            data: null,
            error: e.message || String(e),
        };
    }
}

/**
 * Install the control bridge on a window. Listens for 'agex-control'
 * messages and posts responses back to event.source.
 *
 * Idempotent — calling twice on the same window installs only once.
 *
 * @param {Window} win
 */
export function installControlBridge(win) {
    if (win.__agex_bridge_installed) return;
    win.__agex_bridge_installed = true;
    win.addEventListener('message', async (event) => {
        const response = await handleControlMessage(win.document, event.data, win);
        if (!response) return;
        event.source?.postMessage(response, '*');
    });
}

// ---------------------------------------------------------------------------
// Parent side: sendControl — post an action to an iframe and await its result.
// ---------------------------------------------------------------------------

let _controlIdCounter = 0;

/**
 * Send a control action to an iframe and await the response.
 *
 * Parent-side counterpart to installControlBridge. The iframe must have
 * the bridge installed (via AGENT_CONTROL_BRIDGE_SCRIPT) for this to
 * resolve.
 *
 * Resolves with the action's data payload (may be `null` for
 * click/type/select which produce no result entry). Rejects on error
 * responses from the bridge (unknown action shape, etc.). Does NOT
 * reject on sub-errors captured into the data payload itself (e.g., an
 * eval that threw — that's returned as `data.error`).
 *
 * Does not validate `event.origin` — opaque-origin iframes post with
 * `origin === 'null'`. Identity check on `event.source` is sufficient
 * to ensure the response came from the expected iframe.
 *
 * @param {HTMLIFrameElement | {contentWindow: any}} iframe
 * @param {object} action
 * @returns {Promise<any>}
 */
export function sendControl(iframe, action) {
    const id = `ctrl-${++_controlIdCounter}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve, reject) => {
        function handler(event) {
            if (event.source !== iframe.contentWindow) return;
            const data = event.data;
            if (data?.type !== 'agex-control-result' || data.id !== id) return;
            window.removeEventListener('message', handler);
            if (data.error) {
                reject(new Error(data.error));
            } else {
                resolve(data.data);
            }
        }
        window.addEventListener('message', handler);
        iframe.contentWindow?.postMessage(
            { type: 'agex-control', id, action },
            '*',
        );
    });
}
