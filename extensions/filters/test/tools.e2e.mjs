// The agent's tools on a site's saved pages, in a scripted turn: `site`
// finds where text shows and tries a filter, and `present_filter`
// refuses a filter that hides the page and presents one that hides its
// ad, which the service worker keeps as the site's candidate (where the
// person kept the site from the extension).
//
//     pnpm filters:test

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "../build.mjs";
import { TEST_SITE, launch } from "./harness.mjs";

const PAGES = join(dirname(fileURLToPath(import.meta.url)), "page");
const step = (text, calls = []) => ({ kind: "model", text, thinking: "", tool_calls: calls, fail: "", input_tokens: 0 });
const runTs = (code) => ({ name: "run_ts", args: { code } });
const present = { name: "present_filter", args: {} };
/** Code writing the site's filter file. @param {unknown} filter */
const writeFilter = (filter) => `await fs.write('filters/${TEST_SITE}.json', ${JSON.stringify(JSON.stringify(filter))})`;

describe("the agent's tools", () => {
    /** @type {Awaited<ReturnType<typeof launch>>} */
    let browser;
    /** @type {import("node:http").Server} */
    let server;
    /** @type {import("playwright").Page} */
    let ext;
    const op = async (name, args = {}) => {
        const reply = await ext.evaluate((msg) => chrome.runtime.sendMessage(msg), { op: name, ...args });
        if (reply?.error !== undefined) throw new Error(reply.error);
        return reply?.value;
    };
    before(async () => {
        server = createServer((req, res) => {
            res.setHeader("content-type", "text/html");
            res.end(readFileSync(join(PAGES, "shop.html")));
        });
        await new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(undefined)));
        const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
        browser = await launch(await build("dev"));
        ext = await browser.context.newPage();
        await ext.goto(`chrome-extension://${browser.id}/manifest.json`);
        // as without the site's permission: what the agent presents waits as its candidate
        await op("withhold", { on: true });
        const shop = await browser.context.newPage();
        await shop.goto(`http://shop.${TEST_SITE}:${port}/shop.html`);
        await shop.bringToFront();
        const tabId = await ext.evaluate(async () => (await chrome.tabs.query({ url: "*://shop.filters.test/*" }))[0].id);
        // the page saved; its turn says nothing
        await op("submit", { tabId, steps: [step("Saved.")] });
        const until = Date.now() + 30_000;
        while ((await op("status", { site: TEST_SITE }))?.state === "working" && Date.now() < until) await new Promise((ok) => setTimeout(ok, 200));
    });
    after(async () => {
        await browser?.close();
        server?.close();
    });

    it("finds where text shows, what holds it, and what a filter would hide", async () => {
        const good = { version: 1, hide: [{ selector: "span.label", hasText: "^Sponsored$", upward: "article", why: "a sponsored listing" }] };
        const out = await op("scripted", {
            site: TEST_SITE,
            prompt: "look",
            steps: [
                step("", [runTs("console.log(JSON.stringify(await site.find('Sponsored')))")]),
                step("", [runTs(`${writeFilter(good)}\nconsole.log(JSON.stringify(await site.try(${JSON.stringify(good)})))`)]),
                step("Looked."),
            ],
        });
        assert.equal(out.status, "completed");
        const [found, tried] = out.tools.map((t) => JSON.parse(t.result.trim()));
        assert.equal(found[0].page, "pages/1");
        assert.equal(found[0].found, 1);
        assert.match(found[0].samples[0].element, /^span\.label/);
        assert.match(found[0].samples[0].holders[0], /^article\.card/);
        assert.equal(tried.ok, true);
        assert.equal(tried.pages[0].hidden, 1);
        assert.ok(tried.pages[0].hiddenShare > 0 && tried.pages[0].hiddenShare < 0.5, String(tried.pages[0].hiddenShare));
    });

    it("finds text in a component's shadow root once: the label, not its host too", async () => {
        const out = await op("scripted", {
            site: TEST_SITE,
            prompt: "look inside",
            steps: [step("", [runTs("console.log(JSON.stringify(await site.find('^Featured$')))")]), step("Looked.")],
        });
        const [found] = JSON.parse(out.tools[0].result.trim());
        assert.equal(found.found, 1);
        assert.match(found.samples[0].element, /^\(in x-open's shadow root\) span\.badge/);
    });

    it("refuses to present a filter that hides the page, or only what was hidden already, and presents one that hides its ad", async () => {
        const greedy = { version: 1, hide: [{ selector: "article" }, { selector: "x-closed" }, { selector: "x-open" }] };
        const unseen = { version: 1, hide: [{ selector: "span.promo-label", upward: "article" }] };
        const good = { version: 1, hide: [{ selector: "span.label", hasText: "^Sponsored$", upward: "article", why: "a sponsored listing" }] };
        const out = await op("scripted", {
            site: TEST_SITE,
            prompt: "present",
            steps: [
                step("", [runTs(writeFilter(greedy))]),
                step("", [present]),
                step("", [runTs(writeFilter(unseen))]),
                step("", [present]),
                step("", [runTs(writeFilter(good))]),
                step("", [present]),
                step("Hides the sponsored listing."),
            ],
        });
        const presents = out.tools.filter((t) => t.name === "present_filter");
        assert.equal(presents[0].isError, true);
        assert.match(presents[0].result, /hiding the page, not its clutter/);
        assert.equal(presents[1].isError, true);
        assert.match(presents[1].result, /hides nothing that shows/);
        assert.equal(presents[2].isError, false, presents[2].result);
        const candidate = await op("candidate", { site: TEST_SITE });
        assert.equal(candidate.site, TEST_SITE);
        assert.deepEqual(candidate.filter.hide.map((r) => r.selector), ["span.label"]);
        assert.deepEqual(candidate.pages.map((p) => [p.page, p.hidden]), [["pages/1", 1]]);
    });
});
