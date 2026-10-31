/**
 * Tabs the person shares from the browser extension's toolbar. Each waits
 * in the extension until the studio says which session takes it: the
 * studio looks each time the port opens and each time its tab comes back
 * to the front (the toolbar's Share brings it there), and a card
 * (`SharedTabCard.svelte`) asks the person about the first. Given to a
 * session, the tab is that session's to read, and its agent is told in
 * its inbox; turned down, it's left as it was.
 */

/** @typedef {import("./browser.js").WaitingShare} WaitingShare */

/**
 * What the session's agent is told of a tab the person shared with it.
 *
 * @param {{ tab: number, url: string, title: string, domain: string }} share
 */
export function sharedNote({ tab, url, title, domain }) {
    return (
        `The person shared a tab of theirs with this session, tab ${tab}: ${JSON.stringify(title || "(untitled)")} · ${url}. ` +
        `Read it with the browser tool (tab ${tab}, {read: true}) or from code (browser.tab(${tab}).read()). ` +
        `It stays theirs: it's only read (read, scroll, waitFor, screenshot), and only while it's on ${domain}.`
    );
}

export class SharedTabs {
    /** The shares waiting for a session, as the extension last said.
     *  @type {WaitingShare[]} */
    waiting = $state([]);

    /**
     * @param {{
     *   browser: import("./browser.js").Browser,
     *   tell: (session: string) => Promise<void>,
     *   given: (session: string, share: WaitingShare) => Promise<void>,
     * }} deps `tell` makes the extension know the session first; `given`
     *   follows a tab given to one (the session opened, its agent told)
     */
    constructor({ browser, tell, given }) {
        this.browser = browser;
        this.tell = tell;
        this.given = given;
    }

    /** What waits, asked of the extension again. */
    async refresh() {
        if (!this.browser.available) {
            this.waiting = [];
            return;
        }
        try {
            this.waiting = await this.browser.shares();
        } catch {
            // asked again the next time the port opens or the page comes back
        }
    }

    /**
     * The person gives `share` to session `session`.
     *
     * @param {string} session @param {WaitingShare} share
     */
    async give(session, share) {
        await this.tell(session);
        const { domain } = await this.browser.take(session, share.tab);
        this.#gone(share.tab);
        await this.given(session, { ...share, domain });
    }

    /**
     * Every tab the person has shared with a session, by session: what
     * settings lists, with a stop for each.
     *
     * @returns {Promise<{ session: string, tab: import("./browser.js").TabInfo }[]>}
     */
    async sharedNow() {
        if (!this.browser.available) return [];
        const found = [];
        for (const { session } of await this.browser.sessions()) {
            for (const tab of await this.browser.tabs(session)) if (tab.shared) found.push({ session, tab });
        }
        return found;
    }

    /** A tab the person shared, the session's no longer (it stays open).
     *  @param {string} session @param {number} tab */
    async stop(session, tab) {
        await this.browser.unshare(session, tab);
    }

    /** The person turns `share` down: the tab is left as it was.
     *  @param {WaitingShare} share */
    async turnDown(share) {
        await this.browser.drop(share.tab);
        this.#gone(share.tab);
    }

    /**
     * Look for shares now and each time the extension's port opens or the
     * page comes back to the front: its tab shown again, or its window
     * focused (a studio in a window of its own, in view all along, is
     * only focused). Returns the stopping.
     *
     * @param {import("./browser-extension.svelte.js").BrowserExtension} extension
     */
    watch(extension) {
        const look = () => void this.refresh();
        const stopOpen = extension.onOpen(look);
        const shown = () => {
            if (document.visibilityState === "visible") look();
        };
        if (typeof document !== "undefined") {
            document.addEventListener("visibilitychange", shown);
            window.addEventListener("focus", look);
        }
        look();
        return () => {
            stopOpen();
            if (typeof document !== "undefined") {
                document.removeEventListener("visibilitychange", shown);
                window.removeEventListener("focus", look);
            }
        };
    }

    /** @param {number} tab */
    #gone(tab) {
        this.waiting = this.waiting.filter((s) => s.tab !== tab);
    }
}
