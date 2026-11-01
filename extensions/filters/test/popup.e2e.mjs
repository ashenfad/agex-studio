// The person's say, through the popup: a filter the agent presented, its
// notice, previewed on the page, accepted (the ad hidden), turned off and
// on, and the site forgotten; and a rejection's reason, a turn of its own.
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
const FILTER = { version: 1, hide: [{ selector: "span.label", hasText: "^Sponsored$", upward: "article", why: "a sponsored listing" }] };
/** A turn that writes the filter and presents it. */
const presents = [
    step("", [{ name: "run_ts", args: { code: `await fs.write('filters/${TEST_SITE}.json', ${JSON.stringify(JSON.stringify(FILTER))})` } }]),
    step("", [{ name: "present_filter", args: {} }]),
    step("Hides the sponsored listing."),
];

describe("the popup", () => {
    /** @type {Awaited<ReturnType<typeof launch>>} */
    let browser;
    /** @type {import("node:http").Server} */
    let server;
    /** @type {import("playwright").Page} */
    let ext;
    /** @type {import("playwright").Page} */
    let shop;
    /** @type {import("playwright").Page} */
    let popup;
    /** @type {number} */
    let tabId;
    const op = async (name, args = {}) => {
        const reply = await ext.evaluate((msg) => chrome.runtime.sendMessage(msg), { op: name, ...args });
        if (reply?.error !== undefined) throw new Error(reply.error);
        return reply?.value;
    };
    const settled = async () => {
        const until = Date.now() + 30_000;
        while ((await op("status", { site: TEST_SITE }))?.state === "working" && Date.now() < until) await new Promise((ok) => setTimeout(ok, 200));
        return op("status", { site: TEST_SITE });
    };
    /** How the sponsored listing shows on the shop's page now. */
    const ad = () => shop.evaluate(() => getComputedStyle(/** @type {Element} */ (document.querySelector("article.card"))).display);
    const outline = () => shop.evaluate(() => /** @type {Element} */ (document.querySelector("article.card")).getAttribute("data-agex-filtered"));

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
        shop = await browser.context.newPage();
        await shop.goto(`http://shop.${TEST_SITE}:${port}/shop.html`);
        await shop.bringToFront();
        tabId = await ext.evaluate(async () => (await chrome.tabs.query({ url: "*://shop.filters.test/*" }))[0].id);
    });
    after(async () => {
        await browser?.close();
        server?.close();
    });

    it("tells the person when the agent has presented a filter, and offers it", async () => {
        await op("submit", { tabId, steps: presents });
        assert.equal((await settled())?.state, "done");
        const notices = await browser.worker.evaluate(() => chrome.notifications.getAll());
        assert.deepEqual(Object.keys(notices), [`candidate:${TEST_SITE}`]);
        popup = await browser.context.newPage();
        await popup.goto(`chrome-extension://${browser.id}/popup.html?tab=${tabId}`);
        await popup.getByText("A filter is ready: it hides 1 thing").waitFor();
    });

    it("previews it on the page, outlined, and accepts it: the ad is hidden", async () => {
        await popup.getByRole("button", { name: "Preview" }).click();
        await popup.getByRole("button", { name: "End preview" }).waitFor();
        assert.equal(await outline(), "outline");
        assert.equal(await ad(), "block");
        await popup.getByRole("button", { name: "Accept" }).click();
        await popup.getByText("1 hidden on this page.").waitFor();
        assert.equal(await ad(), "none");
        assert.equal(await op("candidate", { site: TEST_SITE }), null);
        assert.deepEqual(Object.keys(await browser.worker.evaluate(() => chrome.notifications.getAll())), []);
    });

    it("turns the site's filter off and on, in the open tab", async () => {
        await popup.getByLabel("Filter this site").uncheck();
        await popup.getByText("Off for this site.").waitFor();
        assert.equal(await ad(), "block");
        await popup.getByLabel("Filter this site").check();
        await popup.getByText("1 hidden on this page.").waitFor();
        assert.equal(await ad(), "none");
    });

    it("hands the agent the person's reason when they turn a filter down", async () => {
        await op("submit", { tabId, steps: presents });
        await settled();
        await popup.reload();
        await popup.getByText("A filter is ready").waitFor();
        const runs = await op("runs", { site: TEST_SITE });
        // the reason's turn: a scripted reply, through the dev op the popup's Reject also reaches
        await op("reject", { site: TEST_SITE, reason: "it hid a real listing", steps: [step("Narrowed it.")] });
        const status = await settled();
        assert.equal(status?.state, "done");
        assert.equal(status.text, "Narrowed it.");
        assert.equal(await op("runs", { site: TEST_SITE }), runs + 1);
        assert.equal(await op("candidate", { site: TEST_SITE }), null);
    });

    it("forgets the site: its filter, its session and its pages", async () => {
        await popup.reload();
        await popup.getByRole("link", { name: "Forget this site" }).click();
        await popup.getByRole("button", { name: "Filter this site" }).waitFor();
        assert.equal(await ad(), "block");
        assert.deepEqual((await op("filterState", { site: TEST_SITE })).sites, {});
        assert.equal((await op("sites")).includes(TEST_SITE), false);
    });
});
