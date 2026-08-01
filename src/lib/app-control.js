/**
 * Iframe-control orchestration for `test_app` and `live_app` —
 * kernel-agnostic main-thread DOM logic shared by both kernels'
 * agent-side `agent.fn` registrations.
 *
 * Why this file exists: the helpers were originally inside
 * `pyodide.js` because Pyodide was the only kernel and these
 * functions ran on the main thread when the worker round-tripped
 * `_js_test_app(...)` / `_js_live_app(...)` calls. With agex-ts
 * registrations going host-resident through `agent.fn`, the same
 * orchestration needs to be reachable from a non-Pyodide context.
 * Extracted here with a `Promise<results>` API instead of the
 * worker-postMessage shape.
 *
 * Callers wire kernel-specific bridges in via the `queryHandler` and
 * `cacheHandler` options:
 *   - `queryHandler(code, resultVars)` powers iframe `query()` calls.
 *     Today: py adapter's `runQuery` on the py side; null on TS
 *     (TS adapter's `runQuery` stub throws — apps that need data
 *     should use `getCacheValue` instead).
 *   - `cacheHandler(key)` powers iframe `getCacheValue()` calls.
 *     Today: ts adapter's `getCacheValue` on the ts side; null on
 *     py (py apps use `query()`).
 *
 * `buildAppHtml` and the `liveIframe` ref still live in `pyodide.js`
 * — caller passes them in. Avoids a circular import and lets
 * `pyodide.js` remain the single source of truth for HTML composition.
 */

import { sendControl } from "./iframe-bridge.js";
import { APPS_ORIGIN, isFromAppFrame, replyToApp } from "./apps-origin.js";

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

/** Settle once the iframe stops triggering query/effects, or
 *  `maxMs` elapses. The control bridge calls `iframe.__onQueryDone`
 *  whenever a query handler resolves; we watch for an idle gap (no
 *  resets) to consider the app idle.
 *
 *  Default `idleGap` is 400ms. Sized for the typical chat-app
 *  pattern: a click fires a query (postMessage round-trip ~50ms),
 *  the response handler may fire another query immediately. Tight
 *  chains keep the timer extending via `__onQueryDone`; the gap
 *  only fires when the chain genuinely ends. 400ms is also enough
 *  margin for ~300ms debounced patterns (typical debounce sizes)
 *  to fire their first query before we settle.
 *
 *  Caps:
 *    - Per-action waits use the default 400ms gap. With many
 *      click-driven actions in a single `testApp` call (5+ clicks),
 *      a 2000ms-per-click cushion would blow past the worker's
 *      emission timeout for what's usually trivial work.
 *    - Apps that need more time per action: agent inserts an
 *      explicit `{ wait: N }` action. Apps with slow backends
 *      (>400ms first-query latency): same.
 *
 *  Override per-call when a known-slow path needs more headroom. */
export function waitForIdle(iframe, maxMs = 15000, idleGap = 400) {
    return new Promise((resolve) => {
        let idleTimer = null;
        const maxTimer = setTimeout(() => {
            clearTimeout(idleTimer);
            resolve();
        }, maxMs);

        function resetIdle() {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
                clearTimeout(maxTimer);
                resolve();
            }, idleGap);
        }

        iframe.__onQueryDone = () => resetIdle();
        resetIdle();
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
const SYNC_ACTION_KEYS = ["read", "eval", "assert", "screenshot", "get-logs"];

function _isSyncAction(action) {
    return SYNC_ACTION_KEYS.some((k) => action[k] !== undefined);
}

/** Marker prefix the iframe bridge stamps on assertion-failure
 *  errors. We use the prefix (not `instanceof AssertionError`)
 *  because postMessage doesn't preserve Error subclass identity. */
function _isAssertionError(e) {
    return typeof e?.message === "string" &&
        e.message.startsWith("AssertionError:");
}

/** Marker prefix `sendControl` stamps when the iframe navigated /
 *  reloaded mid-action (e.g. `location.reload()`). Once that happens the
 *  control bridge is gone, so the remaining actions can't run — we
 *  surface this one and stop the sequence rather than hang on each. */
function _isNavigationError(e) {
    return typeof e?.message === "string" &&
        e.message.startsWith("NavigationError:");
}

/** Execute `actions` sequentially against `iframe`'s control bridge.
 *  Returns the read/eval/screenshot result entries (the bridge
 *  itself dispatches click/type/select with no return).
 *
 *  Per-action settling: only async-triggering actions (click, type,
 *  select) get an automatic `waitForIdle` after dispatch, since
 *  those run app-side handlers that may fire `query()` /
 *  `getCacheValue()` / `fetch()`. Sync actions (eval, read,
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
 *
 *  Error handling: most action-dispatch failures are caught and
 *  surfaced as `error`-level log entries so a single bad selector
 *  doesn't terminate the test. Assertion failures are the
 *  exception — they propagate so the agent's emission errors out
 *  and the recoverable-error path lets the agent see the failure
 *  and self-correct on the next turn.
 *
 *  @param {HTMLIFrameElement} iframe
 *  @param {Array<object>} actions
 *  @param {{ allowViewport?: boolean }} [opts]
 */
export async function executeActions(iframe, actions, opts = {}) {
    const { allowViewport = false } = opts;
    const results = [];
    for (const action of actions) {
        if (action.wait) {
            await new Promise((r) => setTimeout(r, action.wait));
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
            // Let layout reflow + any resize-driven re-render / query
            // settle before the next action (e.g. a screenshot) runs.
            await waitForIdle(iframe, 10000);
            continue;
        }
        try {
            const data = await sendControl(iframe, action);
            if (data != null) results.push(data);
        } catch (e) {
            if (_isAssertionError(e)) throw e;
            if (_isNavigationError(e)) {
                // The app tore itself down — every remaining action would
                // hang the same way. Record the cause and stop here.
                results.push({ type: "log", level: "error", message: e.message });
                break;
            }
            results.push({
                type: "log",
                level: "error",
                message: `Action failed: ${e.message}`,
            });
        }
        if (!_isSyncAction(action)) {
            await waitForIdle(iframe, 10000);
        }
    }
    return results;
}

/** Pull the iframe's collected console logs and append the action
 *  results. Capped at 200 entries to keep test_app turn output
 *  bounded — long-tail logs would crowd the agent's context. */
export async function collectResults(iframe, actionResults) {
    let logs = [];
    try {
        const data = await sendControl(iframe, { "get-logs": true });
        logs = (data?.logs || []).map((e) => ({
            type: "log",
            level: e.level,
            message: e.message,
        }));
    } catch {
        /* ignore — collecting logs is best-effort */
    }
    const capped = [...logs, ...actionResults].slice(0, 200);
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
 *  `initHtml`, when provided, makes the listener double as the
 *  bootloader handshake responder: on receiving the bootloader's
 *  `agex-host-ready` signal, the listener posts `agex-host-init`
 *  with the HTML so the bootloader can document.write it. This
 *  keeps the cross-origin handshake colocated with the rest of
 *  the per-iframe message handling. */
function _attachBridges(iframe, queryHandler, cacheHandler, pendingHandlers, initHtml = null) {
    let initPosted = false;
    const handler = (event) => {
        // Only accept messages from the app iframe's window at the apps
        // origin (see isFromAppFrame in apps-origin.js).
        if (!isFromAppFrame(event, iframe)) return;
        const data = event.data;
        if (!data) return;

        // Bootloader handshake — respond once per iframe with the
        // app HTML so the bootloader can render it.
        if (data.type === "agex-host-ready" && !initPosted && initHtml) {
            initPosted = true;
            replyToApp(iframe, { type: "agex-host-init", html: initHtml });
            return;
        }

        if (data.type === "agex-query") {
            const { id, code, result } = data;
            const p = (async () => {
                try {
                    const out = queryHandler
                        ? await queryHandler(code, result)
                        : null;
                    if (queryHandler) {
                        replyToApp(iframe, { type: "agex-query-result", id, data: out, error: null });
                    } else {
                        replyToApp(iframe, {
                            type: "agex-query-result",
                            id,
                            data: null,
                            error:
                                "query() not available on this kernel — use getCacheValue() instead",
                        });
                    }
                } catch (err) {
                    replyToApp(iframe, {
                        type: "agex-query-result",
                        id,
                        data: null,
                        error: err.message || String(err),
                    });
                }
                iframe.__onQueryDone?.();
            })();
            pendingHandlers.push(p);
            return;
        }

        if (data.type === "agex-cache-get") {
            const { id, key } = data;
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
                                "getCacheValue() not available on this kernel — use query() instead",
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
                iframe.__onQueryDone?.();
            })();
            pendingHandlers.push(p);
            return;
        }
    };
    return handler;
}

/**
 * Run a headless app test in a hidden iframe.
 *
 * Builds the iframe via the caller-provided `buildAppHtml`, wires
 * query/cache bridges, runs `actions`, collects console + action
 * results, returns the lot. Always tears the iframe down on resolve
 * or reject.
 *
 * @param {{
 *   appFiles: Record<string, string>,
 *   appBinaries?: Record<string, Uint8Array>,
 *   actions?: Array<object>,
 *   appStorageSeed?: Record<string, string>,
 *   buildAppHtml: (files: Record<string, string>, opts?: any) => Promise<string>,
 *   queryHandler?: ((code: string, resultVars: string[] | null) => Promise<unknown>) | null,
 *   cacheHandler?: ((key: string) => Promise<unknown>) | null,
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
        buildAppHtml,
        queryHandler = null,
        cacheHandler = null,
        viewport = null,
    } = opts;
    const { width: vpWidth, height: vpHeight } = resolveViewport(viewport);

    let iframe = null;
    let messageHandler = null;
    let pendingHandlers = [];

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
        // deterministic.
        const html = await buildAppHtml(appFiles, {
            appBinaries,
            appStorage: { seed: appStorageSeed, writeable: false },
        });

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
        // responder when an initHtml payload is passed in. It posts
        // `agex-host-init` to the iframe in response to the
        // bootloader's `agex-host-ready` signal.
        messageHandler = _attachBridges(
            iframe,
            queryHandler,
            cacheHandler,
            pendingHandlers,
            html,
        );
        window.addEventListener("message", messageHandler);

        // Wait for the iframe's control bridge to come up. We can't
        // rely on a 2nd `load` event after the bootloader's
        // document.write — `document.open()` from inside an iframe
        // replaces the document but doesn't fire a fresh `load` on
        // the iframe *element* (no navigation occurred). Instead the
        // bridge script (injected by buildAppHtml at the end of the
        // app HTML) posts `agex-bridge-ready` after `installControlBridge`
        // returns, which is the real post-parse / scripts-ran signal.
        //
        // 10s ceiling distinguishes "iframe boot failed" (which would
        // otherwise wait for the worker's full 60s emission timeout
        // with an opaque message) from "app crashed during render" —
        // the agent sees a focused error pointing at the right thing.
        const BRIDGE_READY_TIMEOUT_MS = 10000;
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                window.removeEventListener("message", readyListener);
                reject(new Error(
                    `test_app: iframe failed to come up within ${BRIDGE_READY_TIMEOUT_MS}ms — ` +
                    `the bootloader loaded but the app's bridge never posted ready. ` +
                    `Most likely: a module-eval error in your app's index.js / index.jsx ` +
                    `(syntax error, failed import). Check the browser console for the underlying error.`,
                ));
            }, BRIDGE_READY_TIMEOUT_MS);
            const readyListener = (event) => {
                if (!isFromAppFrame(event, iframe)) return;
                if (event.data?.type !== "agex-bridge-ready") return;
                clearTimeout(timeout);
                window.removeEventListener("message", readyListener);
                resolve();
            };
            window.addEventListener("message", readyListener);
            iframe.src = `${APPS_ORIGIN}/?t=${Date.now()}`;
            document.body.appendChild(iframe);
        });
        // Initial settle. `onload` already fires after the document
        // fully loads, but apps that defer state init through a
        // `useEffect` (vs synchronous `useState(() => init())`) take
        // a couple of frames after onload before the DOM stabilizes.
        // Use a more generous idle gap here than the per-action
        // default (400ms) — agent-reported case: first assertion
        // running 50ms after onload saw an empty board because the
        // init effect hadn't committed yet. 1000ms covers the
        // effect chain on a cold-loaded app without slowing per-
        // action sequences (which keep their own tight 400ms gap).
        const COLD_START_IDLE_GAP_MS = 1000;
        await waitForIdle(iframe, 15000, COLD_START_IDLE_GAP_MS);

        // testApp owns a hidden iframe, so mid-run `{ viewport }` resizes
        // are safe — they let one boot capture several breakpoints.
        const actionResults = await executeActions(iframe, actions, {
            allowViewport: true,
        });

        // Drain any handler promises spawned by actions but not yet
        // resolved (e.g. a long-running chunk generation kicked off
        // by the final click). Handlers added while we're awaiting
        // get picked up by the next iteration.
        while (pendingHandlers.length > 0) {
            const batch = pendingHandlers;
            pendingHandlers = [];
            await Promise.allSettled(batch);
        }

        return await collectResults(iframe, actionResults);
    } catch (e) {
        // Assertion failures escape: agent's emission errors out
        // (per agex-ts's recoverable-error path), agent sees the
        // failure on the next turn and self-corrects. Other failures
        // (test_app infrastructure / harness errors, malformed
        // actions, iframe load failures) get wrapped as a result
        // entry so the agent sees the failure but the chat loop
        // continues normally.
        if (_isAssertionError(e)) throw e;
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
 * @param {{
 *   iframe: HTMLIFrameElement | null,
 *   actions?: Array<object>,
 * }} opts
 * @returns {Promise<Array<object>>}
 */
export async function runLiveApp(opts) {
    const { iframe, actions = [] } = opts;
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
        const actionResults = await executeActions(iframe, actions);
        return await collectResults(iframe, actionResults);
    } catch (e) {
        // Same assertion-escape rule as `runTestApp`.
        if (_isAssertionError(e)) throw e;
        return [
            {
                type: "log",
                level: "error",
                message: "live_app failed: " + (e.message || String(e)),
            },
        ];
    }
}
