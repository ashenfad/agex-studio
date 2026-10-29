/**
 * What a session's agent asks the person, in the chat: a key
 * (`request_secret`), sites to open (`request_sites`), and the cards to
 * come. Each is an ask of a `kind`, with its fields and its `answer`,
 * shown under the live turn by the card for its kind.
 *
 * One ask is open at a time for each session, whatever its kind: the
 * person answers one card at a time, from one agent. Another ask while
 * one waits is refused; the turn that asked ending (its signal aborting)
 * takes it back.
 */

import { Questions } from "./questions.js";

/** How the refusal of a second ask names the one waiting. */
const KIND_NAMES = /** @type {Record<string, string>} */ ({
    key: "a key request",
    sites: "a request for sites",
    confirm: "a step to confirm",
    handoff: "a handoff",
    "go-on": "a question whether to go on in the browser",
});

/**
 * @typedef {{ kind: string, answer: (yes: boolean) => void } & Record<string, any>} Ask
 */

export class Asks {
    /** The asks open, by session. @type {Record<string, Ask>} */
    asking = $state({});
    #questions = new Questions(this.asking);

    /**
     * Ask the person `fields`, as a card of `kind`, for session
     * `session`'s agent: true for the answer that gives, false for Not
     * now. Refused while another ask of that session's waits; `signal`
     * aborted takes it back, rejecting with its reason.
     *
     * @param {string} session @param {string} kind @param {Record<string, unknown>} fields
     * @param {AbortSignal} [signal]
     * @returns {Promise<boolean>}
     */
    ask(session, kind, fields, signal) {
        const open = this.asking[session];
        if (open !== undefined) {
            return Promise.reject(new Error(`${KIND_NAMES[open.kind] ?? "another question"} of this session's is waiting on the person`));
        }
        return this.#questions.wait(session, { ...fields, kind }, signal);
    }

    /** Session `session`'s open ask, if it is of `kind`.
     *  @param {string} session @param {string} kind @returns {Ask | undefined} */
    of(session, kind) {
        const ask = this.asking[session];
        return ask?.kind === kind ? ask : undefined;
    }
}

/** This page's asks. */
export const asks = new Asks();
