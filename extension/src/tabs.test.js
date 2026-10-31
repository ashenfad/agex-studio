import { beforeEach, describe, expect, it } from "vitest";

/**
 * Enough of `chrome` for the worker's start: storage, session rules,
 * the open tabs and windows, `onStartup`, and the toolbar's badge. An extension's update or
 * reload clears its session rules and leaves its tabs open, which an
 * end-to-end test can't stage (Chromium won't reload an extension loaded
 * from the command line).
 */
function fakeChrome({ open = /** @type {number[]} */ ([]), rules = /** @type {any[]} */ ([]), registry = /** @type {any} */ (undefined) }) {
    const areas = { local: new Map(), session: new Map() };
    if (registry) areas.local.set("registry", registry);
    const area = (/** @type {Map<string, unknown>} */ m) => ({
        get: async (/** @type {string} */ k) => (m.has(k) ? { [k]: structuredClone(m.get(k)) } : {}),
        set: async (/** @type {Record<string, unknown>} */ o) => {
            for (const [k, v] of Object.entries(o)) m.set(k, structuredClone(v));
        },
    });
    /** @type {(() => void)[]} */
    const startup = [];
    const chrome = {
        storage: { local: area(areas.local), session: area(areas.session) },
        declarativeNetRequest: {
            rules,
            getSessionRules: async () => structuredClone(chrome.declarativeNetRequest.rules),
            updateSessionRules: async ({ removeRuleIds = /** @type {number[]} */ ([]), addRules = [] }) => {
                chrome.declarativeNetRequest.rules = [...chrome.declarativeNetRequest.rules.filter((r) => !removeRuleIds.includes(r.id)), ...addRules];
            },
        },
        tabs: {
            get: async (/** @type {number} */ id) => {
                if (!open.includes(id)) throw new Error(`No tab with id: ${id}`);
                return { id, windowId: 1, active: false };
            },
            query: async () => [{ id: 99, windowId: 1, active: true }],
        },
        windows: { getLastFocused: async () => ({ id: 1 }) },
        runtime: { onStartup: { addListener: (/** @type {() => void} */ f) => startup.push(f) } },
        action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
    };
    return { chrome, areas, startup };
}

/** Let the registry's queue run dry. */
const settle = async () => {
    const { change } = await import("./registry.js");
    await change(() => {});
};

const registry = {
    sessions: { s: { name: "Hotels", domains: ["hyatt.com"] } },
    tabs: { 7: { session: "s" }, 8: { session: "s" } },
};

describe("the worker's start", () => {
    /** @type {ReturnType<typeof fakeChrome>} */
    let fake;
    beforeEach(() => {
        fake = fakeChrome({ open: [7], registry });
        Object.assign(globalThis, { chrome: fake.chrome });
    });

    it("holds the registry's open tabs again when their rules are gone, and drops the closed ones", async () => {
        const { start } = await import("./tabs.js");
        start();
        await settle();
        const rules = fake.chrome.declarativeNetRequest.rules;
        expect(rules.map((r) => [r.action.type, r.condition.tabIds])).toEqual([
            ["block", [7]],
            ["allow", [7]],
        ]);
        expect(rules[1].condition.requestDomains).toEqual(["hyatt.com"]);
        expect(Object.keys(/** @type {any} */ (fake.areas.local.get("registry")).tabs)).toEqual(["7"]);
    });

    it("leaves a tab the person shared unheld: its loads are theirs", async () => {
        fake = fakeChrome({ open: [7, 9], registry: { ...registry, tabs: { ...registry.tabs, 9: { session: "s", shared: { domain: "www.mail.example", at: 1 } } } } });
        Object.assign(globalThis, { chrome: fake.chrome });
        const { start } = await import("./tabs.js");
        start();
        await settle();
        expect(fake.chrome.declarativeNetRequest.rules.map((r) => r.condition.tabIds)).toEqual([[7], [7]]);
        expect(Object.keys(/** @type {any} */ (fake.areas.local.get("registry")).tabs)).toEqual(["7", "9"]);
    });

    it("leaves a tab's rules as they are when it still has them", async () => {
        const kept = [{ id: 3, priority: 1, action: { type: "block" }, condition: { tabIds: [7], resourceTypes: ["main_frame"] } }];
        fake.chrome.declarativeNetRequest.rules = structuredClone(kept);
        const { start } = await import("./tabs.js");
        start();
        await settle();
        expect(fake.chrome.declarativeNetRequest.rules).toEqual(kept);
    });

    it("starts empty when the browser starts: every tab id kept is stale", async () => {
        const { start } = await import("./tabs.js");
        start();
        for (const f of fake.startup) f();
        await settle();
        expect(fake.chrome.declarativeNetRequest.rules).toEqual([]);
        expect(fake.areas.local.get("registry")).toEqual({ sessions: {}, tabs: {}, shares: {} });
    });
});

describe("a tab a page opens", () => {
    /** @type {ReturnType<typeof fakeChrome>} */
    let fake;
    /** @type {Record<string, (...a: any[]) => void>} */
    let on;
    /** @type {number[]} */
    let removed;
    /** whether the tab's last load ended in an error page */
    let errorPage = false;
    beforeEach(async () => {
        fake = fakeChrome({ registry: { sessions: registry.sessions, tabs: { 7: { session: "s" } } } });
        on = {};
        removed = [];
        errorPage = false;
        // every listener an event has, called in turn
        const event = (/** @type {string} */ name) => ({
            addListener: (/** @type {(...a: any[]) => void} */ f) => {
                const before = on[name];
                on[name] = (/** @type {any[]} */ ...a) => {
                    before?.(...a);
                    f(...a);
                };
            },
        });
        const chrome = /** @type {any} */ (fake.chrome);
        Object.assign(chrome.tabs, {
            // still where it started, on a grant, though a redirect has sent it on
            get: async (/** @type {number} */ id) => ({ id, windowId: 1, active: false, url: "https://www.hyatt.com/go", groupId: -1 }),
            remove: async (/** @type {number} */ id) => void removed.push(id),
            group: async () => 1,
            onActivated: event("activated"),
            onRemoved: event("tabRemoved"),
            onReplaced: event("replaced"),
        });
        chrome.windows = { ...chrome.windows, onFocusChanged: event("focus"), onRemoved: event("windowRemoved") };
        chrome.tabGroups = { TAB_GROUP_ID_NONE: -1, get: async () => ({ title: "Hotels" }), update: async () => {} };
        chrome.webNavigation = {
            onCreatedNavigationTarget: event("created"),
            onCommitted: event("committed"),
            onErrorOccurred: event("error"),
            getFrame: async () => ({ errorOccurred: errorPage }),
        };
        Object.assign(globalThis, { chrome });
        const { watchTabs } = await import("./tabs.js");
        watchTabs();
        on.created({ sourceTabId: 7, tabId: 20, url: "https://www.hyatt.com/go" });
        await settle();
    });

    /** @returns {any} */
    const kept = () => fake.areas.local.get("registry");

    it("is closed when it gets somewhere without a grant its rules were too late for", async () => {
        expect(kept().tabs[20]).toMatchObject({ session: "s", opened: true, opener: 7 });
        on.committed({ tabId: 20, frameId: 0, url: "https://elsewhere.example/" });
        await settle();
        expect(removed).toEqual([20]);
        expect(kept().tabs[20]).toBeUndefined();
        expect(kept().tabs[7].blocked).toMatchObject({ url: "https://elsewhere.example/", newTab: true });
        expect(fake.chrome.declarativeNetRequest.rules.filter((r) => r.condition.tabIds?.includes(20))).toEqual([]);
    });

    it("marks its opener blocked under the opener's new id, once a prerendered page has swapped it in", async () => {
        on.replaced(30, 7);
        await settle();
        on.committed({ tabId: 20, frameId: 0, url: "https://elsewhere.example/" });
        await settle();
        expect(removed).toEqual([20]);
        expect(kept().tabs[7]).toBeUndefined();
        expect(kept().tabs[30].blocked).toMatchObject({ url: "https://elsewhere.example/", newTab: true });
    });

    it("carries a share waiting for the studio over to the tab's new id, badged", async () => {
        /** @type {Record<number, string>} */
        const badged = {};
        /** @type {any} */ (fake.chrome).action.setBadgeText = async (/** @type {any} */ { tabId, text }) => void (badged[tabId] = text);
        fake.areas.local.set("registry", { ...kept(), shares: { 40: { domain: "mail.example", at: 3 } } });
        on.replaced(41, 40);
        await settle();
        await settle();
        expect(kept().shares).toEqual({ 41: { domain: "mail.example", at: 3 } });
        expect(badged[41]).toBe("…");
    });

    it("is kept when it gets somewhere granted, in a frame, or to the error page of a load its rules stopped", async () => {
        on.committed({ tabId: 20, frameId: 0, url: "https://www.hyatt.com/rooms" });
        on.committed({ tabId: 20, frameId: 3, url: "https://ads.example/" });
        await settle();
        errorPage = true;
        on.committed({ tabId: 20, frameId: 0, url: "https://elsewhere.example/" });
        await settle();
        expect(removed).toEqual([]);
        expect(kept().tabs[20]).toMatchObject({ opener: 7 });
        expect(kept().tabs[7].blocked).toBeUndefined();
    });
});

describe("a read of a shared tab, checked before it's given", () => {
    /** @type {ReturnType<typeof fakeChrome>} */
    let fake;
    const share = { domain: "www.github.io", at: 5 };
    beforeEach(() => {
        fake = fakeChrome({ open: [9], registry: { sessions: { s: { name: "Notes", domains: [] } }, tabs: { 9: { session: "s", shared: share } } } });
        Object.assign(globalThis, { chrome: fake.chrome });
    });

    it("passes on the host it was shared on, a subdomain of it, and the bare host of a www. one", async () => {
        const { stillOn } = await import("./tabs.js");
        for (const url of ["https://www.github.io/a", "https://docs.www.github.io/", "https://github.io/b"]) await expect(stillOn("s", 9, share, url), url).resolves.toBeUndefined();
    });

    it("refuses a sibling of it, or another site, as moved", async () => {
        const { stillOn } = await import("./tabs.js");
        for (const url of ["https://someone.github.io/", "https://example.com/", "chrome://settings/"]) await expect(stillOn("s", 9, share, url), url).rejects.toMatchObject({ code: "moved" });
    });

    it("refuses once the share has ended, or the tab is shared again since, with this session or another", async () => {
        const { stillOn } = await import("./tabs.js");
        const url = "https://www.github.io/";
        const again = (/** @type {any} */ tab) => fake.areas.local.set("registry", { sessions: { s: { name: "Notes", domains: [] } }, tabs: { 9: tab } });
        again({ session: "s", shared: { ...share, at: 6 } });
        await expect(stillOn("s", 9, share, url)).rejects.toMatchObject({ code: "not-found" });
        again({ session: "t", shared: share });
        await expect(stillOn("s", 9, share, url)).rejects.toMatchObject({ code: "not-found" });
        fake.areas.local.set("registry", { sessions: {}, tabs: {} });
        await expect(stillOn("s", 9, share, url)).rejects.toMatchObject({ code: "not-found" });
    });
});

describe("the toolbar's popup", () => {
    /** @type {ReturnType<typeof fakeChrome>} */
    let fake;
    /** @type {Record<number, string>} */
    const urls = { 7: "https://hotel.example/rooms", 8: "https://www.mail.example/inbox", 9: "chrome://settings/", 10: "https://agex.studio/", 11: "http://localhost:4173/", 12: "https://news.example/" };
    /** @type {Record<number, { text?: string, title?: string }>} */
    let badges;
    /** @type {any[]} */
    let fronted;
    beforeEach(() => {
        fake = fakeChrome({
            open: Object.keys(urls).map(Number),
            registry: {
                sessions: { s: { name: "Hotels", domains: ["hotel.example"] } },
                tabs: { 7: { session: "s" }, 12: { session: "s", shared: { domain: "news.example", at: 1 } } },
            },
        });
        // the studio last connected from tab 11, a dev server's
        fake.areas.session.set("registry", { windows: {}, focused: [], studio: { tab: 11, origin: "http://localhost:4173" } });
        badges = {};
        fronted = [];
        const chrome = /** @type {any} */ (fake.chrome);
        Object.assign(chrome.tabs, {
            get: async (/** @type {number} */ id) => {
                if (!(id in urls)) throw new Error(`No tab with id: ${id}`);
                return { id, windowId: 1, active: false, url: urls[id], title: `tab ${id}` };
            },
            update: async (/** @type {number} */ id, /** @type {any} */ props) => void fronted.push(["tab", id, props]),
            query: async () => [],
            create: async (/** @type {any} */ props) => void fronted.push(["new", props.url]),
        });
        chrome.windows = { ...chrome.windows, update: async (/** @type {number} */ id) => void fronted.push(["window", id]) };
        chrome.action = {
            setBadgeText: async ({ tabId, text }) => void (badges[tabId] = { ...badges[tabId], text }),
            setBadgeBackgroundColor: async () => {},
            setTitle: async ({ tabId, title }) => void (badges[tabId] = { ...badges[tabId], title }),
        };
        Object.assign(globalThis, { chrome });
    });

    it("says what each tab is: shareable, a session's own or shared, the studio, or another kind of page", async () => {
        const { popupState } = await import("./tabs.js");
        expect(await popupState(8)).toEqual({ kind: "share", domain: "www.mail.example" });
        expect(await popupState(7)).toEqual({ kind: "session", name: "Hotels" });
        expect(await popupState(12)).toEqual({ kind: "shared", name: "Hotels", domain: "news.example" });
        expect(await popupState(9)).toEqual({ kind: "page" });
        expect(await popupState(10)).toEqual({ kind: "studio" });
        expect(await popupState(11)).toEqual({ kind: "studio" });
    });

    it("keeps a share, badged as waiting, brings the studio's tab to the front, and badges it shared once taken", async () => {
        const { offer, popupState, stopSharing, tabOps } = await import("./tabs.js");
        await offer(8);
        expect(await popupState(8)).toEqual({ kind: "waiting", domain: "www.mail.example" });
        expect(badges[8]).toEqual({ text: "…", title: "Waiting for agex.studio to say which session takes this tab" });
        expect(fronted).toEqual([["tab", 11, { active: true }], ["window", 1]]);
        await tabOps.take(/** @type {any} */ ({ id: 1, op: "take", session: "s", tab: 8 }), /** @type {any} */ ({}));
        expect(badges[8]).toEqual({ text: "on", title: "Shared with Hotels, to read while it's on www.mail.example" });
        await stopSharing(8);
        expect(badges[8]).toEqual({ text: "", title: "Share this tab with agex.studio" });
        expect(await popupState(8)).toEqual({ kind: "share", domain: "www.mail.example" });
    });

    it("opens agex.studio when the studio's tab has gone to another site", async () => {
        const { offer, popupState } = await import("./tabs.js");
        urls[11] = "https://elsewhere.example/";
        try {
            // no longer the studio's: a page of the person's, and not where a share goes
            expect(await popupState(11)).toEqual({ kind: "share", domain: "elsewhere.example" });
            await offer(8);
            expect(fronted).toEqual([["new", "https://agex.studio/"]]);
        } finally {
            urls[11] = "http://localhost:4173/";
        }
    });

    it("leaves a share another studio tab took as it is, when one turns it down after", async () => {
        const { offer, tabOps } = await import("./tabs.js");
        await offer(8);
        await tabOps.take(/** @type {any} */ ({ id: 1, op: "take", session: "s", tab: 8 }), /** @type {any} */ ({}));
        await tabOps.drop(/** @type {any} */ ({ id: 2, op: "drop", tab: 8 }), /** @type {any} */ ({}));
        expect(badges[8]?.text).toBe("on");
        expect(/** @type {any} */ (fake.areas.local.get("registry")).tabs[8]).toMatchObject({ session: "s", shared: { domain: "www.mail.example" } });
    });

    it("refuses to share a session's tab, the studio's, or a browser page", async () => {
        const { offer } = await import("./tabs.js");
        for (const tab of [7, 9, 10, 11, 12]) await expect(offer(tab), String(tab)).rejects.toThrow("can't be shared");
        expect(fronted).toEqual([]);
    });
});
