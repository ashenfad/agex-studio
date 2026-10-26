/**
 * The studio's end of `agex.model()`: an app's own agent's model calls,
 * relayed. The app posts `agex-model` (`id`, `messages`, `tools`,
 * `settings`) for each request its provider makes; the studio runs it
 * (`appAgent.model`, on the viewer's model) and posts each event back as
 * `agex-model-event` (`id`, `event`: a text or thinking delta, then the
 * Reply), then `agex-model-end` (`id`, `error`: null, or the failure as
 * plain data the app rebuilds, the provider's judgment of it included).
 * An `agex-model-cancel` (`id`) from the app stops its call, and a page
 * that is replaced or closed has its calls stopped (`cancelModels`): the
 * answers would reach no one.
 *
 * The live preview and `test_app`'s hidden pages both answer through
 * here, each with its own runner.
 */

import { replyToApp } from "./apps-origin.js";

/**
 * A failed model call, as it crosses to the app: whether the viewer's
 * provider deems it worth resuming (`transient`), and how it puts it in
 * words (`describe`, or null).
 *
 * @typedef {{ name: string, message: string, transient: boolean, describe: string | null }} ModelFailure
 */

/**
 * Runs one model call: hands each event to `onEvent`, and stops when
 * `signal` aborts.
 *
 * @typedef {(call: { messages: unknown, tools: unknown, settings: unknown }, opts: { signal: AbortSignal, onEvent: (event: import("agex-ts").ProviderEvent) => void }) => Promise<void>} ModelRunner
 */

/** The model calls each frame's page has running, by id: their stops.
 *  @type {WeakMap<object, Map<string, AbortController>>} */
const running = new WeakMap();

/**
 * `e` as plain data the app rebuilds as an error.
 *
 * @param {unknown} e
 * @returns {ModelFailure}
 */
export function modelFailure(e) {
    const err = /** @type {any} */ (e);
    return {
        name: e instanceof Error || (err !== null && typeof err === "object" && typeof err.name === "string") ? String(err.name) : "Error",
        message: e instanceof Error ? e.message : String(e),
        transient: err?.transient === true,
        describe: typeof err?.description === "string" ? err.description : null,
    };
}

/**
 * Answer the `agex-model` message `data` from the page in `frame`: run it
 * on `run`, posting its events and its end back.
 *
 * @param {HTMLIFrameElement} frame
 * @param {{ id: unknown, messages?: unknown, tools?: unknown, settings?: unknown }} data
 * @param {ModelRunner | null} run null: the page has no model here
 * @returns {Promise<void>} settles once the end is posted
 */
export async function relayModel(frame, data, run) {
    const id = String(data.id);
    const stop = new AbortController();
    const calls = running.get(frame) ?? new Map();
    running.set(frame, calls);
    // an id still running is stopped first: only the newest could be
    // cancelled by it
    calls.get(id)?.abort();
    calls.set(id, stop);
    /** @type {ModelFailure | null} */
    let error = null;
    try {
        if (run === null) throw new Error("agex.model isn't available here");
        await run(
            { messages: data.messages, tools: data.tools, settings: data.settings },
            {
                signal: stop.signal,
                onEvent: (event) => {
                    try {
                        replyToApp(frame, { type: "agex-model-event", id, event });
                    } catch (e) {
                        // an event that can't be cloned: the call ends here
                        stop.abort(e);
                        throw e;
                    }
                },
            },
        );
    } catch (e) {
        error = modelFailure(e);
    } finally {
        if (calls.get(id) === stop) calls.delete(id);
    }
    replyToApp(frame, { type: "agex-model-end", id, error });
}

/** Stop the model call `id` of the page in `frame`, as its app asked.
 *  @param {HTMLIFrameElement} frame @param {unknown} id */
export function cancelModel(frame, id) {
    running.get(frame)?.get(String(id))?.abort();
}

/** Stop every model call of the page in `frame`: it was replaced or
 *  closed. @param {HTMLIFrameElement} frame */
export function cancelModels(frame) {
    const calls = running.get(frame);
    if (calls === undefined) return;
    for (const stop of calls.values()) stop.abort();
    calls.clear();
}
