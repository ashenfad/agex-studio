import { describe, expect, it } from "vitest";
import { SharedTabs, sharedNote } from "./shared-tabs.svelte.js";

const share = { tab: 9, url: "https://mail.example/inbox", title: "Inbox", domain: "mail.example", at: 1 };

/** The shares over a fake browser, keeping what was asked of it, in order. */
function setup({ available = true, waiting = [share] } = {}) {
    /** @type {any[]} */
    const done = [];
    const browser = {
        available,
        shares: async () => waiting,
        take: async (/** @type {string} */ session, /** @type {number} */ tab) => (done.push(["take", session, tab]), { tab, domain: "mail.example" }),
        drop: async (/** @type {number} */ tab) => void done.push(["drop", tab]),
        unshare: async (/** @type {string} */ session, /** @type {number} */ tab) => void done.push(["unshare", session, tab]),
        sessions: async () => [{ session: "s1" }, { session: "s2" }],
        tabs: async (/** @type {string} */ session) => (session === "s1" ? [{ id: 7, url: "", title: "", working: false }, { id: 9, url: share.url, title: "Inbox", working: false, shared: "mail.example" }] : []),
    };
    const shares = new SharedTabs({
        browser: /** @type {any} */ (browser),
        tell: async (session) => void done.push(["tell", session]),
        given: async (session, s) => void done.push(["given", session, s.tab]),
    });
    return { shares, done };
}

describe("tabs the person shares from the toolbar", () => {
    it("are asked of the extension, and none without it", async () => {
        const { shares } = setup();
        await shares.refresh();
        expect(shares.waiting).toEqual([share]);
        const none = setup({ available: false }).shares;
        await none.refresh();
        expect(none.waiting).toEqual([]);
    });

    it("go to the session chosen, told to the extension first, then opened and told to its agent", async () => {
        const { shares, done } = setup();
        await shares.refresh();
        await shares.give("s2", share);
        expect(done).toEqual([["tell", "s2"], ["take", "s2", 9], ["given", "s2", 9]]);
        expect(shares.waiting).toEqual([]);
    });

    it("are left as they were when turned down", async () => {
        const { shares, done } = setup();
        await shares.refresh();
        await shares.turnDown(share);
        expect(done).toEqual([["drop", 9]]);
        expect(shares.waiting).toEqual([]);
    });

    it("are listed with their sessions once given, and stopped", async () => {
        const { shares, done } = setup();
        expect((await shares.sharedNow()).map(({ session, tab }) => [session, tab.id])).toEqual([["s1", 9]]);
        await shares.stop("s1", 9);
        expect(done).toEqual([["unshare", "s1", 9]]);
    });
});

describe("the note a session's agent gets", () => {
    it("names the tab, how to read it, and that it's read only on its site", () => {
        const note = sharedNote(share);
        expect(note).toMatch(/^The person shared a tab of theirs with this session, tab 9: "Inbox" · https:\/\/mail\.example\/inbox\./);
        expect(note).toMatch(/\(tab 9, \{read: true\}\)/);
        expect(note).toMatch(/only while it's on mail\.example\.$/);
    });
});
