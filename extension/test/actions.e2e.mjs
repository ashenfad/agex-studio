// Acting in a session's pages, end to end: clicks, typing and choices by
// the refs of an outline, in a background tab of the dev build in
// Chromium, with a page on localhost playing the studio.
//
//     pnpm extension:test

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DEV_EXTENSION_ID } from "../src/protocol.js";
import { launch } from "./harness.mjs";

const ext = fileURLToPath(new URL("..", import.meta.url));

describe("acting in a session's pages", () => {
    /** @type {Awaited<ReturnType<typeof launch>>} */
    let browser;
    /** @type {Record<string, any>} */
    let r;
    before(async () => {
        execFileSync(process.execPath, [`${ext}/build.mjs`, "--dev"], { stdio: "ignore" });
        browser = await launch({ extension: `${ext}/dist/dev`, query: { ext: DEV_EXTENSION_ID, scenarios: "actions" } });
        r = /** @type {Record<string, any>} */ (await browser.report("actions", 90_000));
    });
    after(() => browser?.close());

    it("clicks and types as a person's hand does: trusted events", () => {
        assert.equal(r.photos.value.title, "Book a room");
        assert.match(r.out, /clicked true;/);
        assert.match(r.out, /typed true hello;/);
        assert.match(r.out, /typed true hello there;/);
        assert.match(r.out, /typed true ;/, "typing nothing, with clear, empties the field");
    });

    it("chooses a select's option by its text, and names the options when none matches", () => {
        assert.equal(r.guests.value.chosen, "2");
        assert.match(r.out, /guests 2;/);
        assert.equal(r.noOption.error.code, "failed");
        assert.match(r.noOption.error.message, /its options: 1 \| 2/);
        // as the person couldn't choose them
        assert.equal(r.disabledOption.error.code, "failed");
        assert.match(r.disabledOption.error.message, /"3" is disabled/);
        assert.match(r.disabledGroup.error.message, /"10" is disabled/);
    });

    it("sets a date field, which takes no typing, and says what it takes when it refuses a value", () => {
        assert.equal(r.arrive.value?.title, "Book a room", JSON.stringify(r.arrive.error));
        assert.match(r.out, /arrive false 2026-12-03;/);
        assert.equal(r.arriveBad.error.code, "failed");
        assert.match(r.arriveBad.error.message, /a date field takes a value like 2026-12-03, not "Dec 3"/);
        // a refused value changes nothing: the date set before stays, the colour stays its own
        assert.match(r.fields, /date field "Arrive" = "2026-12-03"/);
        assert.equal(r.colourBad.error.code, "failed");
        assert.match(r.colourBad.error.message, /a color field takes a value like #ff8800, not "red"/);
        assert.match(r.fields, /color field "Colour" = "#336699"/);
    });

    it("refuses a read-only field, which only the site's own picker sets", () => {
        assert.equal(r.departReadOnly.error.code, "failed");
        assert.match(r.departReadOnly.error.message, /is read-only: click it/);
        assert.doesNotMatch(r.out, /depart/);
    });

    it("types into a field that has no selection, adding to it", () => {
        assert.equal(r.nights.value?.title, "Book a room", JSON.stringify(r.nights.error));
        assert.match(r.out, /nights 34;/);
    });

    it("refuses a step that reads as committing until it is confirmed", () => {
        assert.equal(r.reserve.error.code, "confirm");
        assert.match(r.reserve.error.message, /"Reserve"/);
        assert.equal(r.reserveConfirmed.value.title, "Book a room");
        assert.equal((r.out.match(/reserved;/g) ?? []).length, 1, "the refused click never reached the page");
        // Enter in a field submits its form, by the form's own button
        assert.equal(r.pay.error.code, "confirm");
        assert.match(r.pay.error.message, /Enter in \[\d+\] input "Card name", submitting its form by "Pay now"/);
        assert.doesNotMatch(r.out, /paid/);
        // named as the outline names them: an image's alt, aria-labelledby
        assert.equal(r.iconDelete.error?.code, "confirm", JSON.stringify(r.iconDelete));
        assert.equal(r.labelledDelete.error?.code, "confirm", JSON.stringify(r.labelledDelete));
        assert.doesNotMatch(r.out, /deleted|removed/);
    });

    it("submits a form that doesn't commit, and says where it went", () => {
        assert.equal(r.search.value.navigated, true);
        assert.equal(r.search.value.submitted, true);
        assert.match(r.search.value.url, /form\.html\?q=Lisbon$/);
    });

    it("refuses an element something else covers, naming what", () => {
        assert.equal(r.covered.error.code, "failed");
        assert.match(r.covered.error.message, /covered by span "Cookie banner"/);
    });

    it("clicks where an element shows, its center covered", () => {
        assert.equal(r.half.value?.title, "Book a room", JSON.stringify(r.half.error));
        assert.match(r.out, /half;/);
    });

    it("clicks a row's link through the row's own content, but not through another control", () => {
        assert.equal(r.rowClick.value?.title, "Book a room", JSON.stringify(r.rowClick.error));
        assert.match(r.out, /row true;/);
        assert.equal(r.rowCovered.error?.code, "failed");
        assert.match(r.rowCovered.error.message, /covered by button "Remove"/);
        assert.doesNotMatch(r.out, /row 706|removed row/);
    });

    it("presses a key on a ref, held to the same check for a step that commits", () => {
        assert.equal(r.rowKey.value?.title, "Book a room", JSON.stringify(r.rowKey.error));
        assert.match(r.out, /row key true;/);
        assert.equal(r.pressReserve.error?.code, "confirm");
        assert.match(r.pressReserve.error.message, /^Enter on \[\d+\] button "Reserve"/);
        assert.equal(r.pressPay.error?.code, "confirm");
        assert.match(r.pressPay.error.message, /Enter in \[\d+\] input "Card name", submitting its form by "Pay now"/);
        assert.equal(r.pressBadKey.error?.code, "bad-request");
        assert.match(r.pressBadKey.error.message, /key: one of Enter, Space/);
        assert.equal(r.pressTag.error?.code, "failed");
        assert.match(r.pressTag.error.message, /can't take the keyboard's focus: click it/);
        assert.doesNotMatch(r.out, /tag;/);
    });

    it("lists each ref's kind and name, as its line in the text starts", () => {
        assert.deepEqual(r.kinds, { Arrive: "date field", "From 583 to Lisbon": "link", Reserve: "button", Guests: "select" });
        assert.equal(r.refsListed, true);
    });

    it("refuses an action on an outline the page has changed since", () => {
        assert.equal(r.refresh.value.title, "Book a room");
        assert.equal(r.refreshAgain.error.code, "stale");
        assert.match(r.refreshAgain.error.message, /has left the page/);
        assert.equal(r.olderOutline.error.code, "stale");
        assert.match(r.olderOutline.error.message, /isn't its latest/);
        assert.equal(r.otherPage.error.code, "stale");
        assert.match(r.otherPage.error.message, /another page/);
    });

    it("says when a click led to a load without a grant, which never reached the site", () => {
        assert.match(r.away.value.blocked?.url ?? "", /id=leak-click/);
        assert.equal(browser.served().some((s) => s.id === "leak-click"), false);
    });
});
