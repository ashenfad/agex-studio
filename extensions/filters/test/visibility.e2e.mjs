// Hard to miss what the agent is doing, and few clicks to a filter: the
// toolbar icon's dot on a site's tabs (working, a filter on, a turn that
// stopped or found nothing), a notice for every ending, the popup's
// spinner while the agent works and how the last turn ended after; a
// presented filter on at once, with an undo; and an accepted filter
// changed, in the person's words or with another page.
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
/** The filter with the free shipping line hidden too. */
const WIDER = { version: 1, hide: [...FILTER.hide, { selector: "p", hasText: "Free shipping$", why: "a shipping banner" }] };
/** A turn that writes `filter` and presents it. */
const presents = (filter = FILTER) => [
    step("", [{ name: "run_ts", args: { code: `await fs.write('filters/${TEST_SITE}.json', ${JSON.stringify(JSON.stringify(filter))})` } }]),
    step("", [{ name: "present_filter", args: {} }]),
    step("Hides the sponsored listing."),
];
/** A turn that first takes a while. */
const slowly = (ms, filter = FILTER) => [step("", [{ name: "run_ts", args: { code: `await new Promise((ok) => setTimeout(ok, ${ms}))` } }]), ...presents(filter)];

describe("what the agent is doing, at a glance", () => {
    /** @type {Awaited<ReturnType<typeof launch>>} */
    let browser;
    /** @type {import("node:http").Server} */
    let server;
    /** @type {import("playwright").Page} */
    let ext;
    /** @type {import("playwright").Page} */
    let shop;
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
    /** How the sponsored listing shows on the shop's page now. */
    const ad = () => shop.evaluate(() => getComputedStyle(/** @type {Element} */ (document.querySelector("article.card"))).display);
    /** Site's stored filter: its version and how many hide rules it has, or null for none. */
    const stored = async () => {
        const entry = (await op("filterState", { site: TEST_SITE })).sites[TEST_SITE];
        return entry === undefined ? null : { version: entry.version, rules: entry.filter.hide.length };
    };
    /** `check` true within a few seconds. @param {() => Promise<boolean>} check */
    const soon = async (check) => {
        const until = Date.now() + 5_000;
        while (!(await check()) && Date.now() < until) await new Promise((ok) => setTimeout(ok, 100));
        return check();
    };
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
        shop = await browser.context.newPage();
        await shop.goto(`http://shop.${TEST_SITE}:${port}/shop.html`);
        tabId = await ext.evaluate(async () => (await chrome.tabs.query({ url: "*://shop.filters.test/*" }))[0].id);
        // the shop's tab not in front: the popup doesn't open over it on its own and look for the person
        await ext.bringToFront();
    });
    after(async () => {
        await browser?.close();
        server?.close();
    });

    it("dots the site's tabs while the agent works; its filter goes on once presented, green until the person looks", async () => {
        assert.equal(await op("dot", { site: TEST_SITE }), null);
        await op("submit", { tabId, steps: slowly(1000) });
        assert.equal(await op("dot", { site: TEST_SITE }), "working");
        await settled();
        // the dev build holds the test sites' permission, as the person gives it from the popup
        assert.deepEqual(await stored(), { version: 1, rules: 1 });
        assert.equal(await ad(), "none");
        assert.equal(await op("candidate", { site: TEST_SITE }), null);
        assert.equal(await op("dot", { site: TEST_SITE }), "ready");
        assert.deepEqual(await notices(), [`applied:${TEST_SITE}`]);
        const page = await popup();
        await page.getByText("The agent's filter is on.").waitFor();
        await page.getByText("1 hidden on this page.").waitFor();
        assert.equal(await page.getByText("finished without a filter").count(), 0);
        // shown: the dot goes
        assert.equal(await soon(async () => (await op("dot", { site: TEST_SITE })) === null), true);
        await page.close();
    });

    it("asks for changes in the person's words: the new version goes on, and Undo goes back to the one before", async () => {
        const page = await popup();
        await page.getByText("1 hidden on this page.").waitFor();
        await op("scriptNext", { steps: presents(WIDER) });
        await page.getByPlaceholder("What should change?").fill("also hide the free shipping line");
        assert.equal((await turnOf(() => page.getByRole("button", { name: "Ask for changes" }).click()))?.state, "done");
        assert.deepEqual(await stored(), { version: 2, rules: 2 });
        assert.equal(await op("runs", { site: TEST_SITE }), 2);
        await page.getByText("The agent's new version is on.").waitFor();
        await page.getByText("2 hidden on this page.").waitFor();
        await page.getByRole("button", { name: "Undo" }).click();
        await page.getByText("1 hidden on this page.").waitFor();
        assert.deepEqual(await stored(), { version: 3, rules: 1 });
        assert.equal(await page.getByText("The agent's new version is on.").isVisible(), false);
        assert.deepEqual(await notices(), []);
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
        assert.equal(await soon(async () => (await op("dot", { site: TEST_SITE })) === null), true);
        await page.close();
    });

    it("filters a site from the popup's one button: a spinner while the agent works, the filter on after, and Undo takes a first one off", async () => {
        await op("forget", { site: TEST_SITE });
        const page = await popup();
        await op("scriptNext", { steps: slowly(1500) });
        await page.getByRole("button", { name: "Filter this site" }).click();
        await page.getByText(`The agent is writing a filter for ${TEST_SITE}…`).waitFor();
        assert.equal(await page.locator(".spinner").isVisible(), true);
        // the popup follows: the filter on, then the turn's end
        await page.getByText("The agent's filter is on.").waitFor({ timeout: 30_000 });
        await page.locator(".spinner").waitFor({ state: "hidden" });
        assert.equal(await ad(), "none");
        await page.getByRole("button", { name: "Undo" }).click();
        await page.getByRole("button", { name: "Filter this site" }).waitFor();
        assert.equal(await stored(), null);
        assert.equal(await soon(async () => (await ad()) === "block"), true);
        await page.close();
    });

    it("undoes a filter while the turn that presented it still runs", async () => {
        const [write, present, last] = presents();
        const lingers = [write, present, step("", [{ name: "run_ts", args: { code: "await new Promise((ok) => setTimeout(ok, 1500))" } }]), last];
        await op("submit", { tabId, steps: lingers });
        assert.equal(await soon(async () => (await stored()) !== null), true);
        assert.equal((await op("status", { site: TEST_SITE }))?.state, "working");
        await op("undo", { site: TEST_SITE });
        assert.equal(await stored(), null);
        const status = await settled();
        assert.equal(status?.state, "done");
        assert.equal(status.version, undefined);
        assert.equal(await op("dot", { site: TEST_SITE }), null);
        await assert.rejects(op("undo", { site: TEST_SITE }), /nothing to undo/);
    });

    it("puts a filter on once the person gives the site, though it was presented while they decided", async () => {
        await op("withhold", { on: true });
        await op("submit", { tabId, steps: presents() });
        await settled();
        assert.notEqual(await op("candidate", { site: TEST_SITE }), null);
        const page = await popup();
        await page.getByText("It isn't on, since the extension doesn't have access").waitFor();
        // as Chrome's prompt allowed: what waits goes on, and the open popup follows
        await op("withhold", { on: false });
        assert.deepEqual(await stored(), { version: 1, rules: 1 });
        assert.equal(await op("candidate", { site: TEST_SITE }), null);
        await page.getByText("The agent's filter is on.").waitFor();
        assert.deepEqual(await notices(), [`applied:${TEST_SITE}`]);
        await page.getByRole("button", { name: "Undo" }).click();
        await page.getByRole("button", { name: "Filter this site" }).waitFor();
        await page.close();
    });
});
