/**
 * What the agent asks the person about its browser tabs, as asks of the
 * session's one queue (`asks.svelte.js`):
 *
 * - `confirm`: a step that reads as committing (book, pay, send, ...),
 *   which the `browser` tool takes only on the person's yes.
 * - `handoff`: the person's hands on a tab (a CAPTCHA, a login, a second
 *   factor): the tab comes to the front, and the agent waits for Done.
 * - `go-on`: Chrome's debugging bar was cancelled, which stops the agent's
 *   work in every tab: whether it may go on.
 *
 * Only the session's own agent asks: a delegate stops and says what it
 * needs, and the session that asked it asks.
 */

import { Asks, asks as deviceAsks } from "./asks.svelte.js";

/**
 * @typedef {{ tab: number, title: string, url: string }} OnTab
 * @typedef {{ kind: "confirm", step: string } & OnTab & { answer: (yes: boolean) => void }} ConfirmQuestion
 * @typedef {{ kind: "handoff", what: string } & OnTab & { answer: (yes: boolean) => void }} HandoffQuestion
 * @typedef {{ kind: "go-on", answer: (yes: boolean) => void }} GoOnQuestion
 */

export class BrowserAsks {
    /** @param {Asks} [asks] the page's asks, which these are kinds of */
    constructor(asks = new Asks()) {
        this.asks = asks;
    }

    /**
     * Ask the person whether the agent may take `step` on the tab: true
     * for yes.
     *
     * @param {string} session @param {{ step: string } & OnTab} q @param {AbortSignal} [signal]
     */
    confirm(session, q, signal) {
        return this.asks.ask(session, "confirm", { ...q }, signal);
    }

    /**
     * Ask the person to do `what` in the tab: true once they say it's
     * done, false for Skip.
     *
     * @param {string} session @param {{ what: string } & OnTab} q @param {AbortSignal} [signal]
     */
    handoff(session, q, signal) {
        return this.asks.ask(session, "handoff", { ...q }, signal);
    }

    /**
     * Ask the person whether the agent may go on in the browser, after
     * Chrome's debugging bar was cancelled: true to go on.
     *
     * @param {string} session @param {AbortSignal} [signal]
     */
    goOn(session, signal) {
        return this.asks.ask(session, "go-on", {}, signal);
    }

    /** @param {string} session */
    openGoOn(session) {
        return /** @type {GoOnQuestion | undefined} */ (this.asks.of(session, "go-on"));
    }

    /** @param {string} session */
    openConfirm(session) {
        return /** @type {ConfirmQuestion | undefined} */ (this.asks.of(session, "confirm"));
    }

    /** @param {string} session */
    openHandoff(session) {
        return /** @type {HandoffQuestion | undefined} */ (this.asks.of(session, "handoff"));
    }

    /** Answer session `session`'s open confirm or handoff.
     *  @param {string} session @param {boolean} yes */
    answer(session, yes) {
        (this.openConfirm(session) ?? this.openHandoff(session) ?? this.openGoOn(session))?.answer(yes);
    }
}

/** This page's asks about the browser. */
export const browserAsks = new BrowserAsks(deviceAsks);
