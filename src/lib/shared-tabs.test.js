import { beforeEach, describe, expect, it, vi } from "vitest";
import { SharedTabs } from "./shared-tabs.svelte.js";

beforeEach(() => {
    const items = new Map();
    vi.stubGlobal("localStorage", {
        getItem: (/** @type {string} */ k) => items.get(k) ?? null,
        setItem: (/** @type {string} */ k, /** @type {string} */ v) => items.set(k, String(v)),
        removeItem: (/** @type {string} */ k) => items.delete(k),
    });
});

const share = { tab: 9, url: "https://mail.example/inbox", title: "Inbox", domain: "mail.example", at: 1 };

/** The shares over a fake browser, keeping what was asked of it, in order. */
function setup({ available = true, waiting = [share], shared = /** @type {any[]} */ ([{ id: 9, url: share.url, title: "Inbox", working: false, shared: "mail.example" }]) } = {}) {
    /** @type {any[]} */
    const done = [];
    const browser = {
        available,
        shares: async () => waiting,
        take: async (/** @type {string} */ session, /** @type {number} */ tab, /** @type {boolean} */ acts) => (done.push(["take", session, tab, acts]), { tab, domain: "mail.example" }),
        shareMode: async (/** @type {string} */ session, /** @type {number} */ tab, /** @type {boolean} */ acts) => void done.push(["mode", session, tab, acts]),
        drop: async (/** @type {number} */ tab) => void done.push(["drop", tab]),
        unshare: async (/** @type {string} */ session, /** @type {number} */ tab) => void done.push(["unshare", session, tab]),
        sessions: async () => [{ session: "s1" }, { session: "s2" }],
        tabs: async (/** @type {string} */ session) => (session === "s1" ? [{ id: 7, url: "", title: "", working: false }, ...shared] : []),
    };
    const shares = new SharedTabs({
        browser: /** @type {any} */ (browser),
        tell: async (session) => void done.push(["tell", session]),
        given: async (session, s) => void done.push(["given", session, s.tab]),
    });
    return { shares, done, shared };
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
        await shares.give("s2", share, true);
        expect(done).toEqual([["tell", "s2"], ["take", "s2", 9, true], ["given", "s2", 9]]);
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
        await shares.setMode("s1", 9, false);
        await shares.stop("s1", 9);
        expect(done).toEqual([["mode", "s1", 9, false], ["unshare", "s1", 9]]);
    });
});

describe("the tabs shared with a session, named with the next message", () => {
    const held = { id: 9, url: share.url, title: "Inbox", working: false, shared: "mail.example" };
    const chip = { tab: 9, title: "Inbox", url: share.url, domain: "mail.example", acts: false };

    it("wait in its composer, once each", async () => {
        const { shares } = setup();
        const session = { name: "s1", sharedTabs: /** @type {any[]} */ ([]) };
        await shares.remind(session);
        await shares.remind(session);
        expect(session.sharedTabs).toEqual([chip]);
    });

    it("are told once a message naming them is sent, and wait again after a reload until then", async () => {
        const { shares } = setup();
        const before = { name: "s1", sharedTabs: /** @type {any[]} */ ([]) };
        await shares.remind(before);
        // the page reloaded before a message was sent: the composer starts empty
        const reloaded = { name: "s1", sharedTabs: /** @type {any[]} */ ([]) };
        await shares.remind(reloaded);
        expect(reloaded.sharedTabs).toEqual([chip]);
        shares.told("s1", reloaded.sharedTabs);
        const after = { name: "s1", sharedTabs: /** @type {any[]} */ ([]) };
        await shares.remind(after);
        expect(after.sharedTabs).toEqual([]);
    });

    it("wait again when the person lets the agent act in one it was told it could only read", async () => {
        const { shares, shared } = setup();
        shares.told("s1", [chip]);
        shared[0] = { ...held, acts: true };
        const session = { name: "s1", sharedTabs: /** @type {any[]} */ ([]) };
        await shares.remind(session);
        expect(session.sharedTabs).toEqual([{ ...chip, acts: true }]);
    });

    it("wait again once the message naming them is taken back before the agent read it", async () => {
        const { shares } = setup();
        shares.told("s1", [chip]);
        shares.untell("s1", [chip]);
        const session = { name: "s1", sharedTabs: /** @type {any[]} */ ([]) };
        await shares.remind(session);
        expect(session.sharedTabs).toEqual([chip]);
    });

    it("restored by an edit, are named as they stand now: an act share now read only as read only, an ended one not at all", async () => {
        const { shares } = setup();
        shares.told("s1", [{ ...chip, acts: true }]);
        const session = { name: "s1", sharedTabs: /** @type {any[]} */ ([{ ...chip, acts: true }, { ...chip, tab: 3, domain: "gone.example" }]) };
        await shares.remind(session);
        expect(session.sharedTabs).toEqual([chip]);
    });

    it("leave the composer once no longer shared, and are told anew if shared again", async () => {
        const { shares, shared } = setup();
        const session = { name: "s1", sharedTabs: /** @type {any[]} */ ([]) };
        await shares.remind(session);
        shares.told("s1", session.sharedTabs);
        shared.length = 0;
        session.sharedTabs = [chip];
        await shares.remind(session);
        expect(session.sharedTabs).toEqual([]);
        shared.push(held);
        await shares.remind(session);
        expect(session.sharedTabs).toEqual([chip]);
    });
});
