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

let _html2canvasPromise = null;
async function loadHtml2Canvas() {
    if (!_html2canvasPromise) {
        _html2canvasPromise = import('https://esm.sh/html2canvas@1.4.1').then(m => m.default);
    }
    return _html2canvasPromise;
}

/**
 * Render a DOM target to a base64 PNG. Handles bare <svg> targets by
 * wrapping them in a temporary <div> (html2canvas can't render raw SVG).
 * @param {Document} doc
 * @param {string|null} selector
 * @returns {Promise<string>} base64-encoded PNG (no data URI prefix)
 */
async function captureScreenshot(doc, selector) {
    const html2canvas = await loadHtml2Canvas();
    let target = selector ? doc.querySelector(selector) : doc.body;
    if (!target) throw new Error(`Screenshot target not found: ${selector}`);

    let wrapper = null;
    if (target.tagName === 'svg' || target.tagName === 'SVG') {
        wrapper = doc.createElement('div');
        target.parentNode.insertBefore(wrapper, target);
        wrapper.appendChild(target);
        target = wrapper;
    }

    try {
        const canvas = await html2canvas(target, { useCORS: true, logging: false });
        return canvas.toDataURL('image/png').replace('data:image/png;base64,', '');
    } finally {
        if (wrapper) {
            wrapper.parentNode.insertBefore(wrapper.firstChild, wrapper);
            wrapper.remove();
        }
    }
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
                value: val != null ? String(val) : null,
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
