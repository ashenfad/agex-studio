// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";

const BLOCKING = { version: 1, hide: [{ selector: ".ad" }], block: [{ urlFilter: "||ads.example^", types: ["script"] }] };

/**
 * Enough of `chrome` for the applier's worker side: storage that can be
 * made to fail, dynamic rules, content scripts, tabs, and host permission
 * per site, which the test can take back.
 */
function fakeChrome() {
    /** @type {Map<string, unknown>} */
    const local = new Map();
    const fake = {
        failSaves: false,
        /** @type {Set<string>} */
        permitted: new Set(),
        /** @type {any[]} */
        rules: [],
        chrome: /** @type {any} */ (null),
    };
    const listener = () => ({ addListener() {} });
    fake.chrome = {
        storage: {
            local: {
                get: async (/** @type {string} */ k) => (local.has(k) ? { [k]: structuredClone(local.get(k)) } : {}),
                set: async (/** @type {Record<string, unknown>} */ o) => {
                    if (fake.failSaves) throw new Error("QUOTA_BYTES quota exceeded");
                    for (const [k, v] of Object.entries(o)) local.set(k, structuredClone(v));
                },
            },
        },
        declarativeNetRequest: {
            getDynamicRules: async () => structuredClone(fake.rules),
            updateDynamicRules: async (/** @type {any} */ { removeRuleIds = [], addRules = [] }) => {
                fake.rules = [...fake.rules.filter((r) => !removeRuleIds.includes(r.id)), ...addRules];
            },
        },
        scripting: {
            getRegisteredContentScripts: async () => [],
            registerContentScripts: async () => {},
            unregisterContentScripts: async () => {},
            executeScript: async () => [],
        },
        tabs: { query: async () => [] },
        permissions: {
            // held for a site when both its patterns are
            contains: async (/** @type {{ origins: string[] }} */ { origins }) => origins.every((o) => fake.permitted.has(o.replace(/^\*:\/\/(\*\.)?/, "").replace(/\/\*$/, ""))),
            onRemoved: listener(),
            onAdded: listener(),
        },
        runtime: { onInstalled: listener(), onStartup: listener() },
    };
    return fake;
}

describe("the applier's rules", () => {
    /** @type {ReturnType<typeof fakeChrome>} */
    let fake;
    /** @type {typeof import("./sites.js")} */
    let sites;
    beforeEach(async () => {
        fake = fakeChrome();
        Object.assign(globalThis, { chrome: fake.chrome });
        sites = await import("./sites.js");
    });
    const op = (/** @type {string} */ name, /** @type {Record<string, unknown>} */ args = {}) => sites.applyOps[name]({ op: name, ...args });

    it("puts the rules back when the state can't be saved, so they never disagree", async () => {
        fake.permitted.add("shop.example");
        await op("filterAccept", { site: "shop.example", filter: BLOCKING });
        expect(fake.rules).toHaveLength(1);
        fake.failSaves = true;
        await expect(op("filterSetOn", { site: "shop.example", on: false })).rejects.toThrow(/quota/);
        // still on, as stored: its rule stays
        expect(fake.rules).toHaveLength(1);
        expect((await op("filterState", { site: "shop.example" })).sites["shop.example"].on).toBe(true);
    });

    it("installs no rule for a site whose permission the person took back", async () => {
        fake.permitted.add("shop.example");
        await op("filterAccept", { site: "shop.example", filter: BLOCKING });
        expect(fake.rules).toHaveLength(1);
        fake.permitted.delete("shop.example");
        await sites.repair();
        expect(fake.rules).toHaveLength(0);
        // the filter stays stored, for when the permission is given again
        expect(Object.keys((await op("filterState")).sites)).toEqual(["shop.example"]);
        fake.permitted.add("shop.example");
        await sites.repair();
        expect(fake.rules).toHaveLength(1);
    });
});
