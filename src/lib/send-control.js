/**
 * The studio's side of the control bridge: post an action to an app's
 * iframe and await its result. The app's side (`installControlBridge`)
 * lives in `iframe-bridge.js`, which is shipped as text into every app
 * page; this module stays in the studio, where it knows the apps origin
 * and addresses only it.
 */

import { APPS_ORIGIN, isFromAppFrame } from "./apps-origin.js";

/** How long an action may take before `sendControl` gives up on it. An
 *  `eval` awaits a Promise it returns and a screenshot draws the page,
 *  so this is generous; past it the page is most likely stuck (a loop
 *  that never yields, a Promise that never settles). */
export const CONTROL_TIMEOUT_MS = 30_000;

/**
 * Frames whose app navigated or reloaded during an action, so its
 * control bridge went with it. Cleared when the frame takes a page
 * again (`pageLoaded`).
 *
 * @type {WeakSet<object>}
 */
const navigated = new WeakSet();

/**
 * The frame has a page again: its control bridge posted
 * `agex-bridge-ready`, so actions can be sent to it. Called by the live
 * preview, which keeps one iframe across rebuilds and an app's own
 * reloads.
 *
 * @param {object} iframe
 */
export function pageLoaded(iframe) {
    navigated.delete(iframe);
}

/**
 * The frame's page is gone: its app navigated or reloaded between
 * actions, so the bootloader came back in its place (it said
 * `agex-host-ready` again) and nothing answers actions until the frame
 * takes a page again. Actions sent meanwhile fail at once.
 *
 * @param {object} iframe
 */
export function pageGone(iframe) {
    navigated.add(iframe);
}

/**
 * The minimal frame contract `sendControl` needs. Real usage passes an
 * `HTMLIFrameElement`; tests pass a double, so the listener methods are
 * optional and guarded at each call site.
 *
 * @typedef {object} ControlFrame
 * @property {any} contentWindow
 * @property {(type: string, fn: any, opts?: any) => void} [addEventListener]
 * @property {(type: string, fn: any, opts?: any) => void} [removeEventListener]
 */

let _controlIdCounter = 0;

/**
 * Send a control action to an iframe and await the response.
 *
 * The iframe must have the bridge installed (`AGENT_CONTROL_BRIDGE_SCRIPT`
 * in `app-html.js`) for this to resolve. The action is posted to the
 * apps origin only, and only a reply from that frame's window at that
 * origin counts.
 *
 * Resolves with the action's data payload (may be `null` for
 * click/type/select which produce no result entry). Rejects on error
 * responses from the bridge (unknown action shape, etc.). Does NOT
 * reject on sub-errors captured into the data payload itself (e.g., an
 * eval that threw — that's returned as `data.error`).
 *
 * Rejects at once when the frame is gone, with `NavigationError:` when
 * the app navigated (now or during an earlier action), and with
 * `TimeoutError:` when no answer comes within `timeoutMs`.
 *
 * @param {HTMLIFrameElement | ControlFrame} iframe
 * @param {object} action
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<any>}
 */
export function sendControl(iframe, action, { timeoutMs = CONTROL_TIMEOUT_MS } = {}) {
    // Once the iframe has navigated, the bridge is gone and no further
    // `load` event will fire until it takes a page again — so a later
    // call (e.g. `collectResults`' get-logs, which runs after
    // `executeActions`) would wait for nothing. Reject at once instead.
    if (navigated.has(iframe)) {
        return Promise.reject(
            new Error(
                "NavigationError: the app already navigated/reloaded and can't " +
                "accept further actions (the control bridge is gone).",
            ),
        );
    }
    const target = iframe?.contentWindow;
    if (!target) {
        return Promise.reject(new Error("the app's frame is gone (the preview closed or rebuilt)"));
    }
    const id = `ctrl-${++_controlIdCounter}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            cleanup();
            reject(
                new Error(
                    `TimeoutError: the app didn't answer ${JSON.stringify(action).slice(0, 200)} ` +
                    `within ${Math.round(timeoutMs / 1000)}s: the page may be stuck ` +
                    "(a loop that never yields, or an eval whose Promise never settles).",
                ),
            );
        }, timeoutMs);
        function cleanup() {
            clearTimeout(timer);
            window.removeEventListener("message", handler);
            iframe.removeEventListener?.("load", onNavigate);
        }
        /** @param {MessageEvent} event */
        function handler(event) {
            if (!isFromAppFrame(event, /** @type {HTMLIFrameElement} */ (iframe))) return;
            const data = event.data;
            if (data?.type !== "agex-control-result" || data.id !== id) return;
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
        // apps origin's bootloader rather than served at a URL, so any
        // navigation throws the app (and the control bridge) away and
        // the reply we're waiting for is lost in the unload. Fail fast
        // with a message the agent can act on. The `NavigationError:`
        // prefix lets `executeActions` stop the run (later actions
        // would fail the same way).
        function onNavigate() {
            cleanup();
            navigated.add(iframe);
            reject(
                new Error(
                    "NavigationError: the app navigated or reloaded during this " +
                    "action (e.g. location.reload(), location.href = ..., or a link/" +
                    "form navigation). agex apps are injected into the sandbox host, " +
                    "not served at a URL, so navigation tears down the app and the " +
                    "action with it — reset in-app state to 're-render' instead of reloading.",
                ),
            );
        }
        window.addEventListener("message", handler);
        iframe.addEventListener?.("load", onNavigate);
        target.postMessage({ type: "agex-control", id, action }, APPS_ORIGIN);
    });
}
