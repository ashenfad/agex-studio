// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { FILTER_VERSION, checkFilter, toDnrRules } from "./format.js";
import { BLOCK_TYPES, MAX_BLOCK, MAX_HIDE, MAX_PATTERN, MAX_UPWARD, isSite } from "./guards.js";

const site = "reddit.com";

/** the errors `filter` gets, or [] when it passes @param {unknown} filter */
const errorsOf = (filter) => {
    const r = checkFilter(filter, { site });
    return r.ok ? [] : r.errors;
};

/** a filter of these hide rules @param {unknown[]} hide */
const hiding = (...hide) => ({ version: 1, hide });

/** a filter of these block rules @param {unknown[]} block */
const blocking = (...block) => ({ version: 1, block });

/** Whether this JavaScript engine compiles regex modifiers (`(?i:...)`). */
const MODIFIERS = (() => {
    try {
        new RegExp("(?i:a)");
        return true;
    } catch {
        return false;
    }
})();

describe("checkFilter", () => {
    it("passes the roadmap's example, normalized", () => {
        const filter = {
            version: 1,
            hide: [
                { selector: "shreddit-ad-post", why: "promoted posts" },
                { selector: "article", hasText: "Promoted", why: "native ads in the feed" },
                { selector: "span.badge", hasText: "Sponsored", upward: "article" },
                { selector: "a", matchesAttr: { name: "HREF", pattern: "^https://ads\\." }, upward: 2 },
                { selector: "div:has(> span.promo), x-card:is(.a, .b)" },
            ],
            block: [{ urlFilter: "||ads.example^", types: ["script", "image", "script"], why: "ad requests" }],
        };
        const r = checkFilter(filter, { site });
        expect(r).toEqual({
            ok: true,
            filter: {
                version: FILTER_VERSION,
                hide: [
                    filter.hide[0], filter.hide[1], filter.hide[2],
                    { selector: "a", matchesAttr: { name: "href", pattern: "^https://ads\\." }, upward: 2 },
                    filter.hide[4],
                ],
                block: [{ urlFilter: "||ads.example^", types: ["script", "image"], why: "ad requests" }],
            },
        });
    });

    it("fills in what's left out: no hide rules, no block rules", () => {
        expect(checkFilter({ version: 1 }, { site })).toEqual({ ok: true, filter: { version: 1, hide: [], block: [] } });
    });

    it("refuses a filter that isn't one, or of another version", () => {
        expect(errorsOf(null)[0]).toMatch(/must be an object/);
        expect(errorsOf([])[0]).toMatch(/must be an object/);
        expect(errorsOf({ hide: [] })).toEqual(["version: must be 1"]);
        expect(errorsOf({ version: 2 })).toEqual(["version: must be 1"]);
        expect(errorsOf({ version: 1, hide: {} })).toEqual(["hide: must be a list of rules"]);
        expect(errorsOf({ version: 1, rules: [] })).toEqual(["rules: not a field of a filter (version, hide, block)"]);
    });

    it("refuses a site that isn't a domain", () => {
        for (const s of ["", "com", "Reddit.com", "https://reddit.com", "*.reddit.com"]) {
            expect(checkFilter({ version: 1 }, { site: s }).ok, s).toBe(false);
        }
        expect(isSite("old.reddit.com")).toBe(true);
    });

    it("names each bad field, by its rule's place, in a sentence", () => {
        const errors = errorsOf(hiding(
            { selector: "article" },
            { selector: "div[" },
            { selector: "" },
            { selector: "a", hasText: "(" },
            { selector: "a", upward: 0 },
            { selector: "a", upward: MAX_UPWARD + 1 },
            { selector: "a", upward: "p:::" },
            { selector: "a", upward: true },
            { selector: "a", matchesAttr: { name: "has space", pattern: "x" } },
            { selector: "a", matchesAttr: "href" },
            { selector: "a", colour: "red" },
            "article",
            { selector: "a", why: 3 },
        ));
        expect(errors).toEqual([
            expect.stringMatching(/^hide\[1\]\.selector: not a valid CSS selector \(.+\)$/),
            "hide[2].selector: must be a CSS selector, a non-empty string",
            expect.stringMatching(/^hide\[3\]\.hasText: not a valid regular expression/),
            `hide[4].upward: a count must be a whole number from 1 to ${MAX_UPWARD}`,
            `hide[5].upward: a count must be a whole number from 1 to ${MAX_UPWARD}`,
            expect.stringMatching(/^hide\[6\]\.upward: not a valid CSS selector/),
            expect.stringMatching(/^hide\[7\]\.upward: must be a count of ancestors/),
            "hide[8].matchesAttr.name: must be an attribute's name (like href or data-testid)",
            "hide[9].matchesAttr: must be { name, pattern }",
            "hide[10].colour: not a field of a hide rule (selector, hasText, upward, matchesAttr, why)",
            "hide[11]: must be an object with a selector",
            "hide[12].why: must be a string",
        ]);
    });

    it("refuses a rule that would hide the page's root, its wrapper or its main", () => {
        for (const selector of ["html", "body", "main", ":root", "*", "body > *", "div", "html body", ":not(.ad)", "div:not(.ad)", "article, main"]) {
            const errors = errorsOf(hiding({ selector }));
            expect(errors, selector).toHaveLength(1);
            expect(errors[0], selector).toMatch(/^hide\[0\]\.selector: matches <\w+> on a bare page .* narrow it/);
        }
        expect(errorsOf(hiding({ selector: "span.badge", upward: "body" }))[0]).toMatch(/^hide\[0\]\.upward: matches <body>/);
        for (const selector of ["article", "div.feed-item", "main > div > article", "div:has(> span.ad)", "body > div.banner"]) {
            expect(errorsOf(hiding({ selector })), selector).toEqual([]);
        }
    });

    it("refuses selectors and attributes that name the extension's own marks", () => {
        expect(errorsOf(hiding({ selector: "[data-agex-box]" }))[0]).toMatch(/data-agex/);
        expect(errorsOf(hiding({ selector: "a", upward: "[data-agex-hidden]" }))[0]).toMatch(/data-agex/);
        expect(errorsOf(hiding({ selector: "a", matchesAttr: { name: "data-agex-box", pattern: "0" } }))[0]).toMatch(/data-agex/);
    });

    it("bounds patterns, and refuses one that repeats a repeat", () => {
        expect(errorsOf(hiding({ selector: "a", hasText: "x".repeat(MAX_PATTERN + 1) }))[0]).toMatch(/at most 300/);
        expect(errorsOf(hiding({ selector: "a", hasText: "(a+)+$" }))[0]).toMatch(/repeated group/);
        expect(errorsOf(hiding({ selector: "a", matchesAttr: { name: "class", pattern: "(\\w*)*" } }))[0]).toMatch(/^hide\[0\]\.matchesAttr\.pattern: has a repeated group/);
        // a part that ignores case: regex modifiers, which Chrome has had since 125 but an older
        // JavaScript engine (Node 22) can't compile, so there the guard refuses them as invalid
        const modifiers = hiding({ selector: "a", hasText: "(?i:sponsored)|Promoted" });
        if (MODIFIERS) expect(errorsOf(modifiers)).toEqual([]);
        else expect(errorsOf(modifiers)[0]).toMatch(/not a valid regular expression/);
        expect(errorsOf(hiding({ selector: "a", hasText: "(ad|promo)s?" }))).toEqual([]);
    });

    it("holds a filter to its caps", () => {
        const hide = Array.from({ length: MAX_HIDE + 1 }, () => ({ selector: "article" }));
        expect(errorsOf(hiding(...hide))).toEqual([`hide: has ${MAX_HIDE + 1} rules; at most ${MAX_HIDE}`]);
        expect(errorsOf(hiding(...hide.slice(1)))).toEqual([]);
        const block = Array.from({ length: MAX_BLOCK + 1 }, () => ({ urlFilter: "||ads.example^" }));
        expect(errorsOf(blocking(...block))).toEqual([`block: has ${MAX_BLOCK + 1} rules; at most ${MAX_BLOCK}`]);
    });

    it("refuses block rules for a page itself, or that block too much", () => {
        expect(errorsOf(blocking({ urlFilter: "||ads.example^", types: ["main_frame", "script"] }))).toEqual([
            "block[0].types: main_frame would block the site's own pages; no block rule may name it",
        ]);
        expect(errorsOf(blocking({ urlFilter: "||ads.example^", types: ["scripts"] }))[0]).toMatch(/^block\[0\]\.types: "scripts" is not a resource type/);
        expect(errorsOf(blocking({ urlFilter: "||ads.example^", types: [] }))[0]).toMatch(/non-empty list/);
        for (const urlFilter of ["*", "||", "|http", "^", "ad"]) {
            expect(errorsOf(blocking({ urlFilter }))[0], urlFilter).toMatch(/nearly every request/);
        }
        for (const urlFilter of ["||reddit.com^", "||www.reddit.com", "|https://old.reddit.com/*", "||reddit.com/"]) {
            expect(errorsOf(blocking({ urlFilter }))[0], urlFilter).toMatch(/the site's own host; add a path/);
        }
        expect(errorsOf(blocking({ urlFilter: "ads|tracker" }))[0]).toMatch(/\|\| only at its start/);
        expect(errorsOf(blocking({ urlFilter: "||ads.exämple^" }))[0]).toMatch(/ASCII/);
        expect(errorsOf(blocking({ urlFilter: "||reddit.com/ads/" }))).toEqual([]);
        expect(errorsOf(blocking({ urlFilter: "/promoted/*.js|" }))).toEqual([]);
        expect(errorsOf(blocking({ urlFilter: "||ads.example^", why: "x", types: ["script"], initiatorDomains: ["evil.example"] }))).toEqual([
            "block[0].initiatorDomains: not a field of a block rule (urlFilter, types, why)",
        ]);
    });
});

describe("toDnrRules", () => {
    it("holds each block rule to the site's own pages, never a page itself", () => {
        const r = checkFilter(blocking({ urlFilter: "||ads.example^", types: ["script", "image"] }, { urlFilter: "/promo/" }), { site });
        if (!r.ok) throw new Error(r.errors.join("\n"));
        const rules = toDnrRules(r.filter, { site, firstId: 10 });
        expect(rules).toEqual([
            { id: 10, priority: 1, action: { type: "block" }, condition: { urlFilter: "||ads.example^", initiatorDomains: [site], resourceTypes: ["script", "image"] } },
            { id: 11, priority: 1, action: { type: "block" }, condition: { urlFilter: "/promo/", initiatorDomains: [site], resourceTypes: [...BLOCK_TYPES] } },
        ]);
        expect(rules[1].condition.resourceTypes).not.toContain("main_frame");
    });

    it("drops main_frame even from a filter that wasn't checked", () => {
        const filter = /** @type {any} */ ({ version: 1, hide: [], block: [{ urlFilter: "||ads.example^", types: ["main_frame", "script"] }] });
        expect(toDnrRules(filter, { site, firstId: 1 })[0].condition.resourceTypes).toEqual(["script"]);
        expect(() => toDnrRules(filter, { site: "com", firstId: 1 })).toThrow(/not a site/);
    });
});
