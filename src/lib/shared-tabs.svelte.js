/**
 * Tabs the person shares from the browser extension's toolbar. Each waits
 * in the extension until the studio says which session takes it: the
 * studio looks each time the port opens and each time its tab comes back
 * to the front (the toolbar's Share brings it there), and a card
 * (`SharedTabCard.svelte`) asks the person about the first. Given to a
 * session, the tab is that session's to read (or act in), and it waits in
 * the session's composer, as a file attached does, to be named to the
 * agent with the person's next message; turned down, it's left as it was.
 *
 * Which shares each session's agent has been told of is kept in this
 * browser (shares are this browser's, as the extension is): a share counts
 * as told once a message naming it was sent. One not told yet, a page
 * reload since, waits in the composer again when the session opens
 * (`remind`), from what the extension still holds.
 */

import { readLocalJson, writeLocalJson } from "./local.js";

/** @typedef {import("./browser.js").WaitingShare} WaitingShare */
/** @typedef {import("./notes.js").SharedTab} SharedTab */

/** Where the shares each session's agent was told of are kept, as
 *  `{ [session]: ["<tab>@<domain>", ...] }`. */
const TOLD_KEY = "agex-studio-shares-told";

/** A share's key: told of once each, and again when its mode changes.
 *  @param {{ tab: number, domain: string, acts: boolean }} share */
function keyOf({ tab, domain, acts }) {
    return `${tab}@${domain}${acts ? "+acts" : ""}`;
}

/** @returns {Record<string, string[]>} */
function readTold() {
    const told = readLocalJson(TOLD_KEY);
    return typeof told === "object" && told !== null ? told : {};
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
     *   changed?: () => void,
     * }} deps `tell` makes the extension know the session first; `given`
     *   follows a tab given to one (the session opened, its agent told);
     *   `changed` follows a share's mode changed or stopped here (the open
     *   sessions told)
     */
    constructor({ browser, tell, given, changed = () => {} }) {
        this.browser = browser;
        this.tell = tell;
        this.given = given;
        this.changed = changed;
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
     * The person gives `share` to session `session`, to read, or to act
     * in too (`acts`).
     *
     * @param {string} session @param {WaitingShare} share @param {boolean} acts
     */
    async give(session, share, acts) {
        await this.tell(session);
        const { domain } = await this.browser.take(session, share.tab, acts);
        this.#gone(share.tab);
        await this.given(session, { ...share, domain });
    }

    /**
     * The tabs shared with `session` that its agent wasn't told of, waiting
     * in its composer (`sharedTabs`) to be named with the next message; and
     * one no longer shared (stopped, or now another mode) gone from there.
     * Shares the session no longer holds are forgotten.
     *
     * @param {{ name: string, sharedTabs: SharedTab[] }} session
     */
    async remind(session) {
        if (!this.browser.available) return;
        let held;
        try {
            held = (await this.browser.tabs(session.name)).filter((t) => t.shared !== undefined);
        } catch {
            return; // reminded the next time the port opens
        }
        /** @type {SharedTab[]} */
        const now = held.map((t) => ({ tab: t.id, title: t.title, url: t.url, domain: /** @type {string} */ (t.shared), acts: t.acts === true }));
        const keys = new Set(now.map(keyOf));
        const told = readTold();
        const kept = (told[session.name] ?? []).filter((k) => keys.has(k));
        if (kept.length !== (told[session.name] ?? []).length) writeLocalJson(TOLD_KEY, { ...told, [session.name]: kept });
        const waiting = session.sharedTabs.filter((s) => keys.has(keyOf(s)));
        const more = now.filter((s) => !kept.includes(keyOf(s)) && !waiting.some((w) => keyOf(w) === keyOf(s)));
        if (more.length > 0 || waiting.length !== session.sharedTabs.length) session.sharedTabs = [...waiting, ...more];
    }

    /**
     * A message naming `shares` was sent to session `session`'s agent: they
     * are told.
     *
     * @param {string} session @param {readonly SharedTab[]} shares
     */
    told(session, shares) {
        if (shares.length === 0) return;
        const told = readTold();
        writeLocalJson(TOLD_KEY, { ...told, [session]: [...new Set([...(told[session] ?? []), ...shares.map(keyOf)])] });
    }

    /**
     * A message naming `shares` was taken back before the agent read it:
     * they aren't told.
     *
     * @param {string} session @param {readonly SharedTab[]} shares
     */
    untell(session, shares) {
        if (shares.length === 0) return;
        const keys = new Set(shares.map(keyOf));
        const told = readTold();
        writeLocalJson(TOLD_KEY, { ...told, [session]: (told[session] ?? []).filter((k) => !keys.has(k)) });
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
        this.changed();
    }

    /** Whether session `session`'s agent may act in a tab the person
     *  shared, or only read it. @param {string} session @param {number} tab @param {boolean} acts */
    async setMode(session, tab, acts) {
        await this.browser.shareMode(session, tab, acts);
        this.changed();
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
