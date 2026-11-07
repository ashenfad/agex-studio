// The site-filter extension loads, under its fixed id, and its worker
// answers the extension's own pages.
//
//     pnpm filters:test

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { build } from "../build.mjs";
import { DEV_FILTERS_ID } from "../src/ids.js";
import { launch } from "./harness.mjs";

describe("the dev build", () => {
    /** @type {Awaited<ReturnType<typeof launch>>} */
    let browser;
    before(async () => {
        browser = await launch(await build("dev"));
    });
    after(() => browser?.close());

    it("loads under its fixed id", () => {
        assert.equal(browser.id, DEV_FILTERS_ID);
    });

    it("answers a page of its own", async () => {
        const page = await browser.context.newPage();
        // any page of the extension's origin will do: its manifest is one
        await page.goto(`chrome-extension://${browser.id}/manifest.json`);
        const reply = await page.evaluate(() => chrome.runtime.sendMessage({ op: "ping" }));
        assert.deepEqual(reply, { value: { version: "0.1.0" } });
    });
});
