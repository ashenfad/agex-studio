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
 */

import workerUrl from "@agex-ts/world/worker?worker&url";
import { Agent, aiSdk, fromJsonSchema, isLanguageModel } from "agex-ts";
import { RATE, addCall, addReply, emptyMeter, loadMeter, metered, overRate, saveMeter } from "./app-meter.js";
import { buildModel, thinkingOf } from "./model.js";
import { hasRouterKey } from "./openrouter-api.js";
import { scriptedNow } from "./scripted.js";
import { getSettings, isConfigured } from "./settings.js";
import { webHost } from "./web.js";

/** The most model calls one task call makes. */
const TASK_STEPS = 30;

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

const STOPPED = "the person stopped this app's agent calls after it called often; they can let it go on from the preview's agent meter";
const HIDDEN_PAUSE = `this app made ${RATE.calls} agent calls inside a minute, which pauses its calls until the person says to go on, and a test with nobody watching can't: space the calls out, or the person can turn the limiter off in the preview's agent meter`;

class AppAgent {
    /** Whether each session's app may use the model, this page, by
     *  session (an app from elsewhere is asked first). @type {Record<string, boolean>} */
    allowed = {};
    /** Apps asking to use the model, waiting for the person, by
     *  session: each its own question, answered for that app alone.
     *  @type {Record<string, { task: string, answer: (yes: boolean) => void }>} */
    asking = $state({});
    /** The meters read or written this page, by session.
     *  @type {Record<string, import("./app-meter.js").Meter>} */
    meters = $state({});
    /** Apps the limiter paused, waiting for the person to say whether
     *  to go on, by session: the calls made in the last minute.
     *  @type {Record<string, { calls: number, answer: (go: boolean) => void }>} */
    paused = $state({});
    /** Apps whose calls the person stopped when paused, until they let
     *  them go on, by session. @type {Record<string, true>} */
    stopped = $state({});
    /** When each session's recent calls started, for the rate.
     *  @type {Map<string, number[]>} */
    #starts = new Map();

    /** Session `name`'s meter, or null when its app has made no call
     *  here. @param {string} name */
    meterOf(name) {
        return this.meters[name] ?? loadMeter(name);
    }

    /** @param {string} name @param {(m: import("./app-meter.js").Meter) => import("./app-meter.js").Meter} change */
    #update(name, change) {
        const m = change(this.meterOf(name) ?? emptyMeter(Date.now()));
        this.meters[name] = m;
        saveMeter(name, m);
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
        delete this.stopped[name];
        this.paused[name]?.answer(true);
    }

    /** Ask the person whether session `session`'s app goes on, its
     *  calls paused; a call while the question is open waits on the
     *  same answer. @param {string} session @param {number} calls */
    #pause(session, calls) {
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
                answer: (go) => {
                    delete this.paused[session];
                    resolve(go);
                },
            };
        });
    }

    /** Hold a call of session `session`'s app while it breaks the rate,
     *  with the limiter on: until the person says to go on, or refused
     *  if they stop it, or if nobody is looking (`prompt` false).
     *  @param {string} session @param {boolean} prompt */
    async #limit(session, prompt) {
        if (!(this.meterOf(session)?.limiter ?? true)) return;
        if (this.stopped[session]) throw new Error(STOPPED);
        const now = Date.now();
        const starts = (this.#starts.get(session) ?? []).filter((t) => now - t < RATE.windowMs);
        this.#starts.set(session, starts);
        if (!overRate(starts, now)) return;
        if (!prompt) throw new Error(HIDDEN_PAUSE);
        if (await this.#pause(session, starts.length)) {
            this.#starts.delete(session);
            return;
        }
        this.stopped[session] = true;
        throw new Error(STOPPED);
    }

    /** Ask whether session `session`'s app may use the model; a call
     *  while its question is open waits on the same answer.
     *  @param {string} session @param {string} task */
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
        if (!isConfigured(s)) throw new Error("the person viewing this app hasn't chosen a model: its agent needs one (settings, ⚙)");
        if (this.allowed[session] === undefined) {
            if (ask && !prompt) throw new Error("the person hasn't allowed this app to use their model yet: they can try it in the preview, which asks");
            const yes = !ask || (await this.#consent(session, task.name));
            this.allowed[session] ??= yes;
        }
        if (!this.allowed[session]) throw new Error("the person didn't allow this app to use their model");
        await this.#limit(session, prompt);
        const at = Date.now();
        this.#starts.set(session, [...(this.#starts.get(session) ?? []), at]);
        const used = { steps: 0, inputTokens: 0, outputTokens: 0 };
        const base = modelFor(s, session);
        const model = metered(isLanguageModel(base) ? aiSdk(base) : base, (usage) => {
            used.steps += 1;
            used.inputTokens += usage.inputTokens;
            used.outputTokens += usage.outputTokens;
            this.#update(session, (m) => addReply(m, usage));
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
            this.#update(session, (m) => addCall(m, { task: task.name, at, ms: Date.now() - at, ok: error === undefined, ...used, ...(error !== undefined && { error }) }));
        try {
            const value = await run(/** @type {Record<string, unknown>} */ (inputs));
            done();
            return value;
        } catch (e) {
            done((e instanceof Error ? e.message : String(e)).slice(0, 300));
            throw e;
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

/** This page's app agent. */
export const appAgent = new AppAgent();
