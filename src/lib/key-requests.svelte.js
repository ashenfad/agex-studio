/**
 * A session's agent asking the person for a key (`request_secret`, see
 * `request-secret.js`), an ask of kind `key` (`asks.svelte.js`). The
 * question shows in the chat (`KeyRequest.svelte`): the vault's entries
 * whose origins cover the request, or a new key, which goes into the
 * vault. What the person picks is granted to the session's agent under
 * the name asked for and for the origins asked for (`vault.grantAgent`);
 * "Not now" answers the agent so its turn goes on. The value never
 * reaches the chat or the agent.
 */

import { Asks, asks as deviceAsks } from "./asks.svelte.js";
import { vault as deviceVault } from "./vault.svelte.js";

/**
 * A key an agent asks for, and its `answer` (the person gave one, or
 * not); answer it with `KeyRequests.answer`, which grants it.
 *
 * @typedef {{ kind: "key", name: string, origins: string[], why: string, answer: (yes: boolean) => void }} KeyQuestion
 */

export class KeyRequests {
    /**
     * @param {import("./vault.svelte.js").Vault} vault where grants are kept
     * @param {Asks} [asks] the page's asks, which this is one kind of
     */
    constructor(vault, asks = new Asks()) {
        this.vault = vault;
        this.asks = asks;
    }

    /** The asks open, by session, of every kind. */
    get asking() {
        return this.asks.asking;
    }

    /** Session `session`'s open key request. @param {string} session */
    open(session) {
        return /** @type {KeyQuestion | undefined} */ (this.asks.of(session, "key"));
    }

    /**
     * Ask the person for the key session `session`'s agent wants: true
     * once one is granted, false for "Not now". Refused while another ask
     * of that session's waits; `signal` aborted takes it back, rejecting
     * with its reason.
     *
     * @param {string} session
     * @param {{ name: string, origins: string[], why: string }} want
     * @param {AbortSignal} [signal]
     * @returns {Promise<boolean>}
     */
    ask(session, want, signal) {
        return this.asks.ask(session, "key", { name: want.name, origins: [...want.origins], why: want.why }, signal);
    }

    /**
     * Answer session `session`'s open key request: `entryId` the vault
     * entry to grant, or null for "Not now". A grant the vault refuses
     * (`VaultError`) throws, the question still open.
     *
     * @param {string} session @param {string | null} entryId
     */
    answer(session, entryId) {
        const q = this.open(session);
        if (q === undefined) return;
        if (entryId !== null) this.vault.grantAgent(session, { name: q.name, origins: q.origins }, entryId);
        q.answer(entryId !== null);
    }
}

/** This page's key requests, granted in this device's vault. */
export const keyRequests = new KeyRequests(deviceVault, deviceAsks);
