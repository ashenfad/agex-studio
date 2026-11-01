// Hard to miss what the agent is doing: the toolbar icon's dot on a
// site's tabs (working, a filter ready, a turn that stopped or found
// nothing), a notice for every ending, and the popup saying how the last
// turn ended; and an accepted filter changed, in the person's words or
// with another page.
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
const presents = [
    step("", [{ name: "run_ts", args: { code: `await fs.write('filters/${TEST_SITE}.json', ${JSON.stringify(JSON.stringify(FILTER))})` } }]),
    step("", [{ name: "present_filter", args: {} }]),
    step("Hides the sponsored listing."),
];

describe("what the agent is doing, at a glance", () => {
    /** @type {Awaited<ReturnType<typeof launch>>} */
    let browser;
    /** @type {import("node:http").Server} */
    let server;
    /** @type {import("playwright").Page} */
    let ext;
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
    /** `click`, then the end of the turn it started: one newer than the status before it. @param {() => Promise<void>} click */
    const turnOf = async (click) => {
        const before = (await op("status", { site: TEST_SITE }))?.at ?? 0;
        await click();
        const until = Date.now() + 30_000;
        for (;;) {
            const now = await op("status", { site: TEST_SITE });
            if ((now?.at ?? 0) > before && now?.state !== "working") return now;
            if (Date.now() > until) return now;
            await new Promise((ok) => setTimeout(ok, 200));
        }
    };
    const notices = async () => Object.keys(await browser.worker.evaluate(() => chrome.notifications.getAll())).sort();
    /** The popup, on the shop's tab. */
    const popup = async () => {
        const page = await browser.context.newPage();
        await page.goto(`chrome-extension://${browser.id}/popup.html?tab=${tabId}`);
        return page;
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
        const shop = await browser.context.newPage();
        await shop.goto(`http://shop.${TEST_SITE}:${port}/shop.html`);
        tabId = await ext.evaluate(async () => (await chrome.tabs.query({ url: "*://shop.filters.test/*" }))[0].id);
    });
    after(async () => {
        await browser?.close();
        server?.close();
    });

    it("dots the site's tabs while the agent works, then green while its filter waits", async () => {
        assert.equal(await op("dot", { site: TEST_SITE }), null);
        const slow = [step("", [{ name: "run_ts", args: { code: "await new Promise((ok) => setTimeout(ok, 1000))" } }]), ...presents];
        await op("submit", { tabId, steps: slow });
        assert.equal(await op("dot", { site: TEST_SITE }), "working");
        await settled();
        assert.equal(await op("dot", { site: TEST_SITE }), "ready");
        assert.deepEqual(await notices(), [`candidate:${TEST_SITE}`]);
    });

    it("takes the dot away once the filter is accepted, and never says its turn ended without one", async () => {
        await op("accept", { site: TEST_SITE });
        assert.equal(await op("dot", { site: TEST_SITE }), null);
        assert.deepEqual(await notices(), []);
        const page = await popup();
        await page.getByText("1 hidden on this page.").waitFor();
        assert.equal(await page.getByText("finished without a filter").count(), 0);
        await page.close();
    });

    it("asks for changes to an accepted filter, in the person's words, with the page", async () => {
        const page = await popup();
        await page.getByText("1 hidden on this page.").waitFor();
        await op("scriptNext", { steps: presents });
        await page.getByPlaceholder("What should change?").fill("also hide the free shipping line");
        assert.equal((await turnOf(() => page.getByRole("button", { name: "Ask for changes" }).click()))?.state, "done");
        // a new version to preview; the accepted one keeps working meanwhile
        assert.notEqual(await op("candidate", { site: TEST_SITE }), null);
        assert.equal((await op("filterState", { site: TEST_SITE })).sites[TEST_SITE].on, true);
        assert.equal(await op("runs", { site: TEST_SITE }), 2);
        await op("reject", { site: TEST_SITE });
        await page.close();
    });

    it("extends an accepted filter with the page in front", async () => {
        const page = await popup();
        await op("scriptNext", { steps: [step("Nothing more to hide here.")] });
        assert.equal((await turnOf(() => page.getByRole("button", { name: "Extend with this page" }).click()))?.state, "done");
        assert.equal(await op("runs", { site: TEST_SITE }), 3);
        await page.close();
    });

    it("says when a turn ends without a filter: a notice, an amber dot, and its words in the popup", async () => {
        // the extend just above ended that way
        assert.deepEqual(await notices(), [`ended:${TEST_SITE}`]);
        assert.equal(await op("dot", { site: TEST_SITE }), "stopped");
        const page = await popup();
        await page.getByText("Its agent finished without a filter: “Nothing more to hide here.”").waitFor();
        // shown: the dot goes
        const until = Date.now() + 5_000;
        while ((await op("dot", { site: TEST_SITE })) !== null && Date.now() < until) await new Promise((ok) => setTimeout(ok, 100));
        assert.equal(await op("dot", { site: TEST_SITE }), null);
        await page.close();
    });
});
