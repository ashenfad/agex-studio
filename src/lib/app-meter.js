/**
 * The odometer for a session's app agent: what its agent calls have
 * cost since the person last reset it (calls, model calls and tokens),
 * its last few calls, and whether the limiter is on. Kept per session in
 * the studio's own `localStorage`, on this device: not in the session's
 * store, where an undo would rewind it.
 *
 * The limiter is a rate rule, not an allowance: more than `RATE.calls`
 * task calls, or `RATE.modelCalls` model calls of the app's own agent
 * (`agex.model`), inside `RATE.windowMs` reads as a loop (a call from a
 * render, an effect, a timer), and pauses the app's calls until the
 * person says whether to go on. Model calls have the higher rate since
 * one turn of a chat makes several.
 *
 * The app's own agent's model calls are listed in bursts: one that
 * starts within `BURST_MS` of the last one ending joins its entry, so
 * the list shows roughly a turn each, not every model call.
 */

/** Past this many calls inside the window, the limiter pauses: task
 *  calls, and model calls through `agex.model`, each on its own count. */
export const RATE = { calls: 10, modelCalls: 60, windowMs: 60_000 };
/** The calls the meter lists, newest first. */
export const RECENT = 10;
/** A model call starting this soon after the last one ended is listed
 *  with it. */
export const BURST_MS = 30_000;
/** What the meter lists the app's own agent's model calls as. */
export const MODEL_TASK = "agex.model";

const PREFIX = "agex-studio-meter:";

/**
 * One call, as the meter lists it: a task call, or (`model`) a burst of
 * the app's own agent's model calls.
 *
 * @typedef {{ task: string, at: number, ms: number, ok: boolean, steps: number, inputTokens: number, outputTokens: number, error?: string, model?: true }} MeterCall
 */

/**
 * @typedef {{
 *   since: number,
 *   calls: number,
 *   failed: number,
 *   steps: number,
 *   inputTokens: number,
 *   cacheReadTokens: number,
 *   cacheWriteTokens: number,
 *   outputTokens: number,
 *   recent: MeterCall[],
 *   limiter: boolean,
 * }} Meter
 */

/** A meter at zero, counting from `now`, the limiter as given.
 *  @param {number} now @param {boolean} [limiter] @returns {Meter} */
export function emptyMeter(now, limiter = true) {
    return { since: now, calls: 0, failed: 0, steps: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, recent: [], limiter };
}

/** A model reply's usage added in. @param {Meter} m @param {import("agex-ts").Usage} u @returns {Meter} */
export function addReply(m, u) {
    return {
        ...m,
        steps: m.steps + 1,
        inputTokens: m.inputTokens + u.inputTokens,
        cacheReadTokens: m.cacheReadTokens + u.cacheReadTokens,
        cacheWriteTokens: m.cacheWriteTokens + u.cacheWriteTokens,
        outputTokens: m.outputTokens + u.outputTokens,
    };
}

/** A call that ended, counted and listed. @param {Meter} m @param {MeterCall} call @returns {Meter} */
export function addCall(m, call) {
    return { ...m, calls: m.calls + 1, failed: m.failed + (call.ok ? 0 : 1), recent: [call, ...m.recent].slice(0, RECENT) };
}

/**
 * A model call of the app's own agent that ended, listed: with the burst
 * it follows (newest in the list, ended less than `BURST_MS` before it
 * started), or as a new entry, which counts as a call. A burst counts
 * as failed once, when a call in it first fails.
 *
 * @param {Meter} m
 * @param {Omit<MeterCall, "task" | "model">} call
 * @returns {Meter}
 */
export function addModelCall(m, call) {
    const last = m.recent[0];
    if (last?.model !== true || call.at - (last.at + last.ms) >= BURST_MS) return addCall(m, { task: MODEL_TASK, ...call, model: true });
    const error = call.error ?? last.error;
    /** @type {MeterCall} */
    const burst = {
        ...last,
        ms: Math.max(last.ms, call.at + call.ms - last.at),
        ok: last.ok && call.ok,
        steps: last.steps + call.steps,
        inputTokens: last.inputTokens + call.inputTokens,
        outputTokens: last.outputTokens + call.outputTokens,
        ...(error !== undefined && { error }),
    };
    return { ...m, failed: m.failed + (last.ok && !call.ok ? 1 : 0), recent: [burst, ...m.recent.slice(1)] };
}

/** Whether a call starting at `now` breaks the rate, given when the
 *  calls before it started: past `limit` (task calls' by default).
 *  @param {number[]} starts @param {number} now @param {number} [limit] */
export function overRate(starts, now, limit = RATE.calls) {
    return starts.filter((t) => now - t < RATE.windowMs).length >= limit;
}

/** The session a `localStorage` key holds the meter of, or null for a
 *  key that isn't a meter's. @param {string | null} key */
export function meterSession(key) {
    return key !== null && key.startsWith(PREFIX) ? key.slice(PREFIX.length) : null;
}

/** Session `name`'s meter, or null when it has none (or it can't be
 *  read). @param {string} name @returns {Meter | null} */
export function loadMeter(name) {
    try {
        const raw = localStorage.getItem(PREFIX + name);
        if (raw === null) return null;
        const m = JSON.parse(raw);
        if (m === null || typeof m !== "object" || typeof m.calls !== "number") return null;
        return { ...emptyMeter(Date.now()), ...m, recent: Array.isArray(m.recent) ? m.recent : [] };
    } catch {
        return null;
    }
}

/** Keep session `name`'s meter; a storage that's full keeps the one
 *  before. @param {string} name @param {Meter} m */
export function saveMeter(name, m) {
    try {
        localStorage.setItem(PREFIX + name, JSON.stringify(m));
    } catch {
        // the page's count still runs
    }
}

/** Forget session `name`'s meter. @param {string} name */
export function removeMeter(name) {
    try {
        localStorage.removeItem(PREFIX + name);
    } catch {
        // nothing to forget
    }
}

/**
 * `provider`, reporting each reply's usage to `onReply` as it arrives.
 *
 * @param {import("agex-ts").Provider} provider
 * @param {(usage: import("agex-ts").Usage) => void} onReply
 * @returns {import("agex-ts").Provider}
 */
export function metered(provider, onReply) {
    return {
        name: provider.name,
        async *stream(messages, tools, settings, opts) {
            for await (const event of provider.stream(messages, tools, settings, opts)) {
                if (event.kind === "Reply") onReply(event.message.usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
                yield event;
            }
        },
        transient: (error) => provider.transient(error),
        ...(provider.describe && { describe: (/** @type {unknown} */ error) => provider.describe?.(error) ?? null }),
    };
}
