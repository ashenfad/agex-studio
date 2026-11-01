// A page captured as it renders and rebuilt away from it, end to end, in
// Playwright's Chromium (headless): the fixtures under `page/` captured as
// the extension will (`capturePage` sent as source), then rebuilt in a
// page of their own as the offscreen document will (`rebuild.js`).
//
//     node --test extensions/filters/test/capture.e2e.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { capturePage } from "../src/capture/walk.js";

// the server's root: the fixtures, and the modules the rebuild imports
const root = fileURLToPath(new URL("..", import.meta.url));
const TYPES = { ".html": "text/html", ".js": "text/javascript" };

/** How many elements match each selector in `scope` and every open shadow
 *  root under it, nested ones too. Runs in the page, sent as source.
 *  @param {Document | DocumentFragment} scope @param {string[]} selectors */
function countAll(scope, selectors) {
    /** @type {(Document | DocumentFragment)[]} */
    const roots = [];
    /** @param {Document | DocumentFragment} r */
    const visit = (r) => {
        roots.push(r);
        for (const el of r.querySelectorAll("*")) if (el.shadowRoot) visit(el.shadowRoot);
    };
    visit(scope);
    return selectors.map((s) => roots.reduce((n, r) => n + r.querySelectorAll(s).length, 0));
}

describe("a page's capture", () => {
    /** @type {import("playwright").Browser} */
    let browser;
    /** @type {import("node:http").Server} */
    let server;
    let base = "";
    /** every path the server was asked for */
    /** @type {string[]} */
    const served = [];

    before(async () => {
        server = createServer((req, res) => {
            const path = new URL(req.url ?? "/", "http://x").pathname;
            served.push(path);
            try {
                const file = join(root, path.slice(1));
                if (!file.startsWith(root)) throw new Error("outside");
                res.setHeader("content-type", TYPES[/** @type {keyof TYPES} */ (extname(file))] ?? "application/octet-stream");
                res.end(readFileSync(file));
            } catch {
                res.statusCode = 404;
                res.end();
            }
        });
        await new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(undefined)));
        base = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`;
        browser = await chromium.launch({ channel: "chromium", headless: true });
    });
    after(async () => {
        await browser?.close();
        server?.close();
    });

    /** Capture the fixture `name`, after `prep`, and rebuild it in a page of its own.
     *  @param {string} name @param {{ maxBytes?: number }} [opts]
     *  @param {(page: import("playwright").Page) => Promise<void>} [prep] */
    const captured = async (name, opts = {}, prep) => {
        const live = await browser.newPage({ viewport: { width: 1000, height: 700 } });
        await live.goto(`${base}/test/page/${name}`);
        await prep?.(live);
        /** @type {import("../src/capture/walk.js").Capture} */
        const capture = await live.evaluate(`(${capturePage})(${JSON.stringify(opts)})`);
        const rebuilt = await browser.newPage();
        await rebuilt.goto(`${base}/test/page/blank.html`);
        await rebuilt.evaluate(async (html) => {
            const { rebuildCapture, capturedVisibleText } = await import("/src/capture/rebuild.js");
            const doc = rebuildCapture(html);
            Object.assign(globalThis, { doc, capturedVisibleText });
        }, capture.html);
        /** count `selectors` on both sides @param {string[]} selectors */
        const counts = async (selectors) => ({
            live: await live.evaluate(`(${countAll})(document, ${JSON.stringify(selectors)})`),
            rebuilt: await rebuilt.evaluate(`(${countAll})(globalThis.doc, ${JSON.stringify(selectors)})`),
        });
        /** an expression's value in the rebuilt page, `doc` its document @param {string} expr */
        const inRebuilt = (expr) => rebuilt.evaluate(expr);
        return { capture, live, rebuilt, counts, inRebuilt };
    };

    it("writes every open shadow root, nested ones too, and its slots work once rebuilt", async () => {
        const { capture, counts, inRebuilt } = await captured("shadow.html");
        assert.equal((capture.html.match(/<template shadowrootmode="open">/g) ?? []).length, 1 + 2 + 2);
        assert.ok(await inRebuilt(`doc.querySelector("feed-app").shadowRoot !== null`));
        // three deep: the app's root, a post's, its badge's
        assert.equal(await inRebuilt(`doc.querySelector("feed-post[sponsored]").shadowRoot.querySelector("post-badge").shadowRoot.querySelector(".badge").textContent`), "Sponsored");
        const selectors = ["article.post", ".badge", "slot", "slot[name]", "span[slot=author]", "feed-post[sponsored]", "p", "em", "header", "main.feed", ".byline > slot", "article:has(.byline)", ".secret", "style"];
        const { live, rebuilt } = await counts(selectors);
        const want = live.map((n, i) => (selectors[i] === "style" ? 0 : n));
        assert.deepEqual(rebuilt, want, "each selector matches as often as on the live page, the root's style left out");
        assert.deepEqual(
            await inRebuilt(`[...doc.querySelector("feed-app").shadowRoot.querySelectorAll("slot")].map((s) => s.assignedElements().length)`),
            [1, 3, 0],
            "the title slot takes the heading, the default slot the posts and the closed host, the missing one nothing",
        );
    });

    it("leaves a closed shadow root out, and keeps its host's light DOM", async () => {
        const { capture } = await captured("shadow.html");
        assert.doesNotMatch(capture.html, /Closed content/);
        assert.match(capture.html, /<secret-box[^>]*><p class="light"[^>]*>Light of a closed host<\/p><\/secret-box>/);
    });

    it("gives the text a person sees, slots and fallbacks as drawn", async () => {
        const { live, inRebuilt } = await captured("shadow.html");
        const text = /** @type {string} */ (await inRebuilt(`capturedVisibleText(doc.body)`));
        for (const shown of ["Your feed", "Ana", "First post body", "Shop", "Buy now", "Fallback shown", "Light of a closed host"]) assert.match(text, new RegExp(shown));
        assert.equal(text.match(/Sponsored/g)?.length, 1, "the badge the page hides isn't read");
        assert.doesNotMatch(text, /Untitled/, "a slot's fallback isn't read when the slot takes something");
        const words = (/** @type {string} */ s) => s.split(/\s+/).filter(Boolean).sort();
        // the live page's `innerText` reads slotted light DOM but no shadow tree's own text (the
        // badge, the fallback), which a person sees and the capture reads
        const liveText = await live.evaluate(() => document.body.innerText);
        assert.doesNotMatch(liveText, /Sponsored|Fallback|Closed content/);
        assert.deepEqual(words(text), words(`${liveText} Sponsored Fallback shown`));
    });

    it("marks what isn't rendered, and boxes what is, in page coordinates", async () => {
        const { capture, live, inRebuilt } = await captured("hidden.html", {}, async (p) => {
            await p.evaluate(() => scrollTo(0, 150));
        });
        assert.deepEqual(capture.viewport, { width: 1000, height: 700, scrollX: 0, scrollY: 150 });
        /** @param {string} id */
        const marks = (id) => inRebuilt(`(() => { const e = doc.getElementById(${JSON.stringify(id)}); return { box: e.getAttribute("data-agex-box"), hidden: e.hasAttribute("data-agex-hidden"), cut: e.getAttribute("data-agex-cut") }; })()`);
        for (const id of ["none", "invisible", "inside-invisible", "zero"]) assert.equal((await marks(id)).hidden, true, `${id} is hidden`);
        for (const id of ["title", "peek", "peeking", "zero-open", "escaped", "forged", "frame", "icon"]) {
            const m = await marks(id);
            assert.equal(m.hidden, false, `${id} isn't hidden`);
            assert.match(m.box ?? "", /^-?\d+ -?\d+ \d+ \d+$/, `${id} has a box`);
        }
        // a box is where the live page drew it, plus the scroll
        const rect = await live.evaluate(() => {
            const r = /** @type {Element} */ (document.getElementById("title")).getBoundingClientRect();
            return [r.left, r.top + scrollY, r.width, r.height].map(Math.round).join(" ");
        });
        assert.equal((await marks("title")).box, rect);
        assert.match((await marks("escaped")).box ?? "", /^10 300 \d+ \d+$/);
        assert.match((await marks("zero-open")).box ?? "", / 0$/, "zero height, its child drawn below it");
        // the page's own annotations are gone: ours say it shows
        assert.equal((await marks("forged")).cut, null);
        // `display: contents` draws no box, and isn't hidden: its children carry their own marks
        assert.deepEqual(await marks("contents"), { box: null, hidden: false, cut: null });
        const text = /** @type {string} */ (await inRebuilt(`capturedVisibleText(doc.body)`));
        for (const shown of ["Shown", "Peeking", "Escaped", "Forged but shown"]) assert.match(text, new RegExp(shown));
        for (const gone of ["Gone", "Unseen", "Clipped", "Nothing shown"]) assert.doesNotMatch(text, new RegExp(gone));
    });

    it("marks what layout drew as a block, so its text reads as a line of its own", async () => {
        const { live, inRebuilt } = await captured("hidden.html");
        const block = (/** @type {string} */ id) => inRebuilt(`doc.getElementById(${JSON.stringify(id)}).hasAttribute("data-agex-block")`);
        assert.equal(await block("title"), true);
        assert.equal(await block("flex-a"), true, "a flex item is drawn as a block");
        assert.equal(await block("escaped"), true, "so is a box positioned out of the flow");
        assert.equal(await block("btn"), false);
        const text = /** @type {string} */ (await inRebuilt(`capturedVisibleText(doc.getElementById("flex"))`));
        assert.equal(text, "Sponsored\nToday");
        assert.equal(await live.evaluate(() => /** @type {HTMLElement} */ (document.getElementById("flex")).innerText), text);
    });

    it("leaves out the page's code and styling, and keeps a frame as an element", async () => {
        const { capture, inRebuilt } = await captured("hidden.html");
        assert.doesNotMatch(capture.html, /<script|<style|<noscript|<template|<!--|stylesheet|onclick|Noscript text|Template text|AAAAAAAA/);
        assert.match(capture.html, /<link rel="icon" href="data:,"/);
        assert.match(capture.html, /<iframe id="frame" src="frame.html" width="200" height="100" data-agex-box="[^"]+"><\/iframe>/);
        assert.doesNotMatch(capture.html, /Inside the frame/);
        assert.equal(await inRebuilt(`doc.getElementById("pixel").getAttribute("src")`), "data:image/png;base64,");
        assert.equal(await inRebuilt(`doc.querySelector("#icon linearGradient")?.localName`), "linearGradient", "SVG names keep their case");
    });

    it("escapes text and attribute values so they read back as they were", async () => {
        const { live, inRebuilt } = await captured("hidden.html");
        const read = `(() => { const d = typeof doc === "undefined" ? document : doc; return {
            title: d.getElementById("quotes").title, text: d.getElementById("quotes").textContent,
            pre: d.getElementById("pre").textContent, notes: d.getElementById("notes").value, page: d.title }; })()`;
        assert.deepEqual(await inRebuilt(read), await live.evaluate(read));
    });

    it("cuts the latest of a long feed first, keeping the page around it, and says how much", async () => {
        const maxBytes = 60_000;
        const { capture, inRebuilt } = await captured("long.html", { maxBytes });
        assert.ok(capture.cut && capture.cut > 100_000, `cut ${capture.cut}`);
        assert.ok(capture.bytes <= maxBytes, `${capture.bytes} bytes`);
        assert.equal(capture.bytes, Buffer.byteLength(capture.html));
        const kept = /** @type {number} */ (await inRebuilt(`doc.querySelectorAll("#feed > li").length`));
        assert.ok(kept >= 5 && kept < 2000, `${kept} posts kept`);
        assert.equal(await inRebuilt(`doc.getElementById("feed").getAttribute("data-agex-cut")`), String(2000 - kept));
        assert.equal(await inRebuilt(`doc.querySelector("#feed > li h2").textContent`), "Post 0", "the head of the feed stays");
        assert.ok(await inRebuilt(`!!doc.querySelector("#top nav a") && doc.getElementById("bottom").textContent === "The end"`));
    });

    it("reports no cut for a page within its size", async () => {
        const { capture } = await captured("long.html");
        assert.equal(capture.cut, undefined);
        assert.equal(capture.title, "Long feed");
        assert.equal(capture.host, "127.0.0.1");
        assert.ok(capture.url.endsWith("/test/page/long.html"));
    });

    it("rebuilds without running or fetching anything", async () => {
        const { rebuilt } = await captured("hidden.html");
        const before = served.length;
        const html = `<!DOCTYPE html><img src="/fetched.png"><iframe src="/framed.html"></iframe><script>globalThis.ran = true</script>`;
        const ran = await rebuilt.evaluate(async (h) => {
            const { rebuildCapture } = await import("/src/capture/rebuild.js");
            rebuildCapture(h);
            await new Promise((ok) => setTimeout(ok, 300));
            return "ran" in globalThis;
        }, html);
        assert.equal(ran, false);
        assert.deepEqual(served.slice(before), []);
    });
});
