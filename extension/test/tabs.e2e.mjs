// A session's tabs, end to end: the dev build loaded into Chromium, a
// page on localhost playing the studio, and the harness's server on two
// domains, one granted to the sessions and one not.
//
//     pnpm extension:test
//
// One case waits out the service worker's idle stop, so the file takes
// about a minute.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DEV_EXTENSION_ID } from "../src/protocol.js";
import { launch } from "./harness.mjs";

const ext = fileURLToPath(new URL("..", import.meta.url));

describe("a session's tabs", () => {
    /** @type {Awaited<ReturnType<typeof launch>>} */
    let browser;
    /** whether the server ever answered a request for the fixture `id` */
    const loaded = (id) => browser.served().some((r) => r.id === id);
    before(async () => {
        execFileSync(process.execPath, [`${ext}/build.mjs`, "--dev"], { stdio: "ignore" });
        browser = await launch({
            extension: `${ext}/dist/dev`,
            query: { ext: DEV_EXTENSION_ID, scenarios: "tabs,held,opened,popup,regrant,subdomains,turn,restart" },
        });
    });
    after(() => browser?.close());

    it("opens a tab on a granted origin, lists it, and closes it", async () => {
        const r = await browser.report("tabs", 60_000);
        assert.equal(r.session.value, null);
        assert.equal(typeof r.opened.value.tab, "number");
        assert.equal(r.loaded?.id, r.opened.value.tab);
        assert.match(r.loaded.url, /^http:\/\/127\.0\.0\.1:\d+\/test\/page\/site\.html\?id=open$/);
        assert.equal(r.loaded.blocked, undefined);
        assert.equal(r.closed.value, null);
        assert.deepEqual(r.after.value, []);
    });

    it("refuses an origin without a grant, an unknown session, and another session's tab", async () => {
        const r = await browser.report("tabs", 60_000);
        assert.equal(r.ungranted.error.code, "not-granted");
        assert.equal(r.unknown.error.code, "not-found");
        assert.equal(r.elsewhere.error.code, "not-found");
        assert.equal(loaded("refused"), false);
    });

    it("stops a page's own navigation, and a redirect, to an origin without a grant", async () => {
        const r = await browser.report("held", 60_000);
        assert.match(r.wentBlocked?.blocked?.url ?? "", /id=leak-go/);
        assert.match(r.redirectBlocked?.blocked?.url ?? "", /id=leak-redirect/);
        assert.equal(loaded("leak-go"), false, "the page's navigation reached the server");
        assert.equal(loaded("leak-redirect"), false, "the redirect reached the server");
    });

    it("closes a tab a page opens without a grant, and holds one it opens with a grant", async () => {
        const r = await browser.report("opened", 60_000);
        assert.equal(r.source?.blocked?.newTab, true);
        assert.match(r.source.blocked.url, /id=leak-open/);
        // the one the page opened on a granted origin is the session's, and held
        assert.notEqual(r.child, null, "the granted tab the page opened isn't the session's, or wasn't held");
        assert.match(r.child.blocked.url, /id=leak-opened/);
        assert.equal(loaded("leak-opened"), false);
        // four tabs the runner opened, and the one opened with a grant
        const ids = r.tabs.map((t) => t.id);
        assert.ok([r.refused, r.allowed, r.raced].every((o) => ids.includes(o.value.tab)), `the session's tabs: ${ids}`);
        assert.equal(r.shown, "visible", "the opened tab kept the front");
    });

    it("closes a tab a page opens that got somewhere without a grant before it was held", async () => {
        const r = await browser.report("opened", 60_000);
        const there = r.tabs.filter((t) => t.url.includes("id=leak-raced"));
        if (loaded("leak-raced")) {
            // the redirect beat the rules: the page loaded, and the tab is closed
            assert.deepEqual(there, [], "a tab on an origin without a grant was left to the session");
            assert.match(r.racedSource?.blocked?.url ?? "", /id=leak-raced/);
        } else {
            // the rules were in time: the load was stopped, in a tab closed or held
            assert.ok(there.every((t) => t.blocked) && (there.length > 0 || r.racedSource?.blocked?.newTab));
        }
    });

    // Whether the focus goes back from the popup isn't checked here:
    // headless Chromium calls every window focused, and focuses none.
    it("keeps a popup window a page opens as the session's", async () => {
        const r = await browser.report("popup", 60_000);
        assert.notEqual(r.popup, null, "the popup isn't the session's");
    });

    it("holds open tabs to a session's grants as they change", async () => {
        const r = await browser.report("regrant", 60_000);
        assert.match(r.narrowed?.blocked?.url ?? "", /id=after-narrow/);
        assert.equal(loaded("after-narrow"), false);
        assert.notEqual(r.widened, null, "the widened tab never reached the new origin");
        assert.equal(loaded("after-wide"), true);
    });

    it("keeps a session's tabs, and holds their loads, after the worker's idle stop", async () => {
        const r = await browser.report("restart", 150_000);
        assert.notEqual(r.stoppedAfterMs, null, "the worker never stopped");
        assert.deepEqual(r.listed, [r.tab]);
        assert.match(r.blocked?.blocked?.url ?? "", /id=leak-kept/);
        assert.equal(loaded("leak-kept"), false);
    });

    it("lets a domain's grant cover its subdomains, and refuses anything that isn't a domain", async () => {
        const r = await browser.report("subdomains", 60_000);
        assert.notEqual(r.loaded, null, JSON.stringify(r.opened));
        assert.equal(loaded("sub"), true);
        assert.equal(r.refused.error.code, "not-granted");
        assert.equal(loaded("sub-refused"), false);
        assert.equal(r.notDomain.error.code, "bad-request");
        assert.equal(r.topLevel.error.code, "bad-request");
    });

    it("keeps the studio's tab from discarding while a turn runs", async () => {
        const { running, done } = await browser.report("turn", 60_000);
        assert.deepEqual(running.value, { discardable: false });
        assert.deepEqual(done.value, { discardable: true });
    });
});
