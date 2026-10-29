// A session's pages, end to end: read, waited on, sent on and shot, in
// background tabs of the dev build in Chromium, with a page on localhost
// playing the studio.
//
//     pnpm extension:test

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DEV_EXTENSION_ID } from "../src/protocol.js";
import { launch } from "./harness.mjs";

const ext = fileURLToPath(new URL("..", import.meta.url));

describe("a session's pages", () => {
    /** @type {Awaited<ReturnType<typeof launch>>} */
    let browser;
    /** whether the server ever answered a request for the fixture `id` */
    const loaded = (id) => browser.served().some((r) => r.id === id);
    before(async () => {
        execFileSync(process.execPath, [`${ext}/build.mjs`, "--dev"], { stdio: "ignore" });
        browser = await launch({ extension: `${ext}/dist/dev`, query: { ext: DEV_EXTENSION_ID, scenarios: "pages,blockers" } });
    });
    after(() => browser?.close());

    it("reads a background tab's page as it renders in front, frames and all", async () => {
        const { first } = await browser.report("pages", 90_000);
        const o = first.value;
        assert.equal(o.version, 1);
        assert.equal(o.title, "Hotels in Lisbon", "the title, without the working mark");
        assert.equal(o.blocker, null);
        // drawn in an animation frame: a hidden tab never runs one
        assert.match(o.text, /^2 hotels$/m);
        assert.match(o.text, /^# Hotels in Lisbon$/m);
        // a heading that is the result's link keeps its ref
        assert.match(o.text, /^### \[\d+\] link "Casa Alfama"$/m);
    });

    it("takes two calls at once in a tab not yet worked in", async () => {
        const { first, together } = await browser.report("pages", 90_000);
        assert.equal(first.value?.version, 1, JSON.stringify(first.error));
        assert.equal(together, "image/jpeg");
    });

    it("gives what can be clicked or typed into a ref, with its state", async () => {
        const { text } = (await browser.report("pages", 90_000)).first.value;
        assert.match(text, /Destination \[\d+\] textbox "Destination" = "Lisbon"/);
        assert.match(text, /\[\d+\] select "Guests" = "2" \(options: 1 \| 2 \| 3\)/);
        assert.match(text, /\[\d+\] checkbox "Flexible dates" \(checked\)/);
        assert.match(text, /\[\d+\] button "Search"/);
        assert.match(text, /\[\d+\] button "Reserve"/);
    });

    it("joins inline text, drops photo carousels, and folds a run of alike lines", async () => {
        const { text } = (await browser.report("pages", 90_000)).first.value;
        assert.match(text, /\(383 reviews\)/);
        assert.match(text, /From 124 EUR a night/);
        assert.doesNotMatch(text, /Photo \d/);
        assert.match(text, /\[\d+\] button "Save to list" \(and 4 more like it\)/);
        // a card that is one link: its ref, then its text
        assert.match(text, /^\[\d+\] link:$/m);
    });

    it("versions each read, and cuts the text to maxChars", async () => {
        const { second } = await browser.report("pages", 90_000);
        assert.equal(second.value.version, 2);
        assert.equal(second.value.text.length, 200);
        assert.ok(second.value.cut > 200);
    });

    it("waits for text to show, and times out on what never does", async () => {
        const { rates, never, badSelector } = await browser.report("pages", 90_000);
        assert.ok(rates.value.ms >= 0, JSON.stringify(rates));
        assert.equal(never.error.code, "timeout");
        assert.equal(badSelector.error.code, "failed");
    });

    it("takes a screenshot of a background tab", async () => {
        const { shot } = await browser.report("pages", 90_000);
        assert.equal(shot.mime, "image/jpeg");
        assert.ok(shot.bytes > 1000, `${shot.bytes} bytes`);
    });

    it("goes to a granted page, and refuses one without a grant, or redirected to one", async () => {
        const { went, ungranted, redirected, afterBlock } = await browser.report("pages", 90_000);
        assert.match(went.value.url, /id=went$/);
        assert.equal(went.value.title, "site went");
        assert.equal(ungranted.error.code, "not-granted");
        assert.equal(redirected.error.code, "not-granted");
        assert.match(redirected.error.message, /localhost/);
        assert.equal(loaded("leak-goto"), false);
        assert.equal(loaded("leak-goto-redirect"), false);
        // reading the browser's page for the stopped load says so
        assert.match(afterBlock.value.blocked?.url ?? "", /id=leak-goto-redirect/);
    });

    it("works in a tab while a turn runs, and rests it when the turn ends", async () => {
        const { working, rested } = await browser.report("pages", 90_000);
        assert.equal(working, true);
        assert.equal(rested, false);
    });

    it("refuses another session's tab", async () => {
        const { other } = await browser.report("pages", 90_000);
        assert.equal(other.error.code, "not-found");
    });

    it("says when a page is a CAPTCHA or a bot check", async () => {
        const r = await browser.report("blockers", 60_000);
        assert.deepEqual(r, { captcha: "captcha", checking: "bot-check", hotel: null });
    });
});
