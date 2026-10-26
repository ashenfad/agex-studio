/**
 * Iframe control for `test_app`: a hidden test iframe built from the
 * app's files, or the live preview the person is looking at, driven by
 * the control bridge (`iframe-bridge.js` in the page, `send-control.js`
 * here).
 *
 * `cacheHandler(key)` answers the app's `getCacheValue()` calls from
 * the session's cache.
 */

import { CONTROL_TIMEOUT_MS, hasLoaded, pageGone, pageLoaded, pageUp, sendControl, waitForLoad } from "./send-control.js";
import { actionWaitMs } from "./iframe-bridge.js";
import { APPS_ORIGIN, isFromAppFrame, replyToApp } from "./apps-origin.js";
import { hostInit } from "./app-assets.js";
import { answerDb } from "./app-db-bridge.js";
import { checkBag } from "./app-storage.js";

// ---------------------------------------------------------------------------
// Live preview iframe — module-level ref shared by callers
// ---------------------------------------------------------------------------

/** @type {HTMLIFrameElement | null} */
let _liveIframe = null;

/** Register the live preview iframe for `runLiveApp` to target.
 *  Called by `AppPreview.svelte` on mount / unmount. */
export function setLiveIframe(iframe) {
    _liveIframe = iframe;
}

/** Read the current live iframe ref. Used by adapters' `live_app`
 *  agent.fn registrations. */
export function getLiveIframe() {
    return _liveIframe;
}

/** The live preview's `whenSettled`: no rebuild due or under way. */
/** @type {(() => Promise<unknown>) | null} */
let _liveSettled = null;

/** Register how to wait for the live preview to settle. Called by
 *  `AppPreview.svelte` on mount / unmount. */
export function setLiveSettled(fn) {
    _liveSettled = fn;
}

/** How long `test_app` with `live` waits for the preview to rebuild
 *  from files just written before acting on it as it is. */
const LIVE_SETTLE_TIMEOUT_MS = 15_000;

/** Settle once the live preview has gone on with the app's files as
 *  they are (the rebuild a write set off has built its page and handed
 *  it to the frame), or at once with no preview; past `ms`, settle
 *  anyway. The page may still be loading: `runLiveApp` waits for that. */
export function whenLiveSettled(ms = LIVE_SETTLE_TIMEOUT_MS) {
    if (_liveSettled === null) return Promise.resolve();
    let timer;
    return Promise.race([
        _liveSettled(),
        new Promise((resolve) => (timer = setTimeout(resolve, ms))),
    ]).finally(() => clearTimeout(timer));
}

/**
 * The calls each app frame's page has made to the studio
 * (`getCacheValue`, `agex.task`) that haven't been answered yet, and the
 * `waitForIdle`s watching it. `page` counts the frame's pages, so a call
 * the page before a reload made can't be counted against the next one.
 *
 * @type {WeakMap<object, { pending: number, page: number, watchers: Set<() => void> }>}
 */
const _calls = new WeakMap();

function _callsOf(iframe) {
    let c = _calls.get(iframe);
    if (c === undefined) {
        c = { pending: 0, page: 0, watchers: new Set() };
        _calls.set(iframe, c);
    }
    return c;
}

/** @param {{ watchers: Set<() => void> }} c */
function _changed(c) {
    for (const fn of c.watchers) fn();
}

/** The app in `iframe` made a call to the studio; it's in flight until
 *  the function returned is called, as it's answered (or fails). Both
 *  the test iframe's bridge and the live preview report their calls, so
 *  `waitForIdle` waits for them.
 *  @returns {() => void} */
export function callStarted(iframe) {
    const c = _callsOf(iframe);
    const page = c.page;
    c.pending += 1;
    _changed(c);
    let done = false;
    return () => {
        if (done || c.page !== page) return;
        done = true;
        c.pending = Math.max(0, c.pending - 1);
        _changed(c);
    };
}

/** The page in `iframe` was replaced (the app reloaded): the calls the
 *  old one made are answered to no page, so no wait counts them. */
export function callsLost(iframe) {
    const c = _callsOf(iframe);
    c.page += 1;
    c.pending = 0;
    _changed(c);
}

/** Settle once the app has no call to the studio in flight and none
 *  has started or finished for `idleGap` ms, or once `maxMs` elapses.
 *  A call counts from when it starts (`callStarted`), so a click that
 *  sets off an agent task taking seconds keeps the wait going until
 *  the task answers and the app has had its quiet gap to show the
 *  result.
 *
 *  Default `idleGap` is 400ms. Sized for the typical pattern: a click
 *  fires a call (postMessage round-trip ~50ms), and its answer may fire
 *  another at once. Tight chains keep the timer extending; the gap only
 *  fires when the chain genuinely ends. 400ms is also enough margin for
 *  ~300ms debounced patterns (typical debounce sizes) to fire their
 *  first call before we settle.
 *
 *  Caps:
 *    - Per-action waits use the default 400ms gap. With many
 *      click-driven actions in a single `testApp` call (5+ clicks),
 *      a 2000ms-per-click cushion would blow past the worker's
 *      emission timeout for what's usually trivial work.
 *    - Work the app does without calling the studio (a timer, a
 *      `fetch`): the agent inserts an explicit `{ wait: N }` action.
 *
 *  Override per-call when a known-slow path needs more headroom. */
export function waitForIdle(iframe, maxMs = 15000, idleGap = 400) {
    return new Promise((resolve) => {
        const calls = _callsOf(iframe);
        let idleTimer = null;
        function finish() {
            clearTimeout(idleTimer);
            clearTimeout(maxTimer);
            calls.watchers.delete(onChange);
            resolve();
        }
        const maxTimer = setTimeout(finish, maxMs);
        function onChange() {
            clearTimeout(idleTimer);
            idleTimer = calls.pending === 0 ? setTimeout(finish, idleGap) : null;
        }
        calls.watchers.add(onChange);
        onChange();
    });
}

/** Named viewport presets the agent can pass to `testApp` to size the
 *  test iframe — so a responsive app can be verified at desktop, tablet,
 *  and mobile shapes. Dimensions are CSS pixels (the iframe's content
 *  box), which is exactly what the app's media queries and
 *  `window.innerWidth` see. Sizes chosen as representative-not-exact:
 *  ~laptop, iPad-portrait, and a tall modern phone. */
const VIEWPORT_PRESETS = {
    desktop: { width: 1280, height: 800 },
    tablet: { width: 768, height: 1024 },
    mobile: { width: 390, height: 844 },
};

/** Legacy default size — preserved for callers that pass no viewport so
 *  existing screenshots don't silently change shape. */
const DEFAULT_VIEWPORT = { width: 800, height: 600 };

const _VIEWPORT_MIN = 200;
const _VIEWPORT_MAX = 4000;

function _clampDim(n, fallback) {
    // `null`/`undefined` mean "omitted" → fallback. Guard explicitly:
    // `Number(null)` is 0 (finite), which would otherwise clamp to the
    // floor instead of falling back.
    if (n == null) return fallback;
    const v = Math.round(Number(n));
    if (!Number.isFinite(v)) return fallback;
    return Math.max(_VIEWPORT_MIN, Math.min(_VIEWPORT_MAX, v));
}

/**
 * Resolve a viewport spec to concrete `{ width, height }` CSS pixels.
 *
 * Accepts a named preset (`'desktop' | 'tablet' | 'mobile'`), an explicit
 * `{ width, height }` object (clamped to a sane range), or nothing (the
 * legacy 800×600 default). Unknown strings / malformed objects fall back
 * to the default rather than throwing — a bad viewport shouldn't abort a
 * test the agent otherwise set up correctly.
 *
 * @param {string | { width?: number, height?: number } | null | undefined} viewport
 * @returns {{ width: number, height: number }}
 */
export function resolveViewport(viewport) {
    if (!viewport) return { ...DEFAULT_VIEWPORT };
    if (typeof viewport === "string") {
        const preset = VIEWPORT_PRESETS[viewport.toLowerCase()];
        return preset ? { ...preset } : { ...DEFAULT_VIEWPORT };
    }
    if (typeof viewport === "object") {
        return {
            width: _clampDim(viewport.width, DEFAULT_VIEWPORT.width),
            height: _clampDim(viewport.height, DEFAULT_VIEWPORT.height),
        };
    }
    return { ...DEFAULT_VIEWPORT };
}

/** Action keys whose dispatch is purely synchronous in the iframe —
 *  the bridge response carries the full result and there's no
 *  follow-on async work to wait for. Skip the post-action
 *  `waitForIdle` for these to keep test_app turn-time bounded by
 *  actual work, not a settling cushion that's only needed when an
 *  action might trigger app-side queries / fetches. */
const SYNC_ACTION_KEYS = ["read", "eval", "assert", "screenshot", "get-logs", "waitFor", "waitUntil"];

function _isSyncAction(action) {
    return SYNC_ACTION_KEYS.some((k) => action[k] !== undefined);
}

/** Marker prefixes the iframe bridge stamps on the errors of a
 *  failed assertion and of an action that couldn't do what it was asked
 *  (no target, a disabled one, a wait that ran out). We use the prefix
 *  (not `instanceof`) because postMessage doesn't preserve Error
 *  subclass identity. */
function _isNamedFailure(e) {
    return typeof e?.message === "string" &&
        (e.message.startsWith("AssertionError:") || e.message.startsWith("ActionError:"));
}

/** A failure that ends the call with an error: `executeActions` gives
 *  it the results that came before it (`e.results`). */
function _endsTheCall(e) {
    return Array.isArray(e?.results);
}

/** Marker prefixes `sendControl` stamps when the iframe navigated /
 *  reloaded mid-action (e.g. `location.reload()`), or didn't answer in
 *  time. Either way the remaining actions would fail the same way (the
 *  control bridge is gone, or the page is stuck), so we surface this
 *  one and stop the sequence rather than wait on each. */
function _endsTheRun(e) {
    return typeof e?.message === "string" &&
        (e.message.startsWith("NavigationError:") || e.message.startsWith("TimeoutError:"));
}

/** Execute `actions` sequentially against `iframe`'s control bridge.
 *  Returns the read/eval/screenshot result entries (the bridge
 *  itself dispatches click/type/select with no return).
 *
 *  Per-action settling: only async-triggering actions (click, type,
 *  select) get an automatic `waitForIdle` after dispatch, since
 *  those run app-side handlers that may call `getCacheValue()` /
 *  `agex.task(...)` / `fetch()`. Sync actions (eval, read,
 *  screenshot, get-logs) return their full result via the bridge
 *  and need no further wait. The agent can always insert an
 *  explicit `{ wait: N }` action if a sync action's expression
 *  itself spawned background work it wants to await.
 *
 *  Two actions are handled parent-side instead of via the bridge:
 *  `{ wait: N }` (sleep N ms) and `{ viewport }` (resize the iframe
 *  element so the app relays out at a new shape, then settle). The
 *  viewport action is gated on `opts.allowViewport` — true for the
 *  hidden test iframe, false (a no-op + note) for the live preview,
 *  which the studio's panes own and shouldn't be resized under the user.
 *  `{ reload: true }` is the caller's to do (`opts.reload`, which
 *  rebuilds the hidden test iframe and says what came of it); without
 *  it (the live preview) it's a no-op and a note, too.
 *
 *  Error handling: an action that fails ends the call with an error:
 *  a failed assertion, a click / type / select whose target never
 *  appeared or is disabled, a `waitFor` / `waitUntil` that ran out, an
 *  unknown action, or anything else the bridge threw. The error
 *  propagates carrying the results so far as `e.results`, so the agent
 *  sees the failure, and what came before it (a grid's frames among
 *  it), to self-correct, rather than the actions after it running on a
 *  page that isn't in the state they expect. Errors the bridge reports
 *  in a result (an eval that threw, a screenshot that couldn't be
 *  drawn, a failed soft assert) don't end it. A page that went away or
 *  stopped answering ends the run too, with the cause as its last
 *  result.
 *
 *  A screenshot action with a `grid` name (and a `label`) comes back
 *  with them on its result, for the frames to be tiled together.
 *
 *  @param {HTMLIFrameElement} iframe
 *  @param {Array<object>} actions
 *  @param {{ allowViewport?: boolean, reload?: (() => Promise<object[]>) | null }} [opts]
 */
export async function executeActions(iframe, actions, opts = {}) {
    const { allowViewport = false, reload = null } = opts;
    const results = [];
    for (const action of actions) {
        if (action.wait !== undefined) {
            await new Promise((r) => setTimeout(r, action.wait));
            continue;
        }
        if (action.reload !== undefined) {
            if (reload === null) {
                results.push({
                    type: "log",
                    level: "warn",
                    message:
                        "reload actions are only supported without live: true — " +
                        "the studio won't reload the preview the person is using; " +
                        "test without live to check what survives a reload.",
                });
                continue;
            }
            try {
                results.push(...(await reload()));
            } catch (e) {
                // the page didn't come back: nothing after this could run
                results.push({ type: "log", level: "error", message: `reload failed: ${e?.message ?? String(e)}` });
                break;
            }
            continue;
        }
        if (action.viewport !== undefined) {
            // Parent-side: resize the iframe element so the app's media
            // queries / window.innerWidth re-evaluate, then settle. Only
            // honored for the hidden test iframe — the live preview is
            // laid out by the studio's panes, and resizing it would jolt
            // what the user sees, so we no-op it there with a note.
            if (!allowViewport) {
                results.push({
                    type: "log",
                    level: "warn",
                    message:
                        "viewport actions are only supported in testApp — " +
                        "the live preview can't be resized.",
                });
                continue;
            }
            const { width, height } = resolveViewport(action.viewport);
            iframe.style.width = `${width}px`;
            iframe.style.height = `${height}px`;
            // Let layout reflow + any resize-driven re-render / call
            // settle before the next action (e.g. a screenshot) runs.
            await waitForIdle(iframe, 10000);
            continue;
        }
        try {
            // a waiting action gets its wait on top of the usual time to answer
            const data = await sendControl(iframe, action, { timeoutMs: CONTROL_TIMEOUT_MS + actionWaitMs(action) });
            // a screenshot for a grid keeps its grid and label, to be tiled with the rest
            if (data?.type === "screenshot" && typeof action.grid === "string" && action.grid !== "") {
                data.grid = action.grid;
                if (typeof action.label === "string") data.label = action.label;
            }
            if (data != null) results.push(data);
        } catch (e) {
            if (_endsTheRun(e)) {
                // The app tore itself down or stopped answering: every
                // remaining action would fail the same way. Record the
                // cause and stop here.
                results.push({ type: "log", level: "error", message: e.message });
                break;
            }
            const failure = _isNamedFailure(e) ? e : new Error(`Action failed: ${e?.message ?? String(e)}`);
            // what came before the failure still comes back (a grid's frames among it)
            failure.results = results;
            throw failure;
        }
        if (!_isSyncAction(action)) {
            await waitForIdle(iframe, 10000);
        }
    }
    return results;
}

/** How long `collectResults` waits for the app's logs: reading them is
 *  instant for a page that answers at all. */
const LOGS_TIMEOUT_MS = 5000;

/** The iframe's page's console output so far, as log entries; none
 *  when the page doesn't answer (collecting logs is best-effort). */
async function _pageLogs(iframe) {
    try {
        const data = await sendControl(iframe, { "get-logs": true }, { timeoutMs: LOGS_TIMEOUT_MS });
        return (data?.logs || []).map((e) => ({
            type: "log",
            level: e.level,
            message: e.message,
        }));
    } catch {
        return [];
    }
}

/** Pull the iframe's collected console logs and append the action
 *  results, after `leading` (notes, and the console output of pages a
 *  `{ reload }` replaced). Capped at 200 entries to keep test_app turn
 *  output bounded — long-tail logs would crowd the agent's context. */
export async function collectResults(iframe, actionResults, leading = []) {
    const logs = await _pageLogs(iframe);
    return capResults([...leading, ...logs, ...actionResults]);
}

/** The bounds on what one testApp / liveApp call returns: 200 entries,
 *  then the overall size. */
export function capResults(entries) {
    const capped = entries.slice(0, 200);
    // Final overall-size backstop. Per-entry caps in iframe-bridge
    // (eval/read) and the console interceptor (logs) already keep
    // individual items at <=50 KB, but a session that emits 100
    // capped logs would still total ~5 MB. Trim from the front
    // (logs come first; action results are the things the agent
    // most cared about) until the total fits within the budget.
    // The agent then sees a single synthetic log noting what got
    // dropped so they don't silently lose context.
    return _enforceTotalCap(capped, MAX_TOTAL_RESULT_BYTES);
}

/** ~256 KB combined cap on a single testApp / liveApp return.
 *  Generous for realistic dashboards (dozens of action results
 *  with capped values); a hard ceiling above that signals abuse
 *  or pathological logging that would blow up the next turn's
 *  prompt either way. */
const MAX_TOTAL_RESULT_BYTES = 256_000;

export function _enforceTotalCap(entries, max) {
    // Cheap UTF-16 byte estimate via length — strings are at most
    // 2 bytes per char in V8 but most content is ASCII, so this
    // upper-bounds the real wire size.
    const sizeOf = (e) =>
        (e.message?.length ?? 0) + (e.value?.length ?? 0) + 64;
    let total = entries.reduce((n, e) => n + sizeOf(e), 0);
    if (total <= max) return entries;
    let dropped = 0;
    const out = [...entries];
    while (out.length > 0 && total > max) {
        const e = out.shift();
        total -= sizeOf(e);
        dropped++;
    }
    return [
        {
            type: "log",
            level: "warn",
            message:
                `[truncated: dropped ${dropped} earliest result entries ` +
                `(per-entry caps already applied; combined size exceeded ${max} bytes)]`,
        },
        ...out,
    ];
}

/** Wire iframe→parent message bridges to the caller-provided
 *  handlers. Returns the listener function so `runTestApp` can
 *  remove it on teardown.
 *
 *  `initPage`, when provided, makes the listener double as the
 *  bootloader handshake responder: on receiving the bootloader's
 *  `agex-host-ready` signal, the listener posts `agex-host-init`
 *  with the page (`hostInit`) so the bootloader can document.write it. This
 *  keeps the cross-origin handshake colocated with the rest of
 *  the per-iframe message handling. A page is sent once; a function
 *  gives the page to send each time the bootloader asks, or null when
 *  none is due (the app reloaded itself, which a `{ reload }` action
 *  makes room for by having one due).
 *
 *  It also follows the page's lifecycle (`pageUp` when its bridge is
 *  ready, `pageLoaded` when its document loaded), and hands the test
 *  page's storage, as the page reports it (`agex-test-storage`), to
 *  `onStorage`, and gives the database the app's `agex.db` calls run
 *  on (`dbHandler`; without one they fail). */
export function _attachBridges(iframe, cacheHandler, pendingHandlers, initPage = null, taskHandler = null, onStorage = null, dbHandler = null) {
    let initPosted = false;
    const nextPage = typeof initPage === "function"
        ? initPage
        : () => {
            if (initPosted) return null;
            initPosted = true;
            return initPage;
        };
    const handler = (event) => {
        // Only accept messages from the app iframe's window at the apps
        // origin (see isFromAppFrame in apps-origin.js).
        if (!isFromAppFrame(event, iframe)) return;
        const data = event.data;
        if (!data) return;

        // Bootloader handshake — respond with the app HTML so the
        // bootloader can render it. The bootloader asking with no page
        // due means the app navigated or reloaded itself away (perhaps
        // between actions, where no action was waiting to see it): the
        // test goes on without its page, so what's sent to it next
        // fails at once rather than waiting out its timeout.
        if (data.type === "agex-host-ready" && initPage) {
            const page = nextPage();
            if (page === null) {
                pageGone(iframe, "app");
                return;
            }
            replyToApp(iframe, hostInit(page, data));
            return;
        }

        if (data.type === "agex-bridge-ready") {
            pageUp(iframe);
            return;
        }

        if (data.type === "agex-page-loaded") {
            pageLoaded(iframe);
            return;
        }

        // what the test's page holds in its storage now, kept for a reload
        if (data.type === "agex-test-storage") {
            const local = checkBag(data.local);
            const session = checkBag(data.session);
            if (onStorage && local !== null && session !== null) onStorage({ local, session });
            return;
        }

        if (data.type === "agex-task") {
            const { id } = data;
            const done = callStarted(iframe);
            const p = (async () => {
                try {
                    if (!taskHandler) throw new Error("agex.task isn't available here");
                    const value = await taskHandler({ spec: data.spec, inputs: data.inputs });
                    replyToApp(iframe, { type: "agex-task-result", id, value: value === undefined ? null : value, error: null });
                } catch (err) {
                    replyToApp(iframe, { type: "agex-task-result", id, value: null, error: err?.message || String(err) });
                }
                done();
            })();
            pendingHandlers.push(p);
            return;
        }

        if (data.type === "agex-db") {
            const done = callStarted(iframe);
            const p = (async () => {
                const db = dbHandler ?? (() => Promise.reject(new Error("agex.db isn't available here")));
                replyToApp(iframe, await answerDb(data, db));
                done();
            })();
            pendingHandlers.push(p);
            return;
        }

        // a test shows the person nothing: notify() answers false, at once
        if (data.type === "agex-notify") {
            replyToApp(iframe, { type: "agex-notify-result", id: data.id, shown: false, error: "notifications aren't shown in a test" });
            return;
        }

        // a test's page has its own copy of the database, which no sync
        // changes: the work it marks busy changes nothing
        if (data.type === "agex-busy") return;

        if (data.type === "agex-cache-get") {
            const { id, key } = data;
            const done = callStarted(iframe);
            const p = (async () => {
                try {
                    const out = cacheHandler ? await cacheHandler(key) : undefined;
                    if (cacheHandler) {
                        replyToApp(iframe, {
                            type: "agex-cache-get-result",
                            id,
                            data: out === undefined ? null : out,
                            error: null,
                        });
                    } else {
                        replyToApp(iframe, {
                            type: "agex-cache-get-result",
                            id,
                            data: null,
                            error:
                                "getCacheValue() isn't available here",
                        });
                    }
                } catch (err) {
                    replyToApp(iframe, {
                        type: "agex-cache-get-result",
                        id,
                        data: null,
                        error: err.message || String(err),
                    });
                }
                done();
            })();
            pendingHandlers.push(p);
            return;
        }
    };
    return handler;
}

/** How long a drained queue waits for a call the last result set off. */
const CHAIN_GRACE_MS = 300;

/**
 * Why a test's app didn't come up within `ms`. The apps host's page
 * either never loaded (it's unreachable), or loaded and was sent the
 * app, which then never got as far as its bridge: most likely an error
 * as the app's script ran, or, running the studio locally, a studio
 * origin the apps host doesn't take apps from (it ignores those
 * without a word).
 *
 * @param {boolean} hostReady the apps host's page loaded and asked for the app
 * @param {number} ms
 */
export function bootFailure(hostReady, ms) {
    if (!hostReady) {
        return `test_app: the app sandbox at ${APPS_ORIGIN} didn't load within ${ms}ms ` +
            "(it may be unreachable), so the app never ran.";
    }
    let text = `test_app: iframe failed to come up within ${ms}ms — ` +
        `the bootloader loaded but the app's bridge never posted ready. ` +
        `Most likely: a module-eval error in your app's index.js / index.jsx ` +
        `(syntax error, failed import). Check the browser console for the underlying error.`;
    if (import.meta.env.DEV) {
        text += " (Or, in development: the app sandbox takes apps only from the studio origins " +
            "it knows, localhost ports 5173 and 4173 among them, and quietly ignores others; " +
            `this studio is at ${location.origin}.)`;
    }
    return text;
}

/** How long the hidden iframe's bootloader has to load and the app's
 *  bridge to post ready. The bridge runs as soon as the page parses,
 *  ahead of the app's own imports, so this is about the sandbox and the
 *  page, not the app's dependencies: 10s tells "the iframe never came
 *  up" from "the app crashed during render" without waiting long. */
const BRIDGE_READY_TIMEOUT_MS = 10000;

/** How long the first action waits for the app's page to finish
 *  loading (its document's `load`: module scripts with their static
 *  imports, images, styles). A cold esm.sh import takes seconds, so
 *  this is generous; past it the actions run anyway, with a note. */
export const LOAD_TIMEOUT_MS = 30_000;

/** The idle gap after the page loaded, before the first action. Apps
 *  that defer state init through a `useEffect` (vs synchronous
 *  `useState(() => init())`) take a couple of frames after load before
 *  the DOM stabilizes, and a first call to the studio may follow; the
 *  per-action default (400ms) is too tight for that. */
const COLD_START_IDLE_GAP_MS = 1000;

/**
 * Wait for the app in `iframe` to finish its first load: its page's
 * document `load` (the frame has a page whose module scripts ran, with
 * their static imports), then the app's calls to the studio settling
 * (`waitForIdle`). A page that hasn't loaded within `loadMs` gets the
 * actions anyway, and a note saying so.
 *
 * @param {object} iframe
 * @param {{ loadMs?: number }} [opts]
 * @returns {Promise<object | null>} the note, or null
 */
export async function settleFirstLoad(iframe, { loadMs = LOAD_TIMEOUT_MS } = {}) {
    const loaded = await waitForLoad(iframe, loadMs);
    await waitForIdle(iframe, 15000, COLD_START_IDLE_GAP_MS);
    if (loaded) return null;
    return {
        type: "log",
        level: "warn",
        message:
            `test_app: the app's page hadn't finished loading after ${Math.round(loadMs / 1000)}s ` +
            "(a module import, a script, an image or a stylesheet still loading), so the " +
            "actions ran on the page as it was.",
    };
}

/**
 * Point `iframe` at the apps origin's bootloader and settle once the
 * app's control bridge posts ready, or reject past
 * `BRIDGE_READY_TIMEOUT_MS` (`bootFailure` says why). The frame is
 * appended to the page the first time; after that, setting its `src`
 * navigates it, for a fresh page.
 *
 * We can't rely on the iframe element's `load`: it fires for the
 * bootloader, and again only once the written page has loaded, which
 * for an app with cold imports is seconds after its bridge is up.
 *
 * @param {HTMLIFrameElement} iframe
 */
function _bootFrame(iframe) {
    // whether the apps host's page loaded and asked for the app
    let hostReady = false;
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            window.removeEventListener("message", readyListener);
            reject(new Error(bootFailure(hostReady, BRIDGE_READY_TIMEOUT_MS)));
        }, BRIDGE_READY_TIMEOUT_MS);
        const readyListener = (event) => {
            if (!isFromAppFrame(event, iframe)) return;
            if (event.data?.type === "agex-host-ready") hostReady = true;
            if (event.data?.type !== "agex-bridge-ready") return;
            clearTimeout(timeout);
            window.removeEventListener("message", readyListener);
            resolve(undefined);
        };
        window.addEventListener("message", readyListener);
        iframe.src = `${APPS_ORIGIN}/?t=${Date.now()}`;
        if (!iframe.isConnected) document.body.appendChild(iframe);
    });
}

/** How many keys a bag has, said in a few words. */
const _keys = (bag, store) => {
    const n = Object.keys(bag).length;
    return `${n} ${store} key${n === 1 ? "" : "s"}`;
};

/**
 * Run a headless app test in a hidden iframe.
 *
 * Builds the iframe's page via the caller-provided `buildAppPage`, wires
 * the cache/task bridges, waits for the app's first load, runs
 * `actions`, collects console + action results, returns the lot.
 * Always tears the iframe down on resolve or reject.
 *
 * The page's storage is the test's own: seeded from `appStorageSeed`,
 * never written back. A `{ reload: true }` action rebuilds the page
 * from the same files in the same iframe, seeded with what the test's
 * pages wrote to `localStorage` and `sessionStorage` so far (each
 * reports its storage as it changes: `agex-test-storage`), and waits
 * for its first load again.
 *
 * Its `agex.db` calls run on the database `dbHandler` gives (the
 * caller's to choose and to close), and fail without one.
 *
 * @param {{
 *   appFiles: Record<string, string>,
 *   appBinaries?: Record<string, Uint8Array>,
 *   actions?: Array<object>,
 *   appStorageSeed?: Record<string, string>,
 *   buildAppPage: (files: Record<string, string>, opts?: any) => Promise<import("./app-html.js").AppPage>,
 *   reseedAppPage?: ((page: import("./app-html.js").AppPage, storage: any) => import("./app-html.js").AppPage) | null,
 *   cacheHandler?: ((key: string) => Promise<unknown>) | null,
 *   taskHandler?: ((call: { spec: unknown, inputs: unknown }) => Promise<unknown>) | null,
 *   dbHandler?: (() => Promise<import("@agex-ts/kvsql/client").DatabaseClient>) | null,
 *   viewport?: string | { width?: number, height?: number },
 * }} opts
 * @returns {Promise<Array<object>>}
 */
export async function runTestApp(opts) {
    const {
        appFiles,
        appBinaries = {},
        actions = [],
        appStorageSeed = {},
        buildAppPage,
        reseedAppPage = null,
        cacheHandler = null,
        taskHandler = null,
        dbHandler = null,
        viewport = null,
    } = opts;
    const { width: vpWidth, height: vpHeight } = resolveViewport(viewport);

    let iframe = null;
    let messageHandler = null;
    const pendingHandlers = [];
    /** What comes before the page's console output in the result: a
     *  note that the first load didn't finish, and the console output
     *  of pages a reload replaced. */
    const leading = [];

    try {
        if (!appFiles || Object.keys(appFiles).length === 0) {
            return [
                {
                    type: "log",
                    level: "error",
                    message: "No app files found in app/ directory",
                },
            ];
        }

        // Read-only: test_app shouldn't write speculative state back
        // to the user's session — keeps tests isolated and
        // deterministic. The page reports its storage to the test
        // alone, for a reload.
        const page = await buildAppPage(appFiles, {
            appBinaries,
            appStorage: { seed: appStorageSeed, writeable: false, report: true },
        });
        /** What the test's pages hold in storage, as last reported. */
        let storage = { local: { ...appStorageSeed }, session: {} };
        /** The page the bootloader is sent when it next asks; null when
         *  none is due. */
        let due = page;

        iframe = document.createElement("iframe");
        // In-viewport but visually hidden: in-viewport so the browser
        // doesn't throttle CSS @keyframes animations on the assumption
        // that nothing's visible (the classic "iframe at left:-9999px"
        // trick triggers Chromium's animation-throttle optimization,
        // leaving keyframe animations stuck at the initial frame even
        // though transitions / rAF still run). opacity:0 +
        // pointer-events:none + z-index:-1 keeps the user from seeing
        // or interacting with it.
        // Size to the resolved viewport so the app lays out (media
        // queries, window.innerWidth) exactly as it would on a device of
        // that shape — and screenshots capture at that shape.
        iframe.style.cssText =
            `position:fixed;top:0;left:0;width:${vpWidth}px;height:${vpHeight}px;` +
            "opacity:0;pointer-events:none;z-index:-1;";
        // No sandbox attribute — the cross-origin separation between
        // agex.studio and apps.agex.studio provides the isolation
        // that `sandbox="allow-scripts"` used to. The `allow` list
        // matches the live AppPreview iframe so test_app behavior
        // mirrors what the user sees.
        iframe.allow =
            "autoplay; microphone; camera; geolocation; gyroscope; " +
            "accelerometer; magnetometer; midi; fullscreen; " +
            "screen-wake-lock; web-share; clipboard-write";

        // The bridge listener doubles as the bootloader handshake
        // responder: it posts `agex-host-init` with the page due in
        // response to the bootloader's `agex-host-ready` signal.
        messageHandler = _attachBridges(
            iframe,
            cacheHandler,
            pendingHandlers,
            () => {
                const next = due;
                due = null;
                return next;
            },
            taskHandler,
            (bags) => {
                storage = bags;
            },
            dbHandler,
        );
        window.addEventListener("message", messageHandler);

        await _bootFrame(iframe);
        const frame = iframe;
        const loadNote = await settleFirstLoad(frame);
        if (loadNote) leading.push(loadNote);

        /** Rebuild the page from the same files, with the storage the
         *  test's pages wrote, and wait for its first load. */
        const reload = reseedAppPage === null ? null : async () => {
            // the old page's console output, and a round trip after which
            // every storage report it posted has arrived
            const before = await _pageLogs(frame);
            if (before.length > 0) {
                leading.push(...before, { type: "log", level: "info", message: "(test_app reloaded the page: the console output after this is the new page's)" });
            }
            const kept = storage;
            const next = reseedAppPage(page, { seed: kept.local, writeable: false, report: true, sessionSeed: kept.session });
            pageGone(frame, "studio");
            callsLost(frame);
            due = next;
            await _bootFrame(frame);
            const note = await settleFirstLoad(frame);
            return [
                {
                    type: "reload",
                    message: `reloaded: the page rebuilt from the same files, with the test's storage kept (${_keys(kept.local, "localStorage")}, ${_keys(kept.session, "sessionStorage")}${dbHandler ? ", and its agex.db" : ""})`,
                },
                ...(note ? [note] : []),
            ];
        };

        // testApp owns a hidden iframe, so mid-run `{ viewport }` resizes
        // are safe — they let one boot capture several breakpoints.
        const actionResults = await executeActions(frame, actions, {
            allowViewport: true,
            reload,
        });

        // Drain any handler promises spawned by actions but not yet
        // resolved (e.g. a long-running chunk generation kicked off
        // by the final click). Handlers added while we're awaiting
        // get picked up by the next iteration.
        // One queue, drained in place: the bridge pushes to the array it
        // was given. A call a result sets off (one task's value starting
        // the next) arrives a moment after that result goes back, so
        // once drained, wait a beat for it before calling the app idle.
        for (;;) {
            while (pendingHandlers.length > 0) {
                await Promise.allSettled(pendingHandlers.splice(0));
            }
            await new Promise((resolve) => setTimeout(resolve, CHAIN_GRACE_MS));
            if (pendingHandlers.length === 0) break;
        }

        return await collectResults(frame, actionResults, leading);
    } catch (e) {
        // A failed action escapes: agent's emission errors out
        // (per agex-ts's recoverable-error path), agent sees the
        // failure on the next turn and self-corrects. Other failures
        // (test_app infrastructure / harness errors, iframe load
        // failures) get wrapped as a result entry so the agent sees
        // the failure but the chat loop continues normally.
        if (_endsTheCall(e)) {
            // with the console's output, under the same bounds as a passing call's
            e.results = await collectResults(iframe, e.results ?? [], leading);
            throw e;
        }
        return [
            {
                type: "log",
                level: "error",
                message: "test_app failed: " + (e.message || String(e)),
            },
        ];
    } finally {
        if (messageHandler) window.removeEventListener("message", messageHandler);
        if (iframe) iframe.remove();
    }
}

/**
 * Operate on the existing live preview iframe. Caller passes the
 * iframe ref; we don't reach into module-level state here so this
 * stays pure / testable.
 *
 * A preview that is still loading (it just rebuilt) is waited for as
 * a test's first load is (`settleFirstLoad`): its page's `load`, then
 * the app's calls to the studio settling. One that loaded long ago
 * starts at once.
 *
 * @param {{
 *   iframe: HTMLIFrameElement | null,
 *   actions?: Array<object>,
 *   loadMs?: number,
 * }} opts
 * @returns {Promise<Array<object>>}
 */
export async function runLiveApp(opts) {
    const { iframe, actions = [], loadMs = LOAD_TIMEOUT_MS } = opts;
    /** A note that the preview's page hadn't loaded, before its console output. */
    const leading = [];
    try {
        if (!iframe || !iframe.contentWindow) {
            return [
                {
                    type: "log",
                    level: "error",
                    message: "No live app preview is active",
                },
            ];
        }
        const loading = !hasLoaded(iframe);
        if (!(await waitForLoad(iframe, loadMs))) {
            leading.push({
                type: "log",
                level: "warn",
                message: `live_app: the preview's page hadn't finished loading after ${Math.round(loadMs / 1000)}s, so the actions ran on it as it was.`,
            });
        }
        if (loading) await waitForIdle(iframe, 15000, COLD_START_IDLE_GAP_MS);
        const actionResults = await executeActions(iframe, actions);
        return await collectResults(iframe, actionResults, leading);
    } catch (e) {
        // Same failed-action rule as `runTestApp`.
        if (_endsTheCall(e)) {
            e.results = await collectResults(iframe, e.results ?? [], leading);
            throw e;
        }
        return [
            {
                type: "log",
                level: "error",
                message: "live_app failed: " + (e.message || String(e)),
            },
        ];
    }
}
