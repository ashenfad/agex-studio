// Submitting a page: the popup's view of the tab in front, the page
// captured as the person sees it (a closed shadow root too) and saved as
// one of its site's pages, and a turn of the site's session on it, whose
// end the service worker hears.
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

describe("submitting a page", () => {
    /** @type {Awaited<ReturnType<typeof launch>>} */
    let browser;
    /** @type {import("node:http").Server} */
    let server;
    /** @type {import("playwright").Page} */
    let ext;
    /** @type {number} */
    let tabId;
    /** @type {number} */
    let port;
    /** An op of the worker's, from a page of the extension's. */
    const op = async (name, args = {}) => {
        const reply = await ext.evaluate((msg) => chrome.runtime.sendMessage(msg), { op: name, ...args });
        if (reply?.error !== undefined) throw new Error(reply.error);
        return reply?.value;
    };
    before(async () => {
        server = createServer((req, res) => {
            res.setHeader("content-type", "text/html");
            res.end(readFileSync(join(PAGES, req.url?.startsWith("/login") ? "login.html" : "shop.html")));
        });
        await new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(undefined)));
        port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
        browser = await launch(await build("dev"));
        ext = await browser.context.newPage();
        await ext.goto(`chrome-extension://${browser.id}/manifest.json`);
        const shop = await browser.context.newPage();
        await shop.goto(`http://shop.${TEST_SITE}:${port}/shop.html`);
        await shop.bringToFront();
        tabId = await ext.evaluate(async () => (await chrome.tabs.query({ url: "*://shop.filters.test/*" }))[0].id);
    });
    after(async () => {
        await browser?.close();
        server?.close();
    });

    it("shows the tab's site, its registrable domain", async () => {
        const page = await op("page", { tabId });
        assert.equal(page.site, TEST_SITE);
        assert.equal(page.password, false);
        assert.equal(page.status, null);
    });

    it("warns more strongly of a page with a password field, a component's closed one too", async () => {
        const login = await browser.context.newPage();
        await login.goto(`http://login.${TEST_SITE}:${port}/login.html`);
        const loginTab = await ext.evaluate(async () => (await chrome.tabs.query({ url: "*://login.filters.test/*" }))[0].id);
        assert.equal((await op("page", { tabId: loginTab })).password, true);
        await login.close();
    });

    it("saves the page as the site's first, and runs a turn on it to its end", async () => {
        const read = "const page = JSON.parse(await fs.read('pages/1.json'))\nconsole.log(page.title, page.html.includes('Inside a closed root'))";
        const submitted = await op("submit", { tabId, steps: [step("", [{ name: "run_ts", args: { code: read } }]), step("Read it.")] });
        assert.deepEqual(submitted, { site: TEST_SITE, page: "pages/1" });
        const until = Date.now() + 30_000;
        let status = await op("status", { site: TEST_SITE });
        while (status?.state === "working" && Date.now() < until) {
            await new Promise((ok) => setTimeout(ok, 200));
            status = await op("status", { site: TEST_SITE });
        }
        assert.equal(status?.state, "done", JSON.stringify(status));
        assert.equal(status.text, "Read it.");
        const saved = JSON.parse(await op("read", { site: TEST_SITE, path: "pages/1.json" }));
        assert.equal(saved.title, "A shop");
        assert.match(saved.html, /data-agex-box/);
        // reached from the extension's side of the page, as no script of the page's could
        assert.match(saved.html, /Inside a closed root/);
    });
});
