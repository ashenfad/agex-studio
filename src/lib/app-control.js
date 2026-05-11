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
 *  Error handling: most action-dispatch failures are caught and
 *  surfaced as `error`-level log entries so a single bad selector
 *  doesn't terminate the test. Assertion failures are the
 *  exception — they propagate so the agent's emission errors out
 *  and the recoverable-error path lets the agent see the failure
 *  and self-correct on the next turn. */
export async function executeActions(iframe, actions) {
    const results = [];
    for (const action of actions) {
        if (action.wait) {
            await new Promise((r) => setTimeout(r, action.wait));
            continue;
        }
        try {
            const data = await sendControl(iframe, action);
            if (data != null) results.push(data);
        } catch (e) {
            if (_isAssertionError(e)) throw e;
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
    return [...logs, ...actionResults].slice(0, 200);
}

/** Wire iframe→parent message bridges to the caller-provided
 *  handlers. Returns the listener function so `runTestApp` can
 *  remove it on teardown. */
function _attachBridges(iframe, queryHandler, cacheHandler, pendingHandlers) {
    const handler = (event) => {
        if (!iframe || event.source !== iframe.contentWindow) return;
        const data = event.data;
        if (!data) return;

        if (data.type === "agex-query") {
            const { id, code, result } = data;
            const p = (async () => {
                try {
                    const out = queryHandler
                        ? await queryHandler(code, result)
                        : null;
                    if (queryHandler) {
                        iframe.contentWindow?.postMessage(
                            { type: "agex-query-result", id, data: out, error: null },
                            "*",
                        );
                    } else {
                        iframe.contentWindow?.postMessage(
                            {
                                type: "agex-query-result",
                                id,
                                data: null,
                                error:
                                    "query() not available on this kernel — use getCacheValue() instead",
                            },
                            "*",
                        );
                    }
                } catch (err) {
                    iframe.contentWindow?.postMessage(
                        {
                            type: "agex-query-result",
                            id,
                            data: null,
                            error: err.message || String(err),
                        },
                        "*",
                    );
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
                        iframe.contentWindow?.postMessage(
                            {
                                type: "agex-cache-get-result",
                                id,
                                data: out === undefined ? null : out,
                                error: null,
                            },
                            "*",
                        );
                    } else {
                        iframe.contentWindow?.postMessage(
                            {
                                type: "agex-cache-get-result",
                                id,
                                data: null,
                                error:
                                    "getCacheValue() not available on this kernel — use query() instead",
                            },
                            "*",
                        );
                    }
                } catch (err) {
                    iframe.contentWindow?.postMessage(
                        {
                            type: "agex-cache-get-result",
                            id,
                            data: null,
                            error: err.message || String(err),
                        },
                        "*",
                    );
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
 *   actions?: Array<object>,
 *   appStorageSeed?: Record<string, string>,
 *   buildAppHtml: (files: Record<string, string>, opts?: object) => string,
 *   queryHandler?: ((code: string, resultVars: string[] | null) => Promise<unknown>) | null,
 *   cacheHandler?: ((key: string) => Promise<unknown>) | null,
 * }} opts
 * @returns {Promise<Array<object>>}
 */
export async function runTestApp(opts) {
    const {
        appFiles,
        actions = [],
        appStorageSeed = {},
        buildAppHtml,
        queryHandler = null,
        cacheHandler = null,
    } = opts;

    let iframe = null;
    let blobUrl = null;
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
        const html = buildAppHtml(appFiles, {
            appStorage: { seed: appStorageSeed, writeable: false },
        });
        blobUrl = URL.createObjectURL(new Blob([html], { type: "text/html" }));

        iframe = document.createElement("iframe");
        // In-viewport but visually hidden: in-viewport so the browser
        // doesn't throttle CSS @keyframes animations on the assumption
        // that nothing's visible (the classic "iframe at left:-9999px"
        // trick triggers Chromium's animation-throttle optimization,
        // leaving keyframe animations stuck at the initial frame even
        // though transitions / rAF still run). opacity:0 +
        // pointer-events:none + z-index:-1 keeps the user from seeing
        // or interacting with it.
        iframe.style.cssText =
            "position:fixed;top:0;left:0;width:800px;height:600px;" +
            "opacity:0;pointer-events:none;z-index:-1;";
        iframe.sandbox = "allow-scripts";

        messageHandler = _attachBridges(
            iframe,
            queryHandler,
            cacheHandler,
            pendingHandlers,
        );
        window.addEventListener("message", messageHandler);

        await new Promise((resolve) => {
            iframe.onload = resolve;
            iframe.src = blobUrl;
            document.body.appendChild(iframe);
        });
        // Initial settle. `onload` already fires after the document
        // fully loads, so the default 400ms gap is plenty — apps
        // that fire queries from onload reset the timer through
        // `__onQueryDone` and the gap auto-extends.
        await waitForIdle(iframe);

        const actionResults = await executeActions(iframe, actions);

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
        if (blobUrl) URL.revokeObjectURL(blobUrl);
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
