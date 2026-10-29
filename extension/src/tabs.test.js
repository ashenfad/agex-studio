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
    sessions: { s: { name: "Hotels", origins: ["https://www.hyatt.com"] } },
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
        expect(rules[1].condition.urlFilter).toBe("|https://www.hyatt.com/");
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
