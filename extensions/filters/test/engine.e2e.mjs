// The filter engine and its applier in a real page, in Chromium: the text
// a person sees (letters shuffled into hidden spans, labels in shadow
// roots), and a filter hiding, outlining and still hiding what a feed adds.
//
//     node --test extensions/filters/test/engine.e2e.mjs

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

// the filters extension's folder, served: its test pages and its modules
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** @param {string} file */
const typeOf = (file) => (file.endsWith(".html") ? "text/html" : file.endsWith(".js") ? "text/javascript" : "application/octet-stream");

const FILTER = {
    version: 1,
    hide: [
        { selector: "span.label", hasText: "^Sponsored$", upward: "article, x-post", why: "native ads" },
        { selector: "span.promo", why: "a component's promo" },
    ],
};

describe("the engine and the applier in a live page", () => {
    /** @type {import("node:http").Server} */
    let server;
    /** @type {import("playwright").Browser} */
    let browser;
    /** @type {import("playwright").Page} */
    let page;

    before(async () => {
        server = createServer((req, res) => {
            const file = join(ROOT, new URL(req.url ?? "/", "http://x").pathname);
            if (!file.startsWith(ROOT) || !existsSync(file)) {
                res.statusCode = 404;
                res.end();
                return;
            }
            res.setHeader("content-type", typeOf(file));
            res.end(readFileSync(file));
        });
        await new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(undefined)));
        const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
        browser = await chromium.launch({ channel: "chromium", headless: true });
        page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${port}/test/page/feed.html`);
        await page.evaluate(async (filter) => {
            const w = /** @type {any} */ (window);
            w.engine = await import("/src/filter/engine.js");
            w.apply = await import("/src/filter/apply.js");
            const { checkFilter } = await import("/src/filter/format.js");
            const r = checkFilter(filter, { site: "example.com" });
            if (!r.ok) throw new Error(r.errors.join("\n"));
            w.filter = r.filter;
        }, FILTER);
    });
    after(async () => {
        await browser?.close();
        server?.close();
    });

    /** the ids of what's hidden now: shown as display: none */
    const hiddenIds = () => page.evaluate(() =>
        [...document.querySelectorAll("#feed > *")].filter((el) => getComputedStyle(el).display === "none").map((el) => el.id));

    it("reads the text a person sees: not hidden letters, not hidden labels, into shadow roots", async () => {
        const r = await page.evaluate(() => {
            const { engine, filter } = /** @type {any} */ (window);
            /** @type {any} */
            const raw = { text: (/** @type {Element} */ el) => el.textContent, box: () => null, visible: () => true };
            const ids = (/** @type {Element[]} */ els) => els.map((el) => el.id);
            return {
                live: ids(engine.matches(document, filter.hide[0], engine.liveView)),
                raw: ids(engine.matches(document, filter.hide[0], raw)),
                p1: engine.liveView.text(document.getElementById("p1")),
                p4: engine.liveView.text(document.getElementById("p4")),
                box: engine.liveView.box(document.getElementById("p1")),
                p3Label: engine.liveView.text(document.querySelector("#p3 .label")),
            };
        });
        assert.deepEqual(r.live, ["p1", "p4"]);
        assert.deepEqual(r.raw, ["p3"], "the raw text sees the hidden label and not the shuffled ones");
        assert.equal(r.p1, "Sponsored Buy a thing");
        assert.equal(r.p4, "SponsoredPromo A promoted thing", "inline spans side by side, as they draw");
        assert.equal(r.p3Label, "");
        assert.ok(r.box.width > 0 && r.box.height > 0, JSON.stringify(r.box));
    });

    it("reads a capture rebuilt by the browser's own parser as it reads the live page", async () => {
        const r = await page.evaluate(() => {
            const { engine, filter } = /** @type {any} */ (window);
            // as the walk writes it: boxes, and blocks where layout drew one
            const capture = '<body data-agex-box="0 0 800 600"><main data-agex-box="0 0 800 600">' +
                '<article id="c1" data-agex-box="0 0 800 100"><span class="label" data-agex-box="0 0 80 20">Spon<span data-agex-hidden="">x</span>sored</span></article>' +
                '<x-post id="c2" data-agex-box="0 100 800 100"><template shadowrootmode="open"><div class="card" data-agex-box="0 100 800 100" data-agex-block><span class="label" data-agex-box="0 100 80 20">Sponsored</span><slot></slot></div></template><p data-agex-box="0 120 800 20" data-agex-block>slotted</p></x-post>' +
                '<article id="c3" data-agex-hidden=""><span class="label">Sponsored</span></article>' +
                "</main></body>";
            const doc = engine.parseCapture(capture);
            return {
                native: typeof (/** @type {any} */ (Document)).parseHTMLUnsafe,
                ids: engine.matches(doc, filter.hide[0], engine.capturedView).map((/** @type {Element} */ el) => el.id),
                c2: engine.capturedView.text(doc.getElementById("c2")),
            };
        });
        assert.equal(r.native, "function");
        assert.deepEqual(r.ids, ["c1", "c2"]);
        assert.equal(r.c2, "Sponsored slotted");
    });

    it("hides what the filter matches, in the page and in nested shadow roots", async () => {
        const r = await page.evaluate(() => {
            const { apply, filter } = /** @type {any} */ (window);
            const w = /** @type {any} */ (window);
            w.applied = apply.applyFilter(document, filter, { mode: "hide" });
            const promo = /** @type {Element} */ (document.getElementById("p5")?.shadowRoot?.querySelector("x-badge")?.shadowRoot?.querySelector(".promo"));
            return {
                count: w.applied.count(),
                promo: getComputedStyle(promo).display,
                promoStyle: promo.getRootNode() !== document && /** @type {ShadowRoot} */ (promo.getRootNode()).querySelector("style[data-agex-filter-style]") !== null,
            };
        });
        assert.deepEqual(await hiddenIds(), ["p1", "p4"]);
        // p1, p4, and the promo in each x-post's badge
        assert.equal(r.count, 4);
        assert.equal(r.promo, "none");
        assert.equal(r.promoStyle, true);
    });

    it("outlines what it would hide, to preview it, and keeps the count", async () => {
        const r = await page.evaluate(() => {
            const { apply, filter } = /** @type {any} */ (window);
            const w = /** @type {any} */ (window);
            w.applied = apply.applyFilter(document, filter, { mode: "outline" });
            const p1 = /** @type {Element} */ (document.getElementById("p1"));
            return { count: w.applied.count(), mark: p1.getAttribute("data-agex-filtered"), outline: getComputedStyle(p1).outlineStyle };
        });
        assert.deepEqual(await hiddenIds(), []);
        assert.equal(r.count, 4);
        assert.equal(r.mark, "outline");
        assert.equal(r.outline, "dashed");
    });

    it("keeps hiding what the page adds later, and what it had hidden", async () => {
        await page.evaluate(() => {
            const { apply, filter } = /** @type {any} */ (window);
            /** @type {any} */ (window).applied = apply.applyFilter(document, filter, { mode: "hide", debounce: 50 });
        });
        const added = await page.evaluate(() => /** @type {any} */ (window).loadMore());
        await page.waitForFunction((id) => getComputedStyle(/** @type {Element} */ (document.getElementById(id))).display === "none", added[0]);
        await page.waitForTimeout(300);
        assert.deepEqual(await hiddenIds(), ["p1", "p4", added[0], added[2]]);
        assert.equal(await page.evaluate(() => /** @type {any} */ (window).applied.count()), 7);

        // a post changed in place, as a single-page app reuses its elements
        await page.evaluate(() => {
            /** @type {Element} */ (document.getElementById("p2")).innerHTML = '<span class="label">Sponsored</span><p>Now an ad</p>';
        });
        await page.waitForTimeout(300);
        assert.deepEqual(await hiddenIds(), ["p1", "p2", "p4", added[0], added[2]]);
    });

    it("undoes everything when turned off", async () => {
        const r = await page.evaluate(() => {
            const { apply, filter } = /** @type {any} */ (window);
            const off = apply.applyFilter(document, filter, { mode: "off" });
            const roots = [document, ...(/** @type {any} */ (window)).engine.shadowRoots(document)];
            return {
                count: off.count(),
                marks: roots.reduce((n, r) => n + r.querySelectorAll("[data-agex-filtered]").length, 0),
                styles: roots.reduce((n, r) => n + r.querySelectorAll("style[data-agex-filter-style]").length, 0),
            };
        });
        assert.deepEqual(r, { count: 0, marks: 0, styles: 0 });
        assert.deepEqual(await hiddenIds(), []);
        await page.evaluate(() => /** @type {any} */ (window).loadMore());
        await page.waitForTimeout(300);
        assert.deepEqual(await hiddenIds(), [], "nothing is watching any more");
    });

    it("reads the text a zero-size wrapper shows through what overflows it", async () => {
        const text = await page.evaluate(() => {
            const wrap = document.createElement("div");
            wrap.style.height = "0";
            wrap.innerHTML = '<span style="position:absolute">Sponsored</span>';
            /** @type {Element} */ (document.getElementById("feed")).append(wrap);
            const { engine } = /** @type {any} */ (window);
            const out = { text: engine.liveView.text(wrap), visible: engine.liveView.visible(wrap) };
            wrap.remove();
            return out;
        });
        // it draws nothing of its own, but what it holds shows, and hiding it would hide that
        assert.deepEqual(text, { text: "Sponsored", visible: false });
    });

    it("filters inside a shadow root attached after it started, which no mutation announces", async () => {
        const hidden = await page.evaluate(async () => {
            const { apply } = /** @type {any} */ (window);
            const { checkFilter } = await import("/src/filter/format.js");
            const late = document.createElement("x-late");
            /** @type {Element} */ (document.getElementById("feed")).append(late);
            const r = checkFilter({ version: 1, hide: [{ selector: ".late-ad" }] }, { site: "example.com" });
            const applied = apply.applyFilter(document, r.ok ? r.filter : null, { mode: "hide", debounce: 50 });
            // upgraded now: its shadow root is attached with nothing in the document changing
            customElements.define("x-late", class extends HTMLElement {
                constructor() {
                    super();
                    this.attachShadow({ mode: "open" }).innerHTML = '<span class="late-ad">ad</span>';
                }
            });
            const ad = /** @type {Element} */ (late.shadowRoot?.querySelector(".late-ad"));
            const until = Date.now() + 3000;
            while (getComputedStyle(ad).display !== "none" && Date.now() < until) await new Promise((ok) => setTimeout(ok, 100));
            const out = getComputedStyle(ad).display;
            applied.stop();
            return out;
        });
        assert.equal(hidden, "none");
    });
});
