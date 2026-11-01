// An accepted filter applied to a site's pages, in the dev build: hidden on
// the site and its subdomains and not a sibling's, its block rule keeping a
// request from leaving, on/off, the pause and removal followed by an open
// tab with no reload, and a preview outlining a candidate and ending.
//
//     node --test extensions/filters/test/apply.e2e.mjs

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "../build.mjs";
import { TEST_SITE, launch } from "./harness.mjs";

const PAGES = join(dirname(fileURLToPath(import.meta.url)), "page");

/** The site the filter is for; its subdomain; a sibling that only shares its parent. */
const SITE = `shop.${TEST_SITE}`;
const SUB = `m.${SITE}`;
const SIBLING = `notshop.${TEST_SITE}`;

const FILTER = {
    version: 1,
    hide: [
        { selector: ".promo", why: "promoted items" },
        { selector: "span.tag", hasText: "^Ad$", upward: ".item", why: "items labelled Ad" },
    ],
    block: [{ urlFilter: `||ads.${TEST_SITE}^`, types: ["script"], why: "the ad network's script" }],
};

const until = async (/** @type {() => Promise<boolean>} */ ok, what = "the condition", ms = 5000) => {
    const end = Date.now() + ms;
    for (;;) {
        if (await ok()) return;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 50));
    }
};

describe("an accepted filter on its site's pages", () => {
    /** @type {Awaited<ReturnType<typeof launch>>} */
    let browser;
    /** @type {import("node:http").Server} */
    let server;
    let port = 0;
    /** Each request the server had: its host (no port) and path. @type {string[]} */
    let log = [];
    /** @type {import("playwright").Page} */
    let ext;

    before(async () => {
        server = createServer((req, res) => {
            const path = new URL(req.url ?? "/", "http://x").pathname;
            log.push(`${(req.headers.host ?? "").replace(/:\d+$/, "")}${path}`);
            res.setHeader("cache-control", "no-store");
            if (path === "/ad.js") {
                res.setHeader("content-type", "text/javascript");
                res.end("window.adLoaded = true;");
                return;
            }
            const file = join(PAGES, path);
            if (!file.startsWith(PAGES) || !existsSync(file)) {
                res.statusCode = 404;
                res.end();
                return;
            }
            res.setHeader("content-type", "text/html");
            res.end(readFileSync(file));
        });
        await new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(undefined)));
        port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
        browser = await launch(await build("dev"));
        ext = await browser.context.newPage();
        await ext.goto(`chrome-extension://${browser.id}/manifest.json`);
    });
    after(async () => {
        await browser?.close();
        server?.close();
    });

    /** An op of the worker's, as the extension's pages ask it: its value, or its error thrown.
     *  @param {Record<string, unknown>} msg */
    const op = async (msg) => {
        const r = await ext.evaluate((m) => chrome.runtime.sendMessage(m), msg);
        if (r?.error !== undefined) throw new Error(r.error);
        return r?.value;
    };
    /** The ids of the browser's tabs. @returns {Promise<number[]>} */
    const tabIds = () => browser.worker.evaluate(async () => (await chrome.tabs.query({})).flatMap((t) => (t.id === undefined ? [] : [t.id])));
    /** A new tab on `host`'s shop page, loaded, and its tab id. @param {string} host */
    const open = async (host) => {
        const had = new Set(await tabIds());
        const page = await browser.context.newPage();
        const tabId = (await tabIds()).find((id) => !had.has(id));
        assert.ok(tabId !== undefined);
        await page.goto(`http://${host}:${port}/items.html`);
        return { page, tabId };
    };
    /** The ids of the items `page` doesn't show. @param {import("playwright").Page} page */
    const hidden = (page) => page.evaluate(() =>
        [...document.querySelectorAll(".item")].filter((el) => getComputedStyle(el).display === "none").map((el) => el.id));
    /** Wait for `page` to hide just `ids`. @param {import("playwright").Page} page @param {string[]} ids */
    const hides = (page, ids) => until(async () => JSON.stringify(await hidden(page)) === JSON.stringify(ids), `${page.url()} to hide [${ids}]`);
    const rules = () => browser.worker.evaluate(() => chrome.declarativeNetRequest.getDynamicRules());
    const scripts = () => browser.worker.evaluate(() => chrome.scripting.getRegisteredContentScripts());

    /** @type {{ page: import("playwright").Page, tabId: number }} */
    let early;

    it("before any accept, the page shows all and its ad script arrives", async () => {
        log = [];
        early = await open(SITE);
        assert.deepEqual(await hidden(early.page), []);
        assert.ok(log.includes(`ads.${TEST_SITE}/ad.js`));
        assert.equal(await op({ op: "filterCount", tabId: early.tabId }), 0);
    });

    it("refuses a filter for a site it has no permission for, and one that fails its checks", async () => {
        await assert.rejects(op({ op: "filterAccept", site: "example.com", filter: { version: 1, hide: [{ selector: ".promo" }] } }), /no permission to run on example.com/);
        await assert.rejects(op({ op: "filterAccept", site: SITE, filter: { ...FILTER, block: [{ urlFilter: `||${SITE}^` }] } }), /block\[0\]\.urlFilter/);
        assert.deepEqual(await op({ op: "filterState" }), { paused: false, sites: {} });
    });

    it("accepts: an open tab of the site follows at once, and a new load is filtered", async () => {
        const state = await op({ op: "filterAccept", site: SITE, filter: FILTER });
        assert.deepEqual(state.sites[SITE].rules, [1]);
        assert.equal(state.sites[SITE].version, 1);
        assert.equal(state.sites[SITE].on, true);
        await hides(early.page, ["ad1", "ad2"]);
        assert.equal(await op({ op: "filterCount", tabId: early.tabId }), 2);

        const [script] = await scripts();
        assert.equal(script.id, `filters:${SITE}`);
        assert.equal(script.runAt, "document_start");
        assert.deepEqual((await rules()).map((r) => r.id), [1]);

        log = [];
        const { page, tabId } = await open(SITE);
        await hides(page, ["ad1", "ad2"]);
        assert.equal(await op({ op: "filterCount", tabId }), 2);
        // the block rule kept the ad script's request from leaving the browser
        assert.ok(log.includes(`${SITE}/items.html`));
        assert.ok(!log.some((l) => l.startsWith(`ads.${TEST_SITE}/`)), `requests: ${log}`);
        assert.equal(await page.evaluate(() => /** @type {any} */ (window).adLoaded), undefined);
        await page.close();
    });

    it("filters a subdomain of the site, and not a sibling of it", async () => {
        const sub = await open(SUB);
        await hides(sub.page, ["ad1", "ad2"]);
        assert.equal(await op({ op: "filterCount", tabId: sub.tabId }), 2);
        await sub.page.close();

        log = [];
        const sibling = await open(SIBLING);
        await new Promise((r) => setTimeout(r, 300));
        assert.deepEqual(await hidden(sibling.page), []);
        assert.equal(await op({ op: "filterCount", tabId: sibling.tabId }), 0);
        // the block rule is the site's own pages' too: a sibling's request goes out
        assert.ok(log.includes(`ads.${TEST_SITE}/ad.js`));
        await sibling.page.close();
    });

    it("follows off and on, and the pause, in an open tab with no reload", async () => {
        let state = await op({ op: "filterSetOn", site: SITE, on: false });
        assert.equal(state.sites[SITE].on, false);
        await hides(early.page, []);
        assert.deepEqual(await rules(), []);
        assert.equal(await op({ op: "filterCount", tabId: early.tabId }), 0);

        await op({ op: "filterSetOn", site: SITE, on: true });
        await hides(early.page, ["ad1", "ad2"]);
        assert.deepEqual((await rules()).map((r) => r.id), [1]);

        state = await op({ op: "filterPause", paused: true });
        assert.equal(state.paused, true);
        await hides(early.page, []);
        assert.deepEqual(await rules(), []);

        log = [];
        const paused = await open(SITE);
        await new Promise((r) => setTimeout(r, 300));
        assert.deepEqual(await hidden(paused.page), []);
        assert.ok(log.includes(`ads.${TEST_SITE}/ad.js`));
        await paused.page.close();

        await op({ op: "filterPause", paused: false });
        await hides(early.page, ["ad1", "ad2"]);
        assert.deepEqual((await rules()).map((r) => r.id), [1]);
        assert.deepEqual(Object.keys((await op({ op: "filterState", site: SITE })).sites), [SITE]);
    });

    it("removes: the open tab shows all again, and nothing is left registered", async () => {
        const state = await op({ op: "filterRemove", site: SITE });
        assert.deepEqual(state, { paused: false, sites: {} });
        await hides(early.page, []);
        assert.equal(await op({ op: "filterCount", tabId: early.tabId }), 0);
        assert.deepEqual(await rules(), []);
        assert.deepEqual(await scripts(), []);

        log = [];
        const { page } = await open(SITE);
        await new Promise((r) => setTimeout(r, 300));
        assert.deepEqual(await hidden(page), []);
        assert.ok(log.includes(`ads.${TEST_SITE}/ad.js`));
        await page.close();
    });

    it("previews a candidate outlined, not hidden, and ends it cleanly", async () => {
        const { page, tabId } = await open(SITE);
        const outlined = () => page.evaluate(() => [...document.querySelectorAll("[data-agex-filtered]")].map((el) => `${el.id}:${el.getAttribute("data-agex-filtered")}`));

        assert.equal(await op({ op: "filterPreview", tabId, site: SITE, filter: FILTER }), 2);
        assert.deepEqual(await outlined(), ["ad1:outline", "ad2:outline"]);
        assert.deepEqual(await hidden(page), []);
        assert.equal(await op({ op: "filterCount", tabId }), 2);
        // a preview is of the site's own pages only, and of a filter that passes its checks
        await assert.rejects(op({ op: "filterPreview", tabId, site: `other.${TEST_SITE}`, filter: FILTER }), /isn't one of other\./);
        await assert.rejects(op({ op: "filterPreview", tabId, site: SITE, filter: { version: 1, hide: [{ selector: "body" }] } }), /hide\[0\]\.selector/);
        // nothing was stored, nothing is blocked
        assert.deepEqual(await op({ op: "filterState" }), { paused: false, sites: {} });
        assert.deepEqual(await rules(), []);

        assert.equal(await op({ op: "filterPreviewEnd", tabId }), 0);
        assert.deepEqual(await outlined(), []);
        assert.equal(await page.evaluate(() => document.querySelectorAll("[data-agex-filter-style]").length), 0);
        await page.close();
    });

    it("can't preview on a tab it has neither the site's permission nor the person's click for", async () => {
        // the dev build's hosts are the test sites': this one is none of them
        const had = new Set(await tabIds());
        const page = await browser.context.newPage();
        const tabId = (await tabIds()).find((id) => !had.has(id));
        await page.goto(`http://127.0.0.1:${port}/items.html`);
        await assert.rejects(op({ op: "filterPreview", tabId, site: "example.com", filter: FILTER }), /can't reach tab/);
        await page.close();
    });
});
