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

/** Per-value cap for action results that flow back into the agent's
 *  context. The iframe can produce arbitrarily large strings via
 *  eval (`Array.from(document.scripts).map(s => s.src)` returns
 *  data-URI-laden values when JS is inlined via the import map)
 *  and read (`outerHTML` of a big subtree, `<style>` body, etc.).
 *  Without a cap, one action's payload can blow past the LLM's
 *  context window in a single turn. 50 KB is generous for honest
 *  debug data, tight enough that pathological dumps trip the
 *  truncation notice. */
const MAX_VALUE_BYTES = 50_000;

/** Cap an already-serialized JSON string by replacing it with a
 *  fresh JSON-encoded notice when over the limit. Returning a
 *  string-typed JSON keeps callers' `JSON.parse` working — they
 *  see the notice as a string value instead of the original
 *  structure. The notice carries the original size so the agent
 *  can adapt their next eval (filter columns, slice arrays, etc.). */
function _truncationNotice(originalJson, max) {
    return (
        `[truncated: eval/read value was ${originalJson.length} bytes ` +
        `(cap ${max}). First ${max} bytes: ${originalJson.slice(0, max)}]`
    );
}

/** Same idea, but for raw strings — used by read-action's
 *  property readbacks which aren't JSON-serialized. */
function _capString(s, max) {
    if (s.length <= max) return s;
    return `[truncated: read value was ${s.length} bytes (cap ${max}). ` +
        `First ${max} bytes: ${s.slice(0, max)}]`;
}

let _htmlToImagePromise = null;
async function loadHtmlToImage() {
    // Use html-to-image (SVG foreignObject-based) rather than html2canvas.
    // html2canvas creates a render iframe internally, which under opaque-
    // origin sandbox gets a *different* opaque origin than ours and can't
    // be read back cross-origin. html-to-image serializes to an inline
    // SVG foreignObject embedded as a data URI — no iframes involved.
    //
    // Loaded from a vendored copy in agex-studio-apps rather than
    // esm.sh. Two reasons: (1) verification can't depend on a CDN
    // that's transiently unavailable — agents reach for screenshot
    // _to diagnose_ failures, so the dependency being available is
    // load-bearing for the feature; (2) the relative path resolves
    // against the iframe's apps-origin location (apps.agex.studio
    // in prod, localhost:5174 in dev) — same-origin, no CORS.
    if (!_htmlToImagePromise) {
        // Indirect through a local binding so Vite's static analysis
        // can't resolve the import at build/test time — the path
        // exists at the apps-origin runtime (apps.agex.studio/
        // vendor/...), not in the agex-studio repo. Direct string-
        // literal dynamic imports get walked by `vite:import-
        // analysis` even with `/* @vite-ignore */`. A variable
        // reference defeats the walker cleanly.
        const url = '/vendor/html-to-image.js';
        _htmlToImagePromise = import(url);
    }
    return _htmlToImagePromise;
}

/**
 * The minimal frame contract the parent-side helpers need. Real usage
 * passes an `HTMLIFrameElement`; tests pass a double, so the listener
 * methods are optional and guarded at each call site.
 *
 * @typedef {object} BridgeFrame
 * @property {any} contentWindow
 * @property {boolean} [__navigated] - load-listener latch
 * @property {(type: string, fn: any, opts?: any) => void} [addEventListener]
 * @property {(type: string, fn: any, opts?: any) => void} [removeEventListener]
 */

/**
 * Resolve once the next animation frame has painted, or after
 * `timeoutMs` if rAF never fires. Best-effort frame pump used before
 * a screenshot so rAF-driven canvases reflect current state without
 * the agent manually invoking the app's draw().
 *
 * Why double-rAF: a single `requestAnimationFrame` callback runs
 * *before* that frame's paint and shares the frame with the app's own
 * rAF loop (callbacks fire in registration order). Waiting two frames
 * guarantees the app's update()/draw() for the first frame has painted
 * before we serialize.
 *
 * Why the timeout fallback: a backgrounded tab pauses rAF entirely
 * (the browser suspends it to save CPU — see the prior discussion of
 * `document.hidden` on the cross-origin iframe). With no fallback the
 * await would hang until iframe teardown. On timeout we resolve and
 * capture whatever's in the backing store — identical to the pre-pump
 * behavior, never worse. 100ms comfortably covers two frames even on a
 * 30fps display (~66ms).
 *
 * @param {Window | typeof globalThis | null | undefined} win - either a
 *   real frame window or the ambient global (the in-worker path passes
 *   `globalThis`); both carry the rAF/timer surface used below.
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
export function waitForFrame(win, timeoutMs = 100) {
    const raf = win?.requestAnimationFrame;
    if (typeof raf !== "function") return Promise.resolve();
    return new Promise((resolve) => {
        const t = win.setTimeout(resolve, timeoutMs);
        raf.call(win, () =>
            raf.call(win, () => {
                win.clearTimeout(t);
                resolve();
            }),
        );
    });
}

/**
 * Render a DOM target to a base64 PNG.
 *
 * Returns RFC 4648 canonical base64 (no whitespace, correct
 * padding) — Anthropic's API rejects loosely-encoded variants
 * with "invalid base64 data" 400s, and we send screenshots into
 * tool_result content for any model the agent's running. Other
 * providers (Gemini, OpenAI) are more lenient but we treat the
 * strictest as the contract so the agent's UX is consistent.
 *
 * @param {Document} doc
 * @param {string|null} selector
 * @returns {Promise<string>} base64-encoded PNG (no data URI prefix)
 */
async function captureScreenshot(doc, selector) {
    const { toPng } = await loadHtmlToImage();
    const target = selector ? doc.querySelector(selector) : doc.body;
    if (!target) throw new Error(`Screenshot target not found: ${selector}`);

    // Best-effort: let the app paint a fresh frame before serializing
    // so rAF-driven canvases reflect current state. No-ops fast when the
    // tab is backgrounded (rAF paused) — see waitForFrame.
    await waitForFrame(doc.defaultView || globalThis);

    const dataUrl = await toPng(target, { cacheBust: true });
    // Strict prefix match: accept any `data:image/<type>[;params];base64,`
    // shape (some encoders emit charset / vendor params before `base64`).
    // The previous regex only matched `data:image/png;base64,` exactly,
    // which silently kept the prefix bytes in the output for any
    // variant — those non-base64 bytes blew up Anthropic's strict
    // validator.
    const match = dataUrl.match(/^data:image\/[^;,]+(?:;[^,]+)*?;base64,(.*)$/s);
    if (!match) {
        throw new Error(
            `Screenshot encoder returned an unexpected data URL shape: ${dataUrl.slice(0, 64)}…`,
        );
    }
    // Strip any whitespace/newlines just in case (canvas.toDataURL
    // shouldn't insert them, but some encoders use MIME-style 76-char
    // line wrapping). Anthropic's parser is whitespace-intolerant.
    return match[1].replace(/\s/g, "");
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
 * @param {Window | typeof globalThis} [global] - scope for eval and log
 *   reads; defaults to globalThis
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
        const raw = el ? String(el[prop] ?? '') : null;
        return {
            type: 'read',
            selector: action.read,
            value: raw === null ? null : _capString(raw, MAX_VALUE_BYTES),
        };
    }
    if (action.eval) {
        try {
            // Indirect eval runs in global scope, seeing app-level bindings.
            let val = scope.eval(action.eval);
            // Auto-await Promise / thenable results. Without this,
            // expressions like `Plotly.toImage(...)` or `fetch(url).
            // then(r => r.json())` resolve to an opaque Promise that
            // jsonifies as "[object Promise]"; the agent then has to
            // stash results on globals + `{wait: N}` + read by separate
            // eval — a fragile dance. Awaiting here lets the agent
            // write idiomatic `await`-free expressions: the action
            // takes as long as the Promise takes, and the result is
            // the resolved value. Multi-call parallel works the same
            // way via `Promise.all([..., ..., ...])`.
            if (val && typeof val.then === 'function') {
                val = await val;
            }
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
            // Embed the expression text (and error name) in the
            // error message itself. The `expr` field on the result
            // entry already carries the expression, but agents
            // commonly look at just the error string and miss the
            // correlation — `ReferenceError: foo is not defined`
            // alone doesn't tell them which of their five evals
            // threw. The shape is `<ErrorName>: <message> (in:
            // <expr>)`, which keeps the original message intact
            // for downstream pattern-matching. Async errors (rejected
            // Promises from the auto-await above) flow through the
            // same path.
            const name = e.name || 'Error';
            const expr = action.eval;
            return {
                type: 'eval',
                expr,
                value: null,
                error: `${name}: ${e.message} (in: ${expr})`,
            };
        }
    }
    if (action.assert !== undefined) {
        // One-shot test pattern: evaluate the expression as a JS
        // truthy/falsy check.
        //   - Pass (truthy) → return null so the action surfaces no
        //     entry in the results array.
        //   - Fail (falsy or threw) → THROW with an `AssertionError:`
        //     prefix. The prefix is a marker the parent-side
        //     orchestration (`executeActions`, `runTestApp`) checks
        //     to distinguish "agent's app failed verification" (let
        //     it propagate so the emission errors out and the agent
        //     can self-correct on the next turn) from "an action
        //     itself was malformed" (catch + log).
        //
        //     postMessage doesn't preserve Error subclass identity,
        //     so we use a message prefix instead of an `instanceof
        //     AssertionError` check.
        const tag = action.message ? `${action.message} — ` : '';
        let val;
        try {
            val = scope.eval(action.assert);
        } catch (e) {
            throw new Error(
                `AssertionError: ${tag}${action.assert} threw — ${e.message}`,
            );
        }
        if (val) return null; // pass — silent
        throw new Error(
            `AssertionError: ${tag}${action.assert} (got ${_jsonifyEvalResult(val)})`,
        );
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
    let json;
    try {
        json = JSON.stringify(val, (key, v) => {
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
    if (json.length <= MAX_VALUE_BYTES) return json;
    // Too big for the agent's context window. Wrap the truncated
    // string in a fresh JSON-encoded notice so callers' JSON.parse
    // still works (they get the notice as a string instead of a
    // structured value). The notice names the original size so the
    // agent can size their next eval more carefully.
    return JSON.stringify(_truncationNotice(json, MAX_VALUE_BYTES));
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
        // Validate sender. The bootloader sets `__AGEX_PARENT_ORIGIN`
        // to the verified parent origin after the handshake; if it's
        // set, reject messages from any other origin. Without this,
        // any page that can post to this window could drive the
        // bridge's `eval` action. Fallback to `'*'` is only for tests
        // or local setups where the global isn't installed.
        const parentOrigin = win.__AGEX_PARENT_ORIGIN;
        if (parentOrigin && event.origin !== parentOrigin) return;
        const response = await handleControlMessage(win.document, event.data, win);
        if (!response) return;
        // `MessageEventSource` also covers MessagePort / ServiceWorker,
        // whose postMessage takes transferables rather than a target
        // origin. Control messages only ever arrive from the parent
        // window, so narrow before replying.
        const source = /** @type {Window | null} */ (event.source);
        source?.postMessage(response, parentOrigin || '*');
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
 * Identity check on `event.source` confirms the response came from
 * the expected iframe; we don't filter on `event.origin` here because
 * the parent-side message handler runs across all iframes (test_app /
 * live_app / AppPreview) and the apps origin can vary in dev. Callers
 * that need stricter validation can compare `event.origin` themselves.
 *
 * @param {HTMLIFrameElement | BridgeFrame} iframe
 * @param {object} action
 * @returns {Promise<any>}
 */
export function sendControl(iframe, action) {
    // Once the iframe has navigated, the bridge is gone and no further
    // `load` event will fire — so a later call (e.g. `collectResults`'
    // get-logs, which runs after `executeActions`) would wait forever.
    // `onNavigate` marks the iframe; short-circuit here so those calls
    // reject immediately instead of hanging to the emission timeout.
    if (iframe?.__navigated) {
        return Promise.reject(
            new Error(
                "NavigationError: the app already navigated/reloaded and can't " +
                "accept further actions (the control bridge is gone).",
            ),
        );
    }
    const id = `ctrl-${++_controlIdCounter}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve, reject) => {
        function cleanup() {
            window.removeEventListener('message', handler);
            iframe.removeEventListener?.('load', onNavigate);
        }
        function handler(event) {
            if (event.source !== iframe.contentWindow) return;
            const data = event.data;
            if (data?.type !== 'agex-control-result' || data.id !== id) return;
            cleanup();
            if (data.error) {
                reject(new Error(data.error));
            } else {
                resolve(data.data);
            }
        }
        // The iframe fires `load` when it (re)navigates — e.g. the app
        // called `location.reload()` / set `location.href`, or a link /
        // form navigated it. agex apps are `document.write`n into the
        // sandbox host rather than served at a URL, so any navigation
        // throws the app (and the control bridge) away: the reply we're
        // waiting for is lost in the unload, and the one-shot host
        // handshake won't re-inject the app, so the bridge never comes
        // back. Without this the pending promise would hang until the
        // agent's emission timeout (~180s). Fail fast with a message the
        // agent can act on instead. The `NavigationError:` prefix lets
        // `executeActions` stop the run (later actions would hang too).
        function onNavigate() {
            cleanup();
            // Mark the iframe dead so subsequent sendControl calls bail
            // fast (see the guard above) rather than hanging.
            try {
                iframe.__navigated = true;
            } catch {
                // Frozen/exotic object — best-effort.
            }
            reject(
                new Error(
                    "NavigationError: the app navigated or reloaded during this " +
                    "action (e.g. location.reload(), location.href = ..., or a link/" +
                    "form navigation). agex apps are injected into the sandbox host, " +
                    "not served at a URL, so navigation tears down the app and isn't " +
                    "supported — reset in-app state to 're-render' instead of reloading.",
                ),
            );
        }
        window.addEventListener('message', handler);
        iframe.addEventListener?.('load', onNavigate);
        // Target origin '*' here lets the same code path serve both
        // the cross-origin apps-host iframes (prod / staging) and any
        // future same-origin fallback. The iframe-side handler
        // validates messages against `__AGEX_PARENT_ORIGIN` already
        // so this isn't a leak vector for control payloads.
        iframe.contentWindow?.postMessage(
            { type: 'agex-control', id, action },
            '*',
        );
    });
}
