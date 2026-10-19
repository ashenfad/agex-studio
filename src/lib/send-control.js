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
 * Why a frame's page went away, which the error an action gets says:
 * `app`, the app navigated or reloaded itself; `studio`, the studio
 * replaced the page (the preview rebuilt, or the person reloaded it),
 * which is no fault of the app's.
 *
 * @typedef {"app" | "studio"} GoneCause
 */

/**
 * What the studio knows of each app frame's page, from what it and the
 * page said. A page is written into the apps origin's bootloader
 * (`document.write`), and the frame fires `load` once more when that
 * page has loaded (its module scripts and their static imports): the
 * page's own load, not a navigation. A `load` after that one is the
 * frame taking another document, so the page and its control bridge
 * are gone.
 *
 * - `ownLoad`: the page's bridge is up and its own `load` hasn't come
 *   yet;
 * - `loaded`: the page said its document's `load` fired;
 * - `gone`: the page went away (and why), until the frame has a page
 *   again;
 * - `inflight`: the actions waiting for an answer, failed at once when
 *   the page goes;
 * - `watchers`: `waitForLoad`s, told when any of it changes.
 *
 * @typedef {{
 *   ownLoad: boolean,
 *   loaded: boolean,
 *   gone: GoneCause | null,
 *   inflight: Set<(e: Error) => void>,
 *   watchers: Set<() => void>,
 *   listening: boolean,
 * }} FrameState
 */

/** @type {WeakMap<object, FrameState>} */
const frames = new WeakMap();

/** @param {object} iframe */
function stateOf(iframe) {
    let s = frames.get(iframe);
    if (s === undefined) {
        s = { ownLoad: false, loaded: false, gone: null, inflight: new Set(), watchers: new Set(), listening: false };
        frames.set(iframe, s);
    }
    return s;
}

/** @param {FrameState} s */
function changed(s) {
    for (const fn of [...s.watchers]) fn();
}

/** The error an action gets when the frame's page went, by why.
 *  @param {GoneCause} cause @param {boolean} during */
function goneError(cause, during) {
    const when = during ? "during this action" : "after an earlier action";
    if (cause === "studio") {
        return new Error(
            `NavigationError: the studio replaced the app's page ${when} ` +
            "(the preview rebuilt because its files changed, or it was reloaded): " +
            "this isn't the app's doing. Run the actions again.",
        );
    }
    return new Error(
        `NavigationError: the app's page went away ${when}: it navigated or ` +
        "reloaded itself (location.reload(), location.href = ..., a link or a " +
        "form submit), which ends an app's page, since it's written into the " +
        "sandbox rather than served at a URL. If the app reloads on purpose, " +
        "re-render in place instead; to check what survives a reload, use " +
        "the {reload: true} action.",
    );
}

/**
 * The frame has a page again: its control bridge posted
 * `agex-bridge-ready`, so actions can be sent to it. The frame's next
 * `load` is the page's own, once it has loaded; any after that means
 * the page went (`pageGone`).
 *
 * @param {object} iframe
 */
export function pageUp(iframe) {
    const s = stateOf(iframe);
    s.gone = null;
    s.ownLoad = true;
    s.loaded = false;
    const frame = /** @type {ControlFrame} */ (iframe);
    if (!s.listening && typeof frame.addEventListener === "function") {
        s.listening = true;
        frame.addEventListener("load", () => {
            if (s.gone !== null) return;
            if (s.ownLoad) {
                s.ownLoad = false;
                return;
            }
            pageGone(iframe, "app");
        });
    }
    changed(s);
}

/**
 * The frame's page said its document's `load` event fired: its module
 * scripts ran, with their static imports, and its images and styles
 * loaded.
 *
 * @param {object} iframe
 */
export function pageLoaded(iframe) {
    const s = stateOf(iframe);
    s.loaded = true;
    changed(s);
}

/**
 * The frame's page is gone: the app navigated or reloaded itself
 * (`app`; the bootloader said `agex-host-ready` again, or the frame
 * took another document), or the studio is replacing it (`studio`).
 * Nothing answers actions until the frame has a page again
 * (`pageUp`): those waiting fail at once, and so do any sent
 * meanwhile. The first cause told stands until then.
 *
 * @param {object} iframe
 * @param {GoneCause} [cause]
 */
export function pageGone(iframe, cause = "app") {
    const s = stateOf(iframe);
    if (s.gone === null) s.gone = cause;
    s.ownLoad = false;
    s.loaded = false;
    const error = goneError(s.gone, true);
    for (const fail of [...s.inflight]) fail(error);
    changed(s);
}

/**
 * Whether the frame has a page whose document has loaded.
 *
 * @param {object} iframe
 * @returns {boolean}
 */
export function hasLoaded(iframe) {
    const s = stateOf(iframe);
    return s.gone === null && s.loaded;
}

/**
 * Settle once the frame has a page whose document has loaded (true),
 * or once `ms` elapse first (false).
 *
 * @param {object} iframe
 * @param {number} ms
 * @returns {Promise<boolean>}
 */
export function waitForLoad(iframe, ms) {
    const s = stateOf(iframe);
    return new Promise((resolve) => {
        const check = () => {
            if (s.gone !== null || !s.loaded) return;
            done(true);
        };
        const timer = setTimeout(() => done(false), ms);
        /** @param {boolean} value */
        function done(value) {
            clearTimeout(timer);
            s.watchers.delete(check);
            resolve(value);
        }
        s.watchers.add(check);
        check();
    });
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
 * its page went away (now or during an earlier action; see `pageGone`
 * for why), and with `TimeoutError:` when no answer comes within
 * `timeoutMs`.
 *
 * @param {HTMLIFrameElement | ControlFrame} iframe
 * @param {object} action
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<any>}
 */
export function sendControl(iframe, action, { timeoutMs = CONTROL_TIMEOUT_MS } = {}) {
    const state = stateOf(iframe);
    // Once the page has gone, nothing answers until the frame has a page
    // again, so a later call (e.g. `collectResults`' get-logs, which runs
    // after `executeActions`) would wait for nothing. Reject at once.
    if (state.gone !== null) return Promise.reject(goneError(state.gone, false));
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
            state.inflight.delete(onGone);
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
        // The page went away while this action waited (`pageGone`), so
        // its answer is lost with it. Fail fast with why: the
        // `NavigationError:` prefix lets `executeActions` stop the run
        // (later actions would fail the same way).
        /** @param {Error} e */
        function onGone(e) {
            cleanup();
            reject(e);
        }
        window.addEventListener("message", handler);
        state.inflight.add(onGone);
        target.postMessage({ type: "agex-control", id, action }, APPS_ORIGIN);
    });
}
