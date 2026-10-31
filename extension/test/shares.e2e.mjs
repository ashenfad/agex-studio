// Tabs the person shares with a session, end to end: the dev build
// loaded into Chromium, a page on localhost playing the studio, and a
// tab it opens playing one of the person's own.
//
//     pnpm extension:test

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DEV_EXTENSION_ID } from "../src/protocol.js";
import { launch } from "./harness.mjs";

const ext = fileURLToPath(new URL("..", import.meta.url));

describe("a tab the person shares", () => {
    /** @type {Awaited<ReturnType<typeof launch>>} */
    let browser;
    /** @type {any} */
    let r;
    /** @type {any} */
    let t;
    /** whether the server ever answered a request for the fixture `id` */
    const loaded = (id) => browser.served().some((s) => s.id === id);
    before(async () => {
        execFileSync(process.execPath, [`${ext}/build.mjs`, "--dev"], { stdio: "ignore" });
        browser = await launch({ extension: `${ext}/dist/dev`, query: { ext: DEV_EXTENSION_ID, scenarios: "shared,toolbar" } });
        r = await browser.report("shared", 120_000);
        t = await browser.report("toolbar", 120_000);
    });
    after(() => browser?.close());

    it("offers the person's own web pages for the picker, not a session's tab nor the studio's", () => {
        assert.notEqual(r.offered, null, "the person's tab wasn't offered");
        assert.equal(r.browsable.some((/** @type {any} */ t) => t.id === r.own), false, "a session's own tab was offered");
        assert.equal(r.browsable.some((/** @type {any} */ t) => t.url.includes("runner.html")), false, "the studio's tab was offered");
        assert.equal(r.refusedOwn.error?.code, "bad-request");
    });

    it("shares a tab on the domain it's on, once, and lists it as shared", () => {
        assert.deepEqual(r.shared.value, { tab: r.offered.id, domain: "127.0.0.1" });
        assert.equal(r.twice.error?.code, "bad-request", "a tab shared already was shared again");
        assert.equal(r.listed?.shared, "127.0.0.1");
    });

    it("reads it, with no grant for its domain, and refuses anything but reading", () => {
        assert.match(r.read.value?.text ?? "", /A page for the tab tests/, JSON.stringify(r.read.error));
        for (const [op, reply] of Object.entries(r.refused)) assert.equal(/** @type {any} */ (reply).error?.code, "read-only", op);
        assert.equal(typeof r.waited.value?.ms, "number", JSON.stringify(r.waited.error));
        assert.equal(typeof r.scrolled.value?.top, "number", JSON.stringify(r.scrolled.error));
        assert.equal(r.shot, "string");
        assert.equal(loaded("sent"), false, "goto sent the person's tab somewhere");
    });

    it("never holds its loads, nor closes what its pages open", () => {
        assert.notEqual(r.next, null, "the person's next page on the site didn't load");
        assert.match(r.readNext.value?.title ?? "", /person-next/);
        assert.notEqual(r.away, null, "the person's page on another site didn't load");
        assert.equal(loaded("person-away"), true);
        assert.notEqual(r.opened, null, "a tab the person's page opened was closed, or taken as a session's");
    });

    it("reads it only on the site it was shared on", () => {
        for (const [op, reply] of Object.entries(r.moved)) assert.equal(/** @type {any} */ (reply).error?.code, "moved", op);
        assert.match(r.moved.read.error.message, /shared on 127\.0\.0\.1, and has gone to localhost/);
        assert.match(r.back.value?.title ?? "", /person-back/, JSON.stringify(r.back.error));
    });

    it("stops sharing it, and leaves it open", () => {
        assert.equal(r.unshared.value, null);
        assert.equal(r.after.error?.code, "not-found");
        assert.equal(r.stillOpen, true);
        assert.deepEqual(r.ownTabs, [r.own]);
    });

    it("keeps a share from the toolbar until the studio takes it, bringing the studio to the front", () => {
        assert.equal(t.hidden, "hidden", "the person's tab never came to the front");
        assert.equal(t.offered.value, null, JSON.stringify(t.offered.error));
        assert.equal(t.front, true, "the studio wasn't brought to the front");
        assert.equal(t.waiting.length, 1);
        assert.deepEqual({ tab: t.waiting[0].tab, domain: t.waiting[0].domain, title: t.waiting[0].title }, { tab: t.tab, domain: "127.0.0.1", title: "site toolbar-person" });
        assert.equal(t.offeredOwn.error?.code, "bad-request", "a session's own tab was offered");
    });

    it("drops a share turned down, gives one taken to the session, and forgets one whose tab closed", () => {
        assert.equal(t.dropped.value, null);
        assert.deepEqual(t.afterDrop, []);
        assert.deepEqual(t.taken.value, { tab: t.tab, domain: "127.0.0.1" });
        assert.equal(t.takenTwice.error?.code, "not-found");
        assert.deepEqual(t.afterTake, []);
        assert.equal(t.listed?.shared, "127.0.0.1");
        assert.equal(t.read, "site toolbar-person");
        assert.deepEqual(t.afterClose, []);
    });
});
