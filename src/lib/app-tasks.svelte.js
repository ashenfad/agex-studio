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
 * Calls are counted per session for this page's life (the per-page
 * budget): a session of the person's own gets `APP_CALLS` at once; one
 * opened from elsewhere (a bundle, a published link) asks first, since
 * it is someone else's code spending the viewer's key. The preview
 * shows the count, and allows more.
 */

import workerUrl from "@agex-ts/world/worker?worker&url";
import { Agent, ScriptedProvider, fromJsonSchema } from "agex-ts";
import { buildModel, thinkingOf } from "./model.js";
import { hasRouterKey } from "./openrouter-api.js";
import { getSettings, isConfigured } from "./settings.js";
import { webHost } from "./web.js";

/** Calls an app gets per page, and each time more are allowed. */
export const APP_CALLS = 20;
/** The most model calls one task call makes. */
export const TASK_STEPS = 30;

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

/** @typedef {{ limit: number, used: number }} Budget */

class AppAgent {
    /** This page's budgets, by session. @type {Record<string, Budget>} */
    budgets = $state({});
    /** Apps asking to use the model, waiting for the person, by
     *  session: each its own question, answered for that app alone.
     *  @type {Record<string, { task: string, answer: (yes: boolean) => void }>} */
    asking = $state({});

    /** Allow session `name`'s app `APP_CALLS` more calls. @param {string} name */
    allowMore(name) {
        const b = this.budgets[name] ?? { limit: 0, used: 0 };
        this.budgets[name] = { limit: Math.max(b.limit, b.used) + APP_CALLS, used: b.used };
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
     * the app reads.
     *
     * @param {string} session
     * @param {{ spec: unknown, inputs: unknown }} call
     * @param {{ ask: boolean }} opts ask before the first call (an app
     *   from elsewhere), or allow it at once (the person's own)
     */
    async call(session, { spec, inputs }, { ask }) {
        const task = checkSpec(spec);
        if (inputs === null || typeof inputs !== "object" || Array.isArray(inputs)) {
            throw new Error(`agex.task ${task.name}: call it with an object of its inputs`);
        }
        const s = getSettings();
        if (!isConfigured(s)) throw new Error("the person viewing this app hasn't chosen a model: its agent needs one (settings, ⚙)");
        if (this.budgets[session] === undefined) {
            if (ask && !(await this.#consent(session, task.name))) {
                this.budgets[session] ??= { limit: 0, used: 0 };
            } else {
                this.budgets[session] ??= { limit: APP_CALLS, used: 0 };
            }
        }
        const budget = /** @type {Budget} */ (this.budgets[session]);
        if (budget.used >= budget.limit) {
            throw new Error(
                budget.limit === 0
                    ? "the person didn't allow this app to use their model"
                    : `this app has used its ${budget.limit} agent calls for this visit; the person can allow more in the preview`,
            );
        }
        this.budgets[session] = { ...budget, used: budget.used + 1 };
        const agent = new Agent({
            model: await modelFor(s, session),
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
        return run(/** @type {Record<string, unknown>} */ (inputs));
    }
}

/**
 * The model a task call runs on: the person's, or in dev the scripted
 * one the driver sets.
 *
 * @param {import("./settings.js").Settings} s @param {string} session
 */
async function modelFor(s, session) {
    if (s.accessMode === "scripted" && import.meta.env.DEV) {
        const { script } = await import("./studio.svelte.js");
        return new ScriptedProvider(() => script.shift() ?? { kind: "model", text: "(the script ran out)", thinking: "", tool_calls: [], fail: "", input_tokens: 0 });
    }
    return buildModel(s, { session });
}

/** This page's app agent. */
export const appAgent = new AppAgent();
