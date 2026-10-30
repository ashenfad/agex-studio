import { beforeEach, describe, expect, it } from "vitest";

/**
 * Enough of `chrome` for the worker's start: storage, session rules,
 * the open tabs and windows, and `onStartup`. An extension's update or
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
        expect(fake.areas.local.get("registry")).toEqual({ sessions: {}, tabs: {} });
    });
});

describe("a tab a page opens", () => {
    /** @type {ReturnType<typeof fakeChrome>} */
    let fake;
    /** @type {Record<string, (e: any) => void>} */
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
        const event = (/** @type {string} */ name) => ({ addListener: (/** @type {(e: any) => void} */ f) => (on[name] = f) });
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
