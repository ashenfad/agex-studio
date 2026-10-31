import { Inbox } from "@agex-ts/world";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SharedTabs, sharedNote } from "./shared-tabs.svelte.js";

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

describe("the note a session's agent gets", () => {
    it("names the tab, how to read it, and that it's read only on its site", () => {
        const note = sharedNote(share);
        expect(note).toMatch(/^The person shared a tab of theirs with this session, tab 9: "Inbox" · https:\/\/mail\.example\/inbox\./);
        expect(note).toMatch(/\(tab 9, \{read: true\}\)/);
        expect(note).toMatch(/only while it's on mail\.example\.$/);
    });

    it("says, for a tab shared to act in, what it may do there and that it's never closed", () => {
        const note = sharedNote({ ...share, acts: true });
        expect(note).toMatch(/You may read it and act in it, with the browser tool \(tab 9\) or from code/);
        expect(note).toMatch(/a step that commits asks them first/);
        expect(note).toMatch(/never close it/);
        expect(note).toMatch(/only while it's on mail\.example\.$/);
    });
});

describe("telling a session's agent of the tabs shared with it", () => {
    it("puts a note in its inbox for each share it wasn't told of, once", async () => {
        const { shares } = setup();
        const inbox = new Inbox();
        await shares.remind("s1", inbox);
        await shares.remind("s1", inbox);
        expect(inbox.pending().map((n) => [n.kind, n.label, n.text])).toEqual([["mechanism", "shared tab", sharedNote({ ...share, title: "Inbox" })]]);
    });

    it("counts a share told once its note reached the model, and not before: a reload puts it again", async () => {
        const { shares } = setup();
        const first = new Inbox();
        await shares.remind("s1", first);
        // the page closed with the note still waiting
        const reloaded = new Inbox();
        await shares.remind("s1", reloaded);
        expect(reloaded.pending()).toHaveLength(1);
        shares.delivered("s1", reloaded.drain());
        const again = new Inbox();
        await shares.remind("s1", again);
        expect(again.pending()).toEqual([]);
    });

    it("tells it again when the person lets it act in a tab it was told it could only read", async () => {
        const { shares, shared } = setup();
        const inbox = new Inbox();
        await shares.remind("s1", inbox);
        shares.delivered("s1", inbox.drain());
        shared[0] = { ...shared[0], acts: true };
        const next = new Inbox();
        await shares.remind("s1", next);
        expect(next.pending().map((n) => n.text)).toEqual([sharedNote({ ...share, title: "Inbox", acts: true })]);
    });

    it("forgets a share the session no longer holds, so a new one is told", async () => {
        const { shares, shared } = setup();
        const inbox = new Inbox();
        await shares.remind("s1", inbox);
        shares.delivered("s1", inbox.drain());
        shared.length = 0;
        await shares.remind("s1", new Inbox());
        shared.push({ id: 9, url: share.url, title: "Inbox", working: false, shared: "mail.example" });
        const next = new Inbox();
        await shares.remind("s1", next);
        expect(next.pending()).toHaveLength(1);
    });
});
