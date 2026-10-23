/**
 * Iframe control bridge — installed inside the app preview iframe.
 *
 * The studio posts control messages to the iframe via postMessage; this
 * module dispatches them against the iframe's own DOM and posts results
 * back. The app runs at the apps origin, a different origin from the
 * studio's, so the studio can't reach into `iframe.contentDocument`
 * directly. This file is shipped as text into every app page (see
 * `AGENT_CONTROL_BRIDGE_SCRIPT` in `app-html.js`); the studio's side,
 * `sendControl`, lives in `send-control.js`.
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
    // html-to-image serializes the DOM to an inline SVG foreignObject
    // embedded as a data URI, drawn to a canvas: no render iframe of
    // its own to load and read back.
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

    const dataUrl = await toPng(target, {
        // Images are fetched again to be embedded; skip the HTTP cache,
        // where an <img> without crossorigin may have left a response a
        // CORS fetch can't use. (Not `cacheBust`: it adds a query to
        // every URL, and a blob: URL with a query names nothing.)
        fetchRequestInit: { cache: "no-store" },
        // the page's own pixels: at a screen's density (2 on a Retina
        // display) a 1920x1080 stage is a 3840x2160 PNG, past what a
        // model takes as one image
        pixelRatio: 1,
        // The capture is an SVG (XML): a comment holding `--`, which HTML
        // allows (`<!-- set --out -->`), would make the whole image fail
        // to parse. Comments draw nothing, so leave them out.
        filter: (node) => node.nodeType !== Node.COMMENT_NODE,
    });
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

/** How long `click`, `type` and `select` wait for their target to
 *  appear, by default: long enough for the render after an earlier
 *  action, short enough that a wrong selector fails fast. */
const TARGET_WAIT_MS = 1000;

/** How long `waitFor` and `waitUntil` wait, by default. */
const WAIT_FOR_MS = 5000;

/** The longest any action may be told to wait (`timeout`). */
const MAX_WAIT_MS = 60_000;

/** How often a wait checks again. */
const POLL_MS = 50;

/** Marker prefix on the errors of actions that couldn't do what they
 *  were asked (no target, a disabled one, a wait that ran out). Like
 *  `AssertionError:`, it survives postMessage, which drops the class. */
const ACTION_ERROR = 'ActionError:';

/**
 * How long `action` may wait in the page, in ms: its `timeout`, or the
 * default for its kind (0 for an action that doesn't wait). The studio
 * gives the bridge that much longer to answer.
 *
 * @param {object} action
 * @returns {number}
 */
export function actionWaitMs(action) {
    const fallback = action.waitFor !== undefined || action.waitUntil !== undefined
        ? WAIT_FOR_MS
        : action.click !== undefined || action.type !== undefined || action.select !== undefined
            ? TARGET_WAIT_MS
            : 0;
    if (fallback === 0) return 0;
    const t = Number(action.timeout);
    return Number.isFinite(t) && t >= 0 ? Math.min(t, MAX_WAIT_MS) : fallback;
}

/** Call `check` until it gives something truthy (returned) or `ms`
 *  have passed (null). It runs at least once. */
async function _poll(ms, check) {
    const start = Date.now();
    for (;;) {
        const found = await check();
        if (found) return found;
        if (Date.now() - start >= ms) return null;
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

/** Whether a click or an edit on `el` would do nothing because it's
 *  disabled: its own `disabled`, or a disabled fieldset around it. */
function _isDisabled(el) {
    if (el.disabled === true) return true;
    try {
        return el.matches(':disabled');
    } catch {
        return false;
    }
}

/**
 * The element `selector` names for `verb`, waited for up to the
 * action's timeout. One that never appears, or that is disabled,
 * throws an `ActionError`: an action that would do nothing fails
 * rather than pass.
 *
 * @param {Document} doc
 * @param {string} verb
 * @param {string} selector
 * @param {object} action
 */
async function _target(doc, verb, selector, action) {
    const ms = actionWaitMs(action);
    const el = await _poll(ms, () => doc.querySelector(selector));
    if (!el) {
        throw new Error(`${ACTION_ERROR} ${verb} ${JSON.stringify(selector)}: nothing matches it (waited ${ms}ms)`);
    }
    if (_isDisabled(el)) {
        throw new Error(`${ACTION_ERROR} ${verb} ${JSON.stringify(selector)}: the element is disabled, so ${verb} does nothing on it`);
    }
    return el;
}

/**
 * Click `el` as a mouse does: pointerdown, mousedown, pointerup,
 * mouseup and click, at the element's center, bubbling and
 * cancelable. Dispatched events work on any element, an SVG `<g>`
 * included (which has no `click()`), and a dispatched click still does
 * what a click does (a button submits its form, a checkbox toggles, a
 * label clicks its control, a link follows). A cancelled pointerdown
 * holds back the mouse events after it, as in a browser; the click
 * still fires.
 *
 * @param {Element} el
 * @param {Document} doc
 */
function _click(el, doc) {
    const win = /** @type {any} */ (doc.defaultView || globalThis);
    const box = el.getBoundingClientRect();
    const at = {
        bubbles: true, cancelable: true, composed: true, button: 0,
        clientX: box.left + box.width / 2, clientY: box.top + box.height / 2,
    };
    const Mouse = win.MouseEvent;
    const Pointer = win.PointerEvent || Mouse;
    const pointer = { pointerId: 1, pointerType: 'mouse', isPrimary: true };
    const mouse = el.dispatchEvent(new Pointer('pointerdown', { ...at, ...pointer, buttons: 1 }));
    if (mouse) el.dispatchEvent(new Mouse('mousedown', { ...at, buttons: 1 }));
    el.dispatchEvent(new Pointer('pointerup', { ...at, ...pointer, buttons: 0 }));
    if (mouse) el.dispatchEvent(new Mouse('mouseup', { ...at, buttons: 0 }));
    el.dispatchEvent(new Mouse('click', { ...at, buttons: 0, detail: 1 }));
}

/** Evaluate `expr` in `scope`, awaiting a Promise it gives. */
async function _evalAwaited(scope, expr) {
    let val = scope.eval(expr);
    if (val && typeof val.then === 'function') val = await val;
    return val;
}

/**
 * Dispatch a single action against the document.
 *
 * Return-value contract matches the pre-refactor `executeActions`
 * output shape: `null` for actions that produce no result entry
 * (click/type/select, waitFor/waitUntil, a passing assert), an object
 * with a `type` field for actions that do (read/eval/screenshot/
 * get-logs, a failed soft assert).
 *
 * `click`, `type` and `select` wait for their target (`TARGET_WAIT_MS`,
 * or the action's `timeout`) and throw an `ActionError:` when it never
 * appears or is disabled; `waitFor` (a selector) and `waitUntil` (an
 * expression) throw one when their wait runs out.
 *
 * @param {Document} doc
 * @param {object} action
 * @param {Window | typeof globalThis} [global] - scope for eval and log
 *   reads; defaults to globalThis
 * @returns {Promise<object|null>}
 */
export async function dispatchAction(doc, action, global) {
    const scope = global || globalThis;

    if (action.click !== undefined) {
        _click(await _target(doc, 'click', action.click, action), doc);
        return null;
    }
    if (action.type !== undefined) {
        const el = await _target(doc, 'type', action.type, action);
        el.value = action.value || '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return null;
    }
    if (action.select !== undefined) {
        const el = await _target(doc, 'select', action.select, action);
        const want = String(action.value ?? '');
        el.value = want;
        // a <select> takes only a value one of its options has: another
        // leaves it on no option, which the app would read as a choice
        if (el.tagName === 'SELECT' && el.value !== want) {
            const values = Array.from(el.options, (o) => JSON.stringify(o.value)).join(', ');
            throw new Error(`${ACTION_ERROR} select ${JSON.stringify(action.select)}: no option has the value ${JSON.stringify(want)} (its values: ${values})`);
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return null;
    }
    if (action.waitFor !== undefined) {
        const ms = actionWaitMs(action);
        if (!(await _poll(ms, () => doc.querySelector(action.waitFor)))) {
            throw new Error(`${ACTION_ERROR} waitFor ${JSON.stringify(action.waitFor)}: still nothing matches it after ${ms}ms`);
        }
        return null;
    }
    if (action.waitUntil !== undefined) {
        const ms = actionWaitMs(action);
        // an expression that throws (what it reads isn't there yet) counts as not yet
        /** @type {any} */
        let threw = null;
        const held = await _poll(ms, async () => {
            try {
                const val = await _evalAwaited(scope, action.waitUntil);
                threw = null;
                return Boolean(val);
            } catch (e) {
                threw = e;
                return false;
            }
        });
        if (!held) {
            const last = threw ? `; it last threw ${threw.name || 'Error'}: ${threw.message}` : '';
            throw new Error(`${ACTION_ERROR} waitUntil ${action.waitUntil}: still not true after ${ms}ms${last}`);
        }
        return null;
    }
    if (action.read) {
        const el = doc.querySelector(action.read);
        // innerText: the text as shown, a line between blocks (textContent runs them together)
        const prop = action.prop || 'innerText';
        const raw = el ? String(el[prop] ?? '') : null;
        return {
            type: 'read',
            selector: action.read,
            value: raw === null ? null : _capString(raw, MAX_VALUE_BYTES),
        };
    }
    if (action.eval) {
        // a label names the eval in its result in place of its code
        const label = typeof action.label === 'string' && action.label !== '' ? { label: action.label } : {};
        try {
            // Indirect eval runs in global scope, seeing app-level bindings.
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
            const val = await _evalAwaited(scope, action.eval);
            return {
                type: 'eval',
                expr: action.eval,
                ...label,
                // JSON-encode the value (always, even primitives) so
                // every result reads the same way and its size can be
                // capped.  Replacer handles common
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
                ...label,
                value: null,
                error: `${name}: ${e.message} (in: ${label.label ?? expr})`,
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
        //   - A `soft` one fails without ending the call: the failure
        //     comes back as a result entry and the actions go on.
        const tag = action.message ? `${action.message} — ` : '';
        const fail = (/** @type {string} */ message) => {
            if (action.soft === true) return { type: 'assert', soft: true, message };
            throw new Error(message);
        };
        let val;
        try {
            val = scope.eval(action.assert);
        } catch (e) {
            return fail(`AssertionError: ${tag}${action.assert} threw — ${e.message}`);
        }
        if (val) return null; // pass — silent
        return fail(`AssertionError: ${tag}${action.assert} (got ${_jsonifyEvalResult(val)})`);
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
 * Always JSON-encoded (even primitives), so a result reads the same
 * whatever its type, and is capped at `MAX_VALUE_BYTES`.
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
        // to the verified parent origin after the handshake; only
        // messages from it are obeyed, and with it unset none are.
        // Without this, any page that can post to this window could
        // drive the bridge's `eval` action.
        const parentOrigin = win.__AGEX_PARENT_ORIGIN;
        if (!parentOrigin || event.origin !== parentOrigin) return;
        const response = await handleControlMessage(win.document, event.data, win);
        if (!response) return;
        // `MessageEventSource` also covers MessagePort / ServiceWorker,
        // whose postMessage takes transferables rather than a target
        // origin. Control messages only ever arrive from the parent
        // window, so narrow before replying.
        const source = /** @type {Window | null} */ (event.source);
        source?.postMessage(response, parentOrigin);
    });
}
