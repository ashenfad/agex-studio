/**
 * Agents from apps: an app's own agent tasks, run by the studio on the
 * viewer's model.
 *
 * An app defines a task as agent code does (`agex.task({ name,
 * instructions, params, returns })`, the types as JSON Schema) and calls
 * it with its inputs; the call comes to the studio as a message, and the
 * studio runs it as an agex-ts task, on the viewer's model and key, in
 * a world of its own (`web` in it, when the key is OpenRouter's), and
 * sends the value back.
 *
 * A session of the person's own calls at once; one opened from
 * elsewhere (a bundle, a published link) asks first, since it is
 * someone else's code spending the viewer's key. What the calls cost
 * goes on the session's meter (`app-meter.js`), which the preview
 * shows, and its limiter pauses an app that calls too often, until the
 * person says whether to go on.
 *
 * An app can run an agent of its own, too: `agex.model()` in the app is
 * an agex-ts provider whose every request comes here (`model`), one
 * model call on the viewer's model, its events sent back as they
 * arrive. It asks, is metered and is limited as task calls are, on a
 * rate of its own.
 */

import workerUrl from "@agex-ts/world/worker?worker&url";
import { Agent, aiSdk, fromJsonSchema, isLanguageModel } from "agex-ts";
import { RATE, addCall, addModelCall, addReply, emptyMeter, loadMeter, meterSession, metered, overRate, removeMeter, saveMeter } from "./app-meter.js";
import { buildModel, thinkingOf } from "./model.js";
import { hasRouterKey } from "./openrouter-api.js";
import { scriptedNow } from "./scripted.js";
import { getSettings, isConfigured } from "./settings.js";
import { webHost } from "./web.js";

/** The most model calls one task call makes. */
const TASK_STEPS = 30;
/** The most tokens one model call of an app's own agent asks for, and
 *  what it asks for when the app's settings name none. */
const MODEL_MAX_TOKENS = 16_000;
const MODEL_DEFAULT_TOKENS = 8000;

/** What a task's world is given. */
const TASK_PROFILE = {
    code: {
        worker: { target: /** @type {const} */ ("browser"), url: workerUrl },
        /** @param {string} name */
        resolve: (name) => `https://esm.sh/${name}`,
    },
};

/**
 * A task as an app defines it: the call's `spec`.
 *
 * @typedef {{ name: string, instructions: string, params?: Record<string, object>, returns?: object }} AppTaskSpec
 */

/**
 * The spec, checked: a refusal names what is wrong.
 *
 * @param {unknown} spec
 * @returns {AppTaskSpec}
 */
export function checkSpec(spec) {
    const s = /** @type {any} */ (spec);
    if (s === null || typeof s !== "object") throw new Error("agex.task: give it { name, instructions, params, returns }");
    if (typeof s.name !== "string" || !/^[A-Za-z_][\w-]{0,63}$/.test(s.name)) {
        throw new Error("agex.task: name is an identifier (letters, digits, _ and -; at most 64)");
    }
    if (typeof s.instructions !== "string" || s.instructions.trim() === "") throw new Error(`agex.task ${s.name}: say what to do in instructions`);
    if (s.instructions.length > 20_000) throw new Error(`agex.task ${s.name}: instructions are past 20,000 characters`);
    if (s.params !== undefined && (s.params === null || typeof s.params !== "object" || Array.isArray(s.params))) {
        throw new Error(`agex.task ${s.name}: params map each input's name to its JSON Schema`);
    }
    for (const [k, v] of Object.entries(s.params ?? {})) {
        if (v === null || typeof v !== "object") throw new Error(`agex.task ${s.name}: params.${k} is a JSON Schema (an object)`);
    }
    if (s.returns !== undefined && (s.returns === null || typeof s.returns !== "object")) {
        throw new Error(`agex.task ${s.name}: returns is a JSON Schema (an object)`);
    }
    return s;
}

/**
 * A model call as an app's own agent sends it: agex-ts messages, tool
 * specs and settings.
 *
 * @typedef {{ messages: import("agex-ts").Message[], tools: import("agex-ts").ToolSpec[], settings: import("agex-ts").Settings }} AppModelCall
 */

/**
 * The call, checked: a refusal names what is wrong.
 *
 * @param {{ messages: unknown, tools: unknown, settings: unknown }} call
 * @returns {AppModelCall}
 */
export function checkModelCall({ messages, tools, settings }) {
    if (!Array.isArray(messages) || messages.length === 0) throw new Error("agex.model: stream takes the messages so far, a non-empty list");
    for (const m of messages) {
        if (m === null || typeof m !== "object" || typeof m.role !== "string" || !Array.isArray(m.parts)) {
            throw new Error("agex.model: each message is an agex-ts Message ({ id, role, parts })");
        }
    }
    if (!Array.isArray(tools)) throw new Error("agex.model: tools is a list of { name, description, parameters }");
    for (const t of tools) {
        if (t === null || typeof t !== "object" || typeof t.name !== "string" || t.parameters === null || typeof t.parameters !== "object") {
            throw new Error("agex.model: each tool is { name, description, parameters }, its parameters a JSON Schema");
        }
    }
    if (settings !== undefined && settings !== null && typeof settings !== "object") throw new Error("agex.model: settings is an object");
    return { messages, tools, settings: /** @type {import("agex-ts").Settings} */ (settings ?? {}) };
}

/**
 * What an app's agent's request goes with: its own token cap (within
 * the studio's) and temperature, the viewer's thinking. Provider-specific
 * settings (`extra`) are dropped: they could route the request to a
 * model the viewer didn't choose.
 *
 * @param {import("agex-ts").Settings} asked @param {import("./settings.js").Settings} s
 * @returns {import("agex-ts").Settings}
 */
export function modelSettings(asked, s) {
    const max = typeof asked.maxTokens === "number" && asked.maxTokens > 0 ? Math.min(Math.floor(asked.maxTokens), MODEL_MAX_TOKENS) : MODEL_DEFAULT_TOKENS;
    return {
        maxTokens: max,
        ...(typeof asked.temperature === "number" && { temperature: asked.temperature }),
        thinking: thinkingOf(s),
    };
}

/** A model call that failed, with what the viewer's provider makes of
 *  its error: whether it is worth resuming, and the error in words. */
export class AppModelError extends Error {
    /** @param {unknown} cause @param {import("agex-ts").Provider} provider */
    constructor(cause, provider) {
        super(cause instanceof Error ? cause.message : String(cause));
        this.name = cause instanceof Error ? cause.name : "Error";
        /** @type {boolean} */
        this.transient = provider.transient(cause);
        /** @type {string | null} */
        this.description = provider.describe?.(cause) ?? null;
    }
}

const STOPPED = "the person stopped this app's agent calls after it called often; they can let it go on from the preview's agent meter";
const GONE = "this app's session was deleted";
const HIDDEN_PAUSE = `this app made ${RATE.calls} agent calls inside a minute, which pauses its calls until the person says to go on, and a test with nobody watching can't: space the calls out, or the person can turn the limiter off in the preview's agent meter`;
const HIDDEN_MODEL_PAUSE = `this app's agent made ${RATE.modelCalls} model calls (agex.model) inside a minute, which pauses its calls until the person says to go on, and a test with nobody watching can't: make fewer turns in the test, or the person can turn the limiter off in the preview's agent meter`;
const NO_MODEL = "the person viewing this app hasn't chosen a model: its agent needs one (settings, ⚙)";

class AppAgent {
    /** Whether each session's app may use the model, this page, by
     *  session (an app from elsewhere is asked first). @type {Record<string, boolean>} */
    allowed = {};
    /** Apps asking to use the model, waiting for the person, by
     *  session: each its own question, answered for that app alone; for
     *  a task call, the task's name, or null for the app's own agent.
     *  @type {Record<string, { task: string | null, answer: (yes: boolean) => void }>} */
    asking = $state({});
    /** The meters read or written this page, by session.
     *  @type {Record<string, import("./app-meter.js").Meter>} */
    meters = $state({});
    /** Apps the limiter paused, waiting for the person to say whether
     *  to go on, by session: the calls made in the last minute, and
     *  whether they were model calls of the app's own agent.
     *  @type {Record<string, { calls: number, model: boolean, answer: (go: boolean) => void }>} */
    paused = $state({});
    /** Apps whose calls the person stopped when paused, until they let
     *  them go on, by session. @type {Record<string, true>} */
    stopped = $state({});
    /** When each session's recent task calls started, for the rate.
     *  @type {Map<string, number[]>} */
    #starts = new Map();
    /** When each session's recent model calls started, for theirs.
     *  @type {Map<string, number[]>} */
    #modelStarts = new Map();
    /** Each session's model calls running: their stops.
     *  @type {Map<string, Set<AbortController>>} */
    #streaming = new Map();
    /** How many times each session was forgotten: a call that began
     *  before writes nothing of it after. @type {Map<string, number>} */
    #generations = new Map();

    /** Whether session `name` was forgotten since `generation`.
     *  @param {string} name @param {number} generation */
    #gone(name, generation) {
        return (this.#generations.get(name) ?? 0) !== generation;
    }

    /** Session `name`'s meter, or null when its app has made no call
     *  here. @param {string} name */
    meterOf(name) {
        return this.meters[name] ?? loadMeter(name);
    }

    /** How many model calls session `name`'s app has running.
     *  @param {string} name */
    modelCalls(name) {
        return this.#streaming.get(name)?.size ?? 0;
    }

    constructor() {
        // another tab on the same session counts on the same meter: show
        // what it wrote
        if (typeof window !== "undefined") {
            window.addEventListener("storage", (e) => {
                const name = meterSession(e.key);
                if (name === null) return;
                const m = loadMeter(name);
                if (m === null) delete this.meters[name];
                else this.meters[name] = m;
            });
        }
    }

    /** Change session `name`'s meter, from what is stored (another
     *  tab's calls included), or this page's if none can be read.
     *  @param {string} name @param {(m: import("./app-meter.js").Meter) => import("./app-meter.js").Meter} change */
    #update(name, change) {
        const m = change(loadMeter(name) ?? this.meters[name] ?? emptyMeter(Date.now()));
        this.meters[name] = m;
        saveMeter(name, m);
    }

    /** Session `name` is gone: its meter, and this page's say on its
     *  app (allowed, paused, stopped), go with it; a call paused is
     *  refused, and a model call running is stopped. @param {string} name */
    forget(name) {
        this.#generations.set(name, (this.#generations.get(name) ?? 0) + 1);
        removeMeter(name);
        delete this.meters[name];
        delete this.allowed[name];
        delete this.stopped[name];
        this.#starts.delete(name);
        this.#modelStarts.delete(name);
        for (const stop of this.#streaming.get(name) ?? []) stop.abort(new Error(GONE));
        this.#streaming.delete(name);
        this.paused[name]?.answer(false);
        this.asking[name]?.answer(false);
    }

    /** Count session `name`'s app from zero again, and the limiter's
     *  minute with it; an app paused or stopped goes on. @param {string} name */
    reset(name) {
        this.#update(name, (m) => emptyMeter(Date.now(), m.limiter));
        this.goOn(name);
    }

    /** Turn session `name`'s limiter on or off; off lets a paused or
     *  stopped app go on. @param {string} name @param {boolean} on */
    setLimiter(name, on) {
        this.#update(name, (m) => ({ ...m, limiter: on }));
        if (!on) this.goOn(name);
    }

    /** Let session `name`'s app's calls go on: a pause answered, a stop
     *  lifted, the minute counted afresh. @param {string} name */
    goOn(name) {
        this.#starts.delete(name);
        this.#modelStarts.delete(name);
        delete this.stopped[name];
        this.paused[name]?.answer(true);
    }

    /** Ask the person whether session `session`'s app goes on, its
     *  calls paused (`model`: by its model calls); a call while the
     *  question is open waits on the same answer.
     *  @param {string} session @param {number} calls @param {boolean} model */
    #pause(session, calls, model) {
        return new Promise((resolve) => {
            const open = this.paused[session];
            if (open !== undefined) {
                const answer = open.answer;
                open.answer = (go) => {
                    answer(go);
                    resolve(go);
                };
                return;
            }
            this.paused[session] = {
                calls,
                model,
                answer: (go) => {
                    delete this.paused[session];
                    resolve(go);
                },
            };
        });
    }

    /** Hold a call of session `session`'s app while it breaks the rate
     *  (its task calls', or with `model` its model calls'), with the
     *  limiter on: until the person says to go on, or refused if they
     *  stop it, or if nobody is looking (`prompt` false), or if the
     *  session is forgotten meanwhile.
     *  @param {string} session @param {boolean} prompt @param {number} generation @param {boolean} [model] */
    async #limit(session, prompt, generation, model = false) {
        if (!(this.meterOf(session)?.limiter ?? true)) return;
        if (this.stopped[session]) throw new Error(STOPPED);
        const all = model ? this.#modelStarts : this.#starts;
        const now = Date.now();
        const starts = (all.get(session) ?? []).filter((t) => now - t < RATE.windowMs);
        all.set(session, starts);
        if (!overRate(starts, now, model ? RATE.modelCalls : RATE.calls)) return;
        if (!prompt) throw new Error(model ? HIDDEN_MODEL_PAUSE : HIDDEN_PAUSE);
        const go = await this.#pause(session, starts.length, model);
        if (this.#gone(session, generation)) throw new Error(GONE);
        if (go) {
            all.delete(session);
            return;
        }
        this.stopped[session] = true;
        throw new Error(STOPPED);
    }

    /** Ask whether session `session`'s app may use the model, for task
     *  `task` (null: for its own agent); a call while its question is
     *  open waits on the same answer.
     *  @param {string} session @param {string | null} task */
    #consent(session, task) {
        return new Promise((resolve) => {
            const open = this.asking[session];
            if (open !== undefined) {
                const answer = open.answer;
                open.answer = (yes) => {
                    answer(yes);
                    resolve(yes);
                };
                return;
            }
            this.asking[session] = {
                task,
                answer: (yes) => {
                    delete this.asking[session];
                    resolve(yes);
                },
            };
        });
    }

    /** Whether session `session`'s app may use the model, asking the
     *  person first when `ask` (for task `task`, or null for its own
     *  agent); refused if they say no, if nobody is looking to ask
     *  (`prompt` false), or if the session is forgotten meanwhile.
     *  @param {string} session @param {string | null} task @param {boolean} ask @param {boolean} prompt @param {number} generation */
    async #allow(session, task, ask, prompt, generation) {
        if (this.allowed[session] === undefined) {
            if (ask && !prompt) throw new Error("the person hasn't allowed this app to use their model yet: they can try it in the preview, which asks");
            const yes = !ask || (await this.#consent(session, task));
            if (this.#gone(session, generation)) throw new Error(GONE);
            this.allowed[session] ??= yes;
        }
        if (!this.allowed[session]) throw new Error("the person didn't allow this app to use their model");
    }

    /**
     * Run session `session`'s app's task call; its value, or an error
     * the app reads. What it costs goes on the session's meter.
     *
     * @param {string} session
     * @param {{ spec: unknown, inputs: unknown }} call
     * @param {{ ask: boolean, prompt?: boolean }} opts `ask`: the app
     *   needs the person's say before its first call (an app from
     *   elsewhere), or is allowed at once (the person's own). `prompt:
     *   false` (a hidden test, nobody looking at it) refuses a call that
     *   would need asking, or a pause, rather than asking
     */
    async call(session, { spec, inputs }, { ask, prompt = true }) {
        const task = checkSpec(spec);
        if (inputs === null || typeof inputs !== "object" || Array.isArray(inputs)) {
            throw new Error(`agex.task ${task.name}: call it with an object of its inputs`);
        }
        const s = getSettings();
        if (!isConfigured(s)) throw new Error(NO_MODEL);
        const generation = this.#generations.get(session) ?? 0;
        await this.#allow(session, task.name, ask, prompt, generation);
        await this.#limit(session, prompt, generation);
        /** A change to the meter, unless the session is gone.
         *  @param {(m: import("./app-meter.js").Meter) => import("./app-meter.js").Meter} change */
        const count = (change) => {
            if (!this.#gone(session, generation)) this.#update(session, change);
        };
        const at = Date.now();
        this.#starts.set(session, [...(this.#starts.get(session) ?? []), at]);
        const used = { steps: 0, inputTokens: 0, outputTokens: 0 };
        const base = modelFor(s, session);
        const model = metered(isLanguageModel(base) ? aiSdk(base) : base, (usage) => {
            used.steps += 1;
            used.inputTokens += usage.inputTokens;
            used.outputTokens += usage.outputTokens;
            count((m) => addReply(m, usage));
        });
        const agent = new Agent({
            model,
            settings: { thinking: thinkingOf(s), maxTokens: 8000 },
            maxSteps: TASK_STEPS,
            profile: { ...TASK_PROFILE, ...(hasRouterKey(s) && { hostObjects: { web: webHost() } }) },
        });
        const run = agent.task({
            name: task.name,
            instructions: task.instructions,
            params: Object.fromEntries(Object.entries(task.params ?? {}).map(([k, v]) => [k, fromJsonSchema(/** @type {any} */ (v))])),
            ...(task.returns !== undefined && { returns: fromJsonSchema(/** @type {any} */ (task.returns)) }),
        });
        /** @param {string} [error] */
        const done = (error) =>
            count((m) => addCall(m, { task: task.name, at, ms: Date.now() - at, ok: error === undefined, ...used, ...(error !== undefined && { error }) }));
        try {
            const value = await run(/** @type {Record<string, unknown>} */ (inputs));
            done();
            return value;
        } catch (e) {
            done((e instanceof Error ? e.message : String(e)).slice(0, 300));
            throw e;
        }
    }

    /**
     * Make one model call for session `session`'s app's own agent, on
     * the viewer's model and key as the settings say now (their
     * thinking too), handing each event to `onEvent` as it arrives. The
     * reply's usage goes on the session's meter, and the call is listed
     * with the burst it is part of. It is asked, limited and refused as
     * a task call is, on the model calls' own rate.
     *
     * @param {string} session
     * @param {{ messages: unknown, tools: unknown, settings: unknown }} call
     * @param {{ ask: boolean, prompt?: boolean, signal?: AbortSignal, onEvent: (event: import("agex-ts").ProviderEvent) => void }} opts
     *   `ask` and `prompt` as for a task call; `signal` aborted stops the
     *   call
     * @returns {Promise<void>} rejects with what went wrong; a failed
     *   request as an `AppModelError`, which carries the provider's
     *   judgment of it
     */
    async model(session, call, { ask, prompt = true, signal, onEvent }) {
        const { messages, tools, settings } = checkModelCall(call);
        const s = getSettings();
        if (!isConfigured(s)) throw new Error(NO_MODEL);
        const generation = this.#generations.get(session) ?? 0;
        await this.#allow(session, null, ask, prompt, generation);
        await this.#limit(session, prompt, generation, true);
        signal?.throwIfAborted();
        /** A change to the meter, unless the session is gone.
         *  @param {(m: import("./app-meter.js").Meter) => import("./app-meter.js").Meter} change */
        const count = (change) => {
            if (!this.#gone(session, generation)) this.#update(session, change);
        };
        const at = Date.now();
        this.#modelStarts.set(session, [...(this.#modelStarts.get(session) ?? []), at]);
        const stop = new AbortController();
        const onAbort = () => stop.abort(signal?.reason);
        signal?.addEventListener("abort", onAbort);
        const running = this.#streaming.get(session) ?? new Set();
        this.#streaming.set(session, running.add(stop));
        const used = { steps: 0, inputTokens: 0, outputTokens: 0 };
        const provider = providerFor(s, session);
        const model = metered(provider, (usage) => {
            used.steps += 1;
            used.inputTokens += usage.inputTokens;
            used.outputTokens += usage.outputTokens;
            count((m) => addReply(m, usage));
        });
        /** @type {string | undefined} */
        let error;
        try {
            for await (const event of model.stream(messages, tools, modelSettings(settings, s), { signal: stop.signal })) onEvent(event);
        } catch (e) {
            if (this.#gone(session, generation)) throw new Error(GONE);
            // a stop is the app's (or the person's), not a failure
            if (!stop.signal.aborted) error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
            throw new AppModelError(e, provider);
        } finally {
            signal?.removeEventListener("abort", onAbort);
            running.delete(stop);
            if (running.size === 0 && this.#streaming.get(session) === running) this.#streaming.delete(session);
            count((m) => addModelCall(m, { at, ms: Date.now() - at, ok: error === undefined, ...used, ...(error !== undefined && { error }) }));
        }
    }
}

/**
 * The model a task call runs on: the person's, or in dev the scripted
 * one the driver sets.
 *
 * @param {import("./settings.js").Settings} s @param {string} session
 */
function modelFor(s, session) {
    return scriptedNow(s) ?? buildModel(s, { session });
}

/**
 * The provider an app's own agent's model call runs on: the person's,
 * keyed by the app's session for the prompt cache, or in dev the
 * scripted one the driver sets.
 *
 * @param {import("./settings.js").Settings} s @param {string} session
 * @returns {import("agex-ts").Provider}
 */
function providerFor(s, session) {
    const base = modelFor(s, `${session}:app`);
    return isLanguageModel(base) ? aiSdk(base) : base;
}

/** This page's app agent. */
export const appAgent = new AppAgent();
