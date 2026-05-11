/**
 * TS-side post-processors for `runTestApp` / `runLiveApp` results
 * before they go back to the agent.
 *
 * Both kernels share `app-control.js` and `iframe-bridge.js` for
 * the iframe-side orchestration, but the TS path needs two
 * adjustments the py path doesn't:
 *
 *   1. **`normalizeEvalValues`** — the iframe bridge JSON-stringifies
 *      eval values via `_jsonifyEvalResult` so the py side's
 *      `reprobate` renderer can budget-bound the output. JS callers
 *      working with the result array expect native JS instead of a
 *      JSON string — without this step, an agent calling
 *      `{ eval: 'JSON.stringify({x: 1})' }` gets back a doubly-
 *      encoded `'"{\"x\":1}"'`, which is silly.
 *
 *   2. **`emitObservations`** — emit screenshot success / capture-
 *      failure entries to the calling emission via `ctx.console.log`
 *      so the agent's next turn sees them even when the agent
 *      discarded `await testApp(...)`'s return value (the
 *      skill-by-example pattern teaches `await testApp([...])`
 *      without assignment, since screenshots auto-flow). Symmetric
 *      success/failure surfacing — failures used to silently sit in
 *      the unread results array.
 *
 * Both functions mutate `results` in place and return the same
 * array reference for chaining convenience.
 */

/**
 * Parse JSON-encoded eval values back to native JS for each
 * `type: 'eval'` entry in `results`. Walks the array once;
 * non-eval entries are left untouched. `value === null` (which the
 * bridge already passes through unstringified for `null` /
 * `undefined` eval results) is left alone. Malformed JSON would be
 * a bridge regression — defensive `catch` leaves the string in
 * place so the agent still sees usable text.
 *
 * @param {Array<any>} results
 * @returns {Array<any>}
 */
export function normalizeEvalValues(results) {
    for (const r of results) {
        if (r?.type === "eval" && typeof r.value === "string") {
            try {
                r.value = JSON.parse(r.value);
            } catch {
                // Leave as string. `_jsonifyEvalResult` always
                // produces valid JSON or `null`, so getting here
                // means something upstream regressed — preserve the
                // raw text so the agent has something to work with.
            }
        }
    }
    return results;
}

/**
 * Emit screenshots and screenshot-capture failures as observations
 * on the calling emission via `ctx.console.log`. Screenshots are
 * shipped as `{format, data}` image envelopes (agex-ts's
 * `console.log` shape-detects these into image OutputParts); the
 * data field is replaced with a sentinel so the returned array
 * doesn't carry the giant base64 blob (which would bloat event-log
 * persistence on taskSuccess). Capture failures are emitted as
 * text observations so the agent sees the reason on its next turn
 * even when they discarded `await testApp(...)`'s return value.
 *
 * @param {{ console: { log: (...args: any[]) => void } }} ctx
 *   agex-ts injects `ctx` into `wantsContext: true` host-bound fns;
 *   `ctx.console.log` enqueues OutputParts on the worker-side
 *   calling emission across the postMessage RPC boundary.
 * @param {Array<any>} results
 * @returns {Array<any>}
 */
export function emitObservations(ctx, results) {
    for (const r of results) {
        if (r?.type === "screenshot" && r.data) {
            ctx.console.log({ format: "png", data: r.data });
            r.data = "<emitted via console.log>";
        } else if (
            r?.type === "log" &&
            r.level === "error" &&
            typeof r.message === "string" &&
            r.message.startsWith("Screenshot failed:")
        ) {
            ctx.console.log(`[testApp] ${r.message}`);
        }
    }
    return results;
}
