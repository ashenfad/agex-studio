// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { capturedView, explain, matchAll, matches, parseCapture, shadowRoots } from "./engine.js";
import { checkFilter } from "./format.js";

/** a view that reads every node's text, for the matching alone @type {import("./engine.js").View} */
const plain = {
    text: (el) => (el.textContent ?? "").replace(/\s+/g, " ").trim(),
    box: () => null,
    visible: () => true,
};

/** a checked filter of these hide rules @param {unknown[]} hide */
function filterOf(...hide) {
    const r = checkFilter({ version: 1, hide }, { site: "example.com" });
    if (!r.ok) throw new Error(r.errors.join("\n"));
    return r.filter;
}

/** the one checked hide rule @param {Record<string, unknown>} rule */
const ruleOf = (rule) => filterOf(rule).hide[0];

/** ids, or tags where there is none @param {Iterable<Element>} els */
const names = (els) => [...els].map((el) => el.id || el.localName);

// a feed: a light card, a plain post, and a custom element whose shadow
// root has a badge and a slot, and a host of its own nested inside
const FEED = `<!doctype html><html><body><main>
  <div class="feed">
    <article id="a1"><span class="badge" id="b1">Sponsored</span><p>Buy now</p></article>
    <article id="a2"><p>Real post</p></article>
    <x-card id="c1"><template shadowrootmode="open"><div class="frame" id="f1"><span class="badge" id="b2">Sponsored</span><slot></slot></div><x-inner id="i1"><template shadowrootmode="open"><a class="promo" id="p1" href="https://ads.example/x">Ad</a><a class="promo" id="p2" href="/about">About</a></template></x-inner></template><p id="body1">Card body</p></x-card>
  </div>
</main></body></html>`;

describe("parseCapture", () => {
    it("attaches declarative shadow roots, nested ones too", () => {
        const doc = parseCapture(FEED);
        const card = /** @type {Element} */ (doc.getElementById("c1"));
        expect(card.shadowRoot?.querySelector(".badge")?.textContent).toBe("Sponsored");
        expect(card.querySelector("template")).toBe(null);
        const inner = /** @type {Element} */ (card.shadowRoot?.getElementById("i1"));
        expect(inner.shadowRoot?.querySelectorAll("a")).toHaveLength(2);
        expect(shadowRoots(doc)).toEqual([card.shadowRoot, inner.shadowRoot]);
    });
});

describe("matches", () => {
    const doc = parseCapture(FEED);

    it("runs a selector in the document and in every open shadow root", () => {
        expect(names(matches(doc, ruleOf({ selector: "span.badge" }), plain))).toEqual(["b1", "b2"]);
        expect(names(matches(doc, ruleOf({ selector: "a.promo" }), plain))).toEqual(["p1", "p2"]);
        expect(names(matches(doc, ruleOf({ selector: "x-card p" }), plain))).toEqual(["body1"]);
    });

    it("keeps matches whose text or attribute the pattern finds", () => {
        expect(names(matches(doc, ruleOf({ selector: "article", hasText: "Sponsored" }), plain))).toEqual(["a1"]);
        expect(names(matches(doc, ruleOf({ selector: "a", matchesAttr: { name: "href", pattern: "^https://ads\\." } }), plain))).toEqual(["p1"]);
        expect(names(matches(doc, ruleOf({ selector: "a", matchesAttr: { name: "data-x", pattern: "." } }), plain))).toEqual([]);
    });

    it("maps a match upward, by count or selector, out of shadow roots to their hosts", () => {
        expect(names(matches(doc, ruleOf({ selector: "span.badge", upward: "article" }), plain))).toEqual(["a1"]);
        expect(names(matches(doc, ruleOf({ selector: "span.badge", upward: "x-card, article" }), plain))).toEqual(["a1", "c1"]);
        expect(names(matches(doc, ruleOf({ selector: ".frame", upward: 1 }), plain))).toEqual(["c1"]);
        expect(names(matches(doc, ruleOf({ selector: "a.promo", upward: 2 }), plain))).toEqual(["c1"]);
        expect(names(matches(doc, ruleOf({ selector: "#a1 p", upward: 20 }), plain))).toEqual([]);
    });

    it("finds each element once, and never the page's root", () => {
        const twice = filterOf({ selector: "span.badge", upward: "article" }, { selector: "#a1 p", upward: 1 }, { selector: "#a1" });
        expect(names(matchAll(doc, twice, plain))).toEqual(["a1"]);
        // three up from the light badge: article, the feed, main
        expect(names(matches(doc, ruleOf({ selector: "#a1 > span", upward: 3 }), plain))).toEqual([]);
        expect(names(matches(doc, ruleOf({ selector: "#a1 > span", upward: 2 }), plain))).toEqual(["div"]);
    });
});

// a capture as the capture script leaves one: boxes on what draws, a
// hidden mark on what doesn't, a shadow root declared, no scripts
const CAPTURE = `<!doctype html><html data-agex-box="0 0 1280 3000"><head><title>Feed</title></head><body data-agex-box="0 0 1280 3000"><main data-agex-box="0 0 1280 3000">
  <article id="a1" data-agex-box="0 0 600 200"><span class="badge" id="s1" data-agex-box="10 10 80 20">Spon<span data-agex-hidden="">x</span>sored</span><p data-agex-box="10 40 500 20">Buy   now</p></article>
  <article id="a2" data-agex-hidden=""><span class="badge">Sponsored</span></article>
  <article id="a3" data-agex-box="0 220 600 200"><p data-agex-box="10 230 500 20">A real post</p></article>
  <x-card id="c1" data-agex-box="0 440 600 200"><template shadowrootmode="open"><style>.f{}</style><div class="frame" data-agex-box="0 440 600 200"><span class="badge" id="s2" data-agex-box="0 440 80 20">Promoted</span><slot name="title"></slot></div></template><h3 slot="title" data-agex-box="0 470 600 30">A deal</h3><p id="loose">not slotted</p></x-card>
  <x-card id="c2" data-agex-hidden=""><template shadowrootmode="open"><span class="badge" id="s3">Promoted</span></template></x-card>
</main></body></html>`;

describe("capturedView", () => {
    const doc = parseCapture(CAPTURE);
    const $ = (/** @type {string} */ id) => /** @type {Element} */ (doc.getElementById(id));

    it("reads the text a person sees: none under a hidden mark, whitespace collapsed, blocks apart", () => {
        expect(capturedView.text($("s1"))).toBe("Sponsored");
        expect(capturedView.text($("a1"))).toBe("Sponsored Buy now");
        expect(capturedView.text($("a2"))).toBe("");
        expect(capturedView.text(doc.body)).not.toMatch(/Feed|\.f\{\}/);
    });

    it("reads a host as it draws: its shadow tree, with what's slotted in its slots", () => {
        expect(capturedView.text($("c1"))).toBe("Promoted A deal");
    });

    it("reads boxes, and none for what isn't drawn, a shadow root's inside a hidden host too", () => {
        expect(capturedView.box($("a1"))).toEqual({ left: 0, top: 0, width: 600, height: 200 });
        expect(capturedView.box($("a2"))).toBe(null);
        expect(capturedView.visible($("a2").querySelector(".badge") ?? $("a2"))).toBe(false);
        const s3 = /** @type {Element} */ ($("c2").shadowRoot?.getElementById("s3"));
        expect(capturedView.visible(s3)).toBe(false);
        expect(capturedView.visible(/** @type {Element} */ ($("c1").shadowRoot?.getElementById("s2")))).toBe(true);
        expect(capturedView.box($("loose"))).toBe(null);
    });

    it("lets hasText see through letters shuffled into hidden spans", () => {
        expect(names(matches(doc, ruleOf({ selector: "span.badge", hasText: "^Sponsored$", upward: "article" }), capturedView))).toEqual(["a1"]);
        expect(names(matches(doc, ruleOf({ selector: "span.badge", hasText: "^Sponsored$", upward: "article" }), plain))).toEqual(["a2"]);
    });
});

describe("explain", () => {
    const doc = parseCapture(CAPTURE);

    it("says what each rule matches, how much of it shows, with samples", () => {
        const filter = filterOf(
            { selector: "span.badge", hasText: "Sponsored|Promoted", upward: "article, x-card", why: "ads" },
            { selector: "article", hasText: "nothing like this" },
            { selector: "#a1 p", upward: 2 },
        );
        const r = explain(doc, filter, capturedView);
        expect(r.hidden).toBe(2);
        expect(r.rules[0]).toEqual({
            rule: 0,
            selector: "span.badge",
            why: "ads",
            matched: 2,
            shown: 2,
            atRoot: 0,
            samples: [
                { tag: "article", path: "main > article#a1", text: "Sponsored Buy now" },
                { tag: "x-card", path: "main > x-card#c1", text: "Promoted A deal" },
            ],
        });
        expect(r.rules[1]).toMatchObject({ rule: 1, matched: 0, shown: 0, samples: [] });
        expect(r.rules[2]).toMatchObject({ rule: 2, matched: 0, atRoot: 1 });
    });

    it("counts what's already hidden apart from what shows, and gives paths through shadow roots", () => {
        const r = explain(doc, filterOf({ selector: "span.badge" }), capturedView);
        expect(r.rules[0]).toMatchObject({ matched: 4, shown: 2 });
        expect(r.rules[0].samples.map((s) => s.path)).toEqual([
            "main > article#a1 > span#s1",
            "main > x-card#c1 >> div.frame > span#s2",
            "main > article#a2 > span.badge",
        ]);
    });

    it("lets a rule this DOM can't parse fail alone, saying why", () => {
        // a selector one browser takes and another refuses
        const filter = /** @type {import("./format.js").Filter} */ ({ version: 1, hide: [{ selector: "a:::b" }, { selector: "article" }], block: [] });
        const r = explain(doc, filter, capturedView);
        expect(r.rules[0]).toMatchObject({ matched: 0, error: expect.stringMatching(/a:::b/) });
        expect(r.rules[1]).toMatchObject({ matched: 3 });
        expect(r.rules[1].error).toBeUndefined();
        expect(names(matchAll(doc, filter, capturedView))).toEqual(["a1", "a2", "a3"]);
    });

    it("cuts a long text and a deep path", () => {
        const deep = parseCapture(`<body><div class="a"><div class="b"><div class="c"><div class="d"><p id="t">${"word ".repeat(40)}</p></div></div></div></div></body>`);
        const [s] = explain(deep, filterOf({ selector: "#t" }), capturedView).rules[0].samples;
        expect(s.path).toBe("… div.b > div.c > div.d > p#t");
        expect(s.text).toHaveLength(80);
        expect(s.text.endsWith("…")).toBe(true);
    });
});
