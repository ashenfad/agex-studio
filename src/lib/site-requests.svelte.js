/**
 * A session's agent asking the person for sites to open in its browser
 * tabs (`request_sites`, see `request-sites.js`), an ask of kind `sites`
 * (`asks.svelte.js`). The card (`SitesRequest.svelte`) lists the domains
 * and why; the person allows the ones they tick, for this session's agent
 * and its delegates (`vault.grantSites`), or says Not now, which answers
 * the agent so its turn goes on.
 */

import { Asks, asks as deviceAsks } from "./asks.svelte.js";
import { vault as deviceVault } from "./vault.svelte.js";

/**
 * Sites an agent asks for, and its `answer`; answer it with
 * `SiteRequests.answer`, which grants the ones allowed.
 *
 * @typedef {{ kind: "sites", domains: string[], why: string, answer: (yes: boolean) => void }} SitesQuestion
 */

export class SiteRequests {
    /**
     * @param {import("./vault.svelte.js").Vault} vault where grants are kept
     * @param {Asks} [asks] the page's asks, which this is one kind of
     */
    constructor(vault, asks = new Asks()) {
        this.vault = vault;
        this.asks = asks;
    }

    /** Session `session`'s open request for sites. @param {string} session */
    open(session) {
        return /** @type {SitesQuestion | undefined} */ (this.asks.of(session, "sites"));
    }

    /**
     * Ask the person to let session `session`'s agent open `want.domains`:
     * true once any are allowed (which ones, the vault says), false for
     * Not now. Refused while another ask of that session's waits.
     *
     * @param {string} session @param {{ domains: string[], why: string }} want
     * @param {AbortSignal} [signal]
     * @returns {Promise<boolean>}
     */
    ask(session, want, signal) {
        return this.asks.ask(session, "sites", { domains: [...want.domains], why: want.why }, signal);
    }

    /**
     * Answer session `session`'s open request: the domains allowed (some
     * or all of those asked for), or none for Not now.
     *
     * @param {string} session @param {string[]} allowed
     */
    answer(session, allowed) {
        const q = this.open(session);
        if (q === undefined) return;
        const chosen = allowed.filter((d) => q.domains.includes(d));
        if (chosen.length > 0) this.vault.grantSites(session, chosen);
        q.answer(chosen.length > 0);
    }
}

/** This page's requests for sites, granted in this device's vault. */
export const siteRequests = new SiteRequests(deviceVault, deviceAsks);
