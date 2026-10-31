/**
 * Tabs the person shares from the browser extension's toolbar. Each waits
 * in the extension until the studio says which session takes it: the
 * studio looks each time the port opens and each time its tab comes back
 * to the front (the toolbar's Share brings it there), and a card
 * (`SharedTabCard.svelte`) asks the person about the first. Given to a
 * session, the tab is that session's to read, and its agent is told in
 * its inbox; turned down, it's left as it was.
 *
 * Which shares each session's agent has been told of is kept in this
 * browser (shares are this browser's, as the extension is), and a share
 * counts as told once its note reached the model: a note still in the
 * inbox when the page closes is put there again (`remind`) when the
 * session opens next, from what the extension still holds.
 */

import { readLocalJson, writeLocalJson } from "./local.js";
import { STUDIO_LABELS } from "./notes.js";

/** @typedef {import("./browser.js").WaitingShare} WaitingShare */

/** Where the shares each session's agent was told of are kept, as
 *  `{ [session]: ["<tab>@<domain>", ...] }`. */
const TOLD_KEY = "agex-studio-shares-told";

/**
 * What the session's agent is told of a tab the person shared with it.
 *
 * @param {{ tab: number, url: string, title: string, domain: string }} share
 */
export function sharedNote({ tab, url, title, domain }) {
    // the share it's of reads back out of it (`shareOf`)
    return (
        `The person shared a tab of theirs with this session, tab ${tab}: ${JSON.stringify(title || "(untitled)")} · ${url}. ` +
        `Read it with the browser tool (tab ${tab}, {read: true}) or from code (browser.tab(${tab}).read()). ` +
        `It stays theirs: it's only read (read, scroll, waitFor, and screenshot with the tool), and only while it's on ${domain}.`
    );
}

/** The share a note of `sharedNote`'s is of, as `<tab>@<domain>`, or null.
 *  @param {string} text */
function shareOf(text) {
    const m = /^The person shared a tab of theirs with this session, tab (\d+):[\s\S]*only while it's on (.+)\.$/.exec(text);
    return m === null ? null : `${m[1]}@${m[2]}`;
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
     * Tell session `session`'s agent, through `inbox`, of each tab shared
     * with it that it hasn't been told of, and whose note isn't waiting
     * there already. Shares the session no longer holds are forgotten.
     *
     * @param {string} session @param {import("@agex-ts/world").Inbox} inbox
     */
    async remind(session, inbox) {
        if (!this.browser.available) return;
        let shared;
        try {
            shared = (await this.browser.tabs(session)).filter((t) => t.shared !== undefined);
        } catch {
            return; // reminded the next time the port opens
        }
        const told = readTold();
        const now = new Set(shared.map((t) => `${t.id}@${t.shared}`));
        const kept = (told[session] ?? []).filter((k) => now.has(k));
        const waiting = new Set(inbox.pending().flatMap((n) => (n.label === STUDIO_LABELS.sharedTab ? [shareOf(n.text)] : [])));
        for (const t of shared) {
            const key = `${t.id}@${t.shared}`;
            if (kept.includes(key) || waiting.has(key)) continue;
            inbox.put(sharedNote({ tab: t.id, url: t.url, title: t.title, domain: /** @type {string} */ (t.shared) }), { kind: "mechanism", label: STUDIO_LABELS.sharedTab });
        }
        if (kept.length !== (told[session] ?? []).length) writeLocalJson(TOLD_KEY, { ...told, [session]: kept });
    }

    /**
     * Notes that reached session `session`'s model: the shares they told
     * of are told.
     *
     * @param {string} session @param {readonly import("@agex-ts/world").Note[]} notes
     */
    delivered(session, notes) {
        const keys = notes.flatMap((n) => (n.label === STUDIO_LABELS.sharedTab ? [shareOf(n.text)] : [])).filter((k) => k !== null);
        if (keys.length === 0) return;
        const told = readTold();
        writeLocalJson(TOLD_KEY, { ...told, [session]: [...new Set([...(told[session] ?? []), ...keys])] });
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
