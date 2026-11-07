// No DOM here on purpose: the service worker has none, and all of this runs there.
import { describe, expect, it } from "vitest";
import {
    acceptFilter, checkWithoutDom, emptyState, freeIds, matchesOf, readState, removeSite, scriptId, setOn,
    setPaused, siteOfHost, siteOfScript, undoAccept, wantedRules,
} from "./state.js";

/** a filter of `n` block rules and one hide rule, as the worker's check passes it @param {number} n */
function filterOf(n) {
    const r = checkWithoutDom({
        version: 1,
        hide: [{ selector: ".promo" }],
        block: Array.from({ length: n }, (_, i) => ({ urlFilter: `||ads${i}.example^`, types: ["script"] })),
    }, "example.com");
    if ("errors" in r) throw new Error(r.errors.join("\n"));
    return r.filter;
}

describe("siteOfHost", () => {
    const sites = ["reddit.com", "example.co.uk", "old.example.co.uk"];

    it("matches the site and its subdomains", () => {
        expect(siteOfHost("reddit.com", sites)).toBe("reddit.com");
        expect(siteOfHost("www.reddit.com", sites)).toBe("reddit.com");
        expect(siteOfHost("a.b.reddit.com", sites)).toBe("reddit.com");
    });

    it("matches on a dot boundary only, never a sibling", () => {
        expect(siteOfHost("notreddit.com", sites)).toBe(null);
        expect(siteOfHost("reddit.com.evil.net", sites)).toBe(null);
        expect(siteOfHost("com", sites)).toBe(null);
    });

    it("takes the longest site a host is in, ignores case and a trailing dot", () => {
        expect(siteOfHost("old.example.co.uk", sites)).toBe("old.example.co.uk");
        expect(siteOfHost("x.old.example.co.uk", sites)).toBe("old.example.co.uk");
        expect(siteOfHost("new.example.co.uk", sites)).toBe("example.co.uk");
        expect(siteOfHost("WWW.Reddit.COM.", sites)).toBe("reddit.com");
    });

    it("names the patterns and the script of a site", () => {
        expect(matchesOf("reddit.com")).toEqual(["*://reddit.com/*", "*://*.reddit.com/*"]);
        expect(siteOfScript(scriptId("reddit.com"))).toBe("reddit.com");
        expect(siteOfScript("someone-else")).toBe(null);
    });
});

describe("checkWithoutDom", () => {
    it("checks the shape and the block rules in full", () => {
        const r = checkWithoutDom({ version: 1, hide: [{ selector: "a" }], block: [{ urlFilter: "||example.com^" }], extra: 1 }, "example.com");
        expect(r.ok).toBe(false);
        const errors = "errors" in r ? r.errors : [];
        expect(errors.some((e) => e.startsWith("extra:"))).toBe(true);
        expect(errors.some((e) => e.startsWith("block[0].urlFilter:"))).toBe(true);
    });

    it("keeps the hide rules for the page to check, refusing what isn't a list of objects", () => {
        expect(checkWithoutDom({ version: 1, hide: "a" }, "example.com").ok).toBe(false);
        expect(checkWithoutDom({ version: 1, hide: ["a"] }, "example.com").ok).toBe(false);
        expect(checkWithoutDom({ version: 1, hide: Array(201).fill({ selector: "a" }) }, "example.com").ok).toBe(false);
        expect(checkWithoutDom("{}", "example.com").ok).toBe(false);
        const r = checkWithoutDom({ version: 1, hide: [{ selector: "a", why: "x" }] }, "example.com");
        expect(r).toEqual({ ok: true, filter: { version: 1, hide: [{ selector: "a", why: "x" }], block: [] } });
    });
});

describe("the state", () => {
    it("reads what storage holds, leaving out what isn't a state's", () => {
        expect(readState(undefined)).toEqual(emptyState());
        expect(readState("x")).toEqual(emptyState());
        const raw = {
            paused: true,
            sites: {
                "reddit.com": { filter: { version: 1, hide: [], block: [] }, on: false, version: 3, rules: [4, 5, "x", -1] },
                "not a site": { filter: {}, on: true, version: 1, rules: [] },
                "a.com": { filter: "nope" },
                "b.com": { filter: { version: 1 } },
            },
        };
        expect(readState(raw)).toEqual({
            paused: true,
            sites: {
                "reddit.com": { filter: { version: 1, hide: [], block: [] }, on: false, version: 3, rules: [4, 5] },
                "b.com": { filter: { version: 1 }, on: true, version: 1, rules: [] },
            },
        });
    });

    it("accepts a filter on, one version up each time, leaving the state it came from as it was", () => {
        const s0 = emptyState();
        const s1 = acceptFilter(s0, "a.com", filterOf(2));
        expect(s0).toEqual(emptyState());
        expect(s1.sites["a.com"]).toMatchObject({ on: true, version: 1, rules: [1, 2] });
        const s2 = acceptFilter(setOn(s1, "a.com", false), "a.com", filterOf(3));
        expect(s2.sites["a.com"]).toMatchObject({ on: true, version: 2, rules: [1, 2, 3] });
    });

    it("undoes an accept: back to the filter it replaced, or to none for a site's first", () => {
        const first = filterOf(1);
        const s1 = acceptFilter(emptyState(), "a.com", first);
        expect(s1.sites["a.com"].previous).toBeUndefined();
        expect(undoAccept(s1, "a.com")).toEqual(emptyState());
        const s2 = acceptFilter(setOn(s1, "a.com", false), "a.com", filterOf(3));
        expect(s2.sites["a.com"].previous).toEqual(first);
        const back = undoAccept(s2, "a.com");
        expect(back.sites["a.com"]).toEqual({ filter: first, on: true, version: 3, rules: [1] });
        // undone once: nothing further back
        expect(undoAccept(back, "a.com")).toEqual(emptyState());
        expect(() => undoAccept(emptyState(), "a.com")).toThrow(/no filter is accepted for a.com/);
        expect(readState(JSON.parse(JSON.stringify(s2)))).toEqual(s2);
    });

    it("turns a site off and on, pauses, removes", () => {
        let s = acceptFilter(emptyState(), "a.com", filterOf(1));
        s = setOn(s, "a.com", false);
        expect(s.sites["a.com"].on).toBe(false);
        expect(setOn(s, "a.com", true).sites["a.com"].on).toBe(true);
        expect(() => setOn(s, "b.com", true)).toThrow(/no filter is accepted for b.com/);
        expect(setPaused(s, true)).toMatchObject({ paused: true, sites: s.sites });
        expect(removeSite(s, "a.com")).toEqual(emptyState());
        // a state round-trips through storage's JSON
        expect(readState(JSON.parse(JSON.stringify(s)))).toEqual(s);
    });
});

describe("the block rules' ids", () => {
    it("gives each site consecutive ids no other site holds, reusing the gaps", () => {
        let s = acceptFilter(emptyState(), "a.com", filterOf(2));
        s = acceptFilter(s, "b.com", filterOf(3));
        expect(s.sites["b.com"].rules).toEqual([3, 4, 5]);
        s = removeSite(s, "a.com");
        s = acceptFilter(s, "c.com", filterOf(1));
        expect(s.sites["c.com"].rules).toEqual([1]);
        // too many for the gap left: after the ids held
        s = acceptFilter(s, "d.com", filterOf(2));
        expect(s.sites["d.com"].rules).toEqual([6, 7]);
        expect(freeIds(s, "d.com", 2)).toEqual([6, 7]);
        expect(freeIds(s, "e.com", 1)).toEqual([2]);
        expect(freeIds(s, "e.com", 0)).toEqual([]);
    });

    it("a site's own ids are free to it when it is accepted again", () => {
        let s = acceptFilter(emptyState(), "a.com", filterOf(2));
        s = acceptFilter(s, "b.com", filterOf(1));
        s = acceptFilter(s, "a.com", filterOf(1));
        expect(s.sites["a.com"].rules).toEqual([1]);
    });

    it("wants each on site's rules under its ids, none while paused or off", () => {
        let s = acceptFilter(emptyState(), "a.com", filterOf(2));
        s = acceptFilter(s, "b.com", filterOf(1));
        const ids = () => wantedRules(s).map((r) => r.id);
        expect(ids()).toEqual([1, 2, 3]);
        expect(wantedRules(s)[2].condition).toMatchObject({ initiatorDomains: ["b.com"], resourceTypes: ["script"] });
        s = setOn(s, "a.com", false);
        expect(ids()).toEqual([3]);
        s = setPaused(s, true);
        expect(ids()).toEqual([]);
    });

    it("wants no rules of a site whose stored ids don't fit, or clash with another's", () => {
        const s = readState({
            sites: {
                "a.com": { filter: filterOf(2), rules: [1, 3] },
                "b.com": { filter: filterOf(1), rules: [7] },
                "c.com": { filter: filterOf(1), rules: [7] },
                "d.com": { filter: { version: 1, block: [{ urlFilter: "||d.com^" }] }, rules: [9] },
            },
        });
        expect(wantedRules(s).map((r) => r.id)).toEqual([7]);
    });
});
