/**
 * Asking the person for what an app needs: their model, and a key for
 * each service it declares (`app/agex.json`, see `app-needs.js`).
 *
 * The answer is kept in the vault (`vault.svelte.js`): the model as a
 * grant to the app, each key as a grant of one of the person's entries.
 * Until an app has what it asks for, its call waits on one question, the
 * preview's "This app needs…" panel (`AppNeedsPanel.svelte`), which
 * lists everything the app declares so the person settles it at once:
 *
 * - an app from elsewhere (a bundle, a published link) is asked before
 *   it uses the model, declared or not;
 * - the person's own app uses the model without asking, and is asked
 *   only for a key it has no grant for;
 * - a hidden test (`prompt: false`) is never asked: a call that would
 *   need asking is refused.
 *
 * One question is open at a time for each session; calls that come
 * while it is open wait on the same answer. What the person turns down
 * (Don't allow, or a key left without one) is refused for the rest of
 * the page, so an app calling in a loop doesn't ask again and again.
 */

import { Questions } from "./questions.js";
import { isOwnApp, vault as deviceVault } from "./vault.svelte.js";

export const NOT_ALLOWED = "the person didn't allow this app to use their model";
export const HIDDEN = "the person hasn't allowed this app to use their model yet: they can try it in the preview, which asks";
const GONE = "this app's session was deleted";

/**
 * The question the panel answers, for one session's app.
 *
 * `model`: the panel asks for the model too (the app declares it, or a
 * call is waiting to use it). `own`: the person's own app, allowed the
 * model already. Answer it with `NeedsAsk.answer`, which keeps what was
 * allowed; its own `answer` only lets the waiting calls go on.
 *
 * @typedef {{ appKey: string, needs: import("./app-needs.js").AppNeeds, own: boolean, model: boolean, answer: (yes: boolean) => void }} NeedsQuestion
 */

export class NeedsAsk {
    /** Apps waiting on the person, by session: each its own question.
     *  @type {Record<string, NeedsQuestion>} */
    asking = $state({});
    #questions = new Questions(this.asking);
    /** What the person turned down this page, by session: the model, and
     *  keys by the app's name for them.
     *  @type {Map<string, { model: boolean, secrets: Set<string> }>} */
    #declined = new Map();
    /** How many times each session was forgotten: a call that began
     *  before is refused after. @type {Map<string, number>} */
    #generations = new Map();

    /** @param {import("./vault.svelte.js").Vault} vault where what the
     *  person allows is kept */
    constructor(vault) {
        this.vault = vault;
    }

    /** @param {string} session */
    #declinedOf(session) {
        let d = this.#declined.get(session);
        if (d === undefined) this.#declined.set(session, (d = { model: false, secrets: new Set() }));
        return d;
    }

    /**
     * Wait for the person's answer about session `session`'s app,
     * opening the panel if none is open; `model`: this call needs the
     * model, which the open panel then asks for too.
     *
     * @param {string} session @param {string} appKey
     * @param {import("./app-needs.js").AppNeeds} needs @param {boolean} model
     * @param {AbortSignal} [signal]
     */
    #ask(session, appKey, needs, model, signal) {
        const waiting = this.#questions.wait(session, { appKey, needs, own: isOwnApp(appKey), model: model || needs.model }, signal);
        const open = this.asking[session];
        if (model && open !== undefined && !open.model) open.model = true;
        return waiting;
    }

    /**
     * Answer session `session`'s open question: `grants` (each key's
     * name to the vault entry chosen for it) to allow, null to not. Allow
     * keeps each grant and, when the panel asked for it, the model; a key
     * left without an entry, or everything on Don't allow, is refused for
     * the rest of the page. Then the calls waiting go on, or are refused.
     * A grant the vault refuses (`VaultError`) throws, the question still
     * open.
     *
     * @param {string} session @param {Record<string, string> | null} grants
     */
    answer(session, grants) {
        const q = this.asking[session];
        if (q === undefined) return;
        if (grants !== null) {
            for (const [name, id] of Object.entries(grants)) {
                const need = q.needs.secrets.find((s) => s.name === name);
                if (need !== undefined) this.vault.grant(q.appKey, need, id);
            }
            if (q.model && !q.own) this.vault.allowModel(q.appKey);
        }
        const d = this.#declinedOf(session);
        if (q.model && !q.own) d.model = !this.vault.modelAllowed(q.appKey);
        for (const need of q.needs.secrets) {
            if (this.vault.valueFor(q.appKey, need) === null) d.secrets.add(need.name);
            else d.secrets.delete(need.name);
        }
        q.answer(grants !== null);
    }

    /**
     * Resolves once session `session`'s app may use the person's model:
     * at once for their own app (`ask` false) or one allowed before;
     * otherwise once the person allows it in the panel. Refused if they
     * don't, if nobody is looking to ask (`prompt` false), or if the
     * session is forgotten meanwhile; `signal` aborted stops the wait,
     * rejecting with its reason.
     *
     * @param {string} session @param {string} appKey as `appKeyOf` gives it
     * @param {import("./app-needs.js").AppNeeds} needs the app's, as its built page has them
     * @param {{ ask: boolean, prompt?: boolean, signal?: AbortSignal }} opts
     *   `ask`: the app is from elsewhere, and needs the person's say
     * @returns {Promise<void>}
     */
    async allowModel(session, appKey, needs, { ask, prompt = true, signal }) {
        if (!ask || this.vault.modelAllowed(appKey)) return;
        if (this.#declined.get(session)?.model) throw new Error(NOT_ALLOWED);
        if (!prompt) throw new Error(HIDDEN);
        const generation = this.#generations.get(session) ?? 0;
        await this.#ask(session, appKey, needs, true, signal);
        if ((this.#generations.get(session) ?? 0) !== generation) throw new Error(GONE);
        if (!this.vault.modelAllowed(appKey)) throw new Error(NOT_ALLOWED);
    }

    /**
     * The key session `session`'s app is granted for `need`, one of the
     * secrets it declares; with no grant, asked for in the panel when
     * someone is looking (`prompt`). Null when the app declares no such
     * secret, the person leaves it without a key or doesn't allow the
     * app, nobody is looking, or the session is forgotten meanwhile.
     * `signal` aborted stops the wait, rejecting with its reason.
     *
     * @param {string} session @param {string} appKey as `appKeyOf` gives it
     * @param {import("./app-needs.js").AppNeeds} needs the app's, as its built page has them
     * @param {import("./vault.svelte.js").Need} need
     * @param {{ prompt?: boolean, signal?: AbortSignal }} [opts]
     * @returns {Promise<string | null>}
     */
    async secretFor(session, appKey, needs, need, { prompt = true, signal } = {}) {
        const value = this.vault.valueFor(appKey, need);
        if (value !== null) return value;
        if (!prompt || !needs.secrets.some((s) => s.name === need.name)) return null;
        if (this.#declined.get(session)?.secrets.has(need.name)) return null;
        const generation = this.#generations.get(session) ?? 0;
        await this.#ask(session, appKey, needs, false, signal);
        if ((this.#generations.get(session) ?? 0) !== generation) return null;
        return this.vault.valueFor(appKey, need);
    }

    /** Session `session` is gone: what the person turned down for it
     *  goes, and a question open is refused. @param {string} session */
    forget(session) {
        this.#generations.set(session, (this.#generations.get(session) ?? 0) + 1);
        this.#declined.delete(session);
        this.asking[session]?.answer(false);
    }
}

/** This page's asking, keeping answers in this device's vault. */
export const needsAsk = new NeedsAsk(deviceVault);
