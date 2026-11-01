// The extension's port, end to end: the dev, store and site builds loaded
// into Chromium, a page on localhost playing the studio.
//
//     pnpm extension:test
//
// The idle case waits out the service worker's idle stop, so the file
// takes a minute; the heartbeat, which keeps the worker up and so can't
// share its browser, is `heartbeat.e2e.mjs`.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DEV_EXTENSION_ID, PROTOCOL } from "../src/protocol.js";
import { build, launch } from "./harness.mjs";

const ext = fileURLToPath(new URL("..", import.meta.url));
const version = JSON.parse((await import("node:fs")).readFileSync(`${ext}/manifest.json`, "utf8")).version;

describe("the dev build", () => {
    /** @type {Awaited<ReturnType<typeof launch>>} */
    let browser;
    before(async () => {
        build("--dev");
        browser = await launch({
            extension: `${ext}/dist/dev`,
            query: { ext: DEV_EXTENSION_ID, scenarios: "reachable,hello,refusals,idle" },
        });
    });
    after(() => browser?.close());

    it("is reachable from localhost, under its fixed id", async () => {
        assert.deepEqual(await browser.report("reachable"), { connect: true });
        const { hello, ping } = await browser.report("hello");
        assert.deepEqual(hello.value, { protocol: PROTOCOL, version });
        assert.equal(typeof ping.value.at, "number");
    });

    it("refuses an op before hello, an unknown op, and another protocol", async () => {
        const { early, unknown, wrong, wrongClosed } = await browser.report("refusals");
        assert.equal(early.error.code, "hello-first");
        assert.equal(unknown.error.code, "unknown-op");
        assert.equal(wrong.error.code, "protocol");
        assert.equal(wrongClosed, true);
    });

    it("drops a quiet port when its worker stops, and a new port works", async () => {
        const { droppedAfterMs, reconnected } = await browser.report("idle", 120_000);
        assert.notEqual(droppedAfterMs, null, "the quiet port never dropped");
        assert.ok(droppedAfterMs > 20_000, `dropped after ${droppedAfterMs}ms, before the idle limit`);
        assert.deepEqual(reconnected.value, { protocol: PROTOCOL, version });
    });
});

for (const [name, mode, flags] of [["store", "prod", []], ["site", "site", ["--site"]]]) {
    describe(`the ${name} build`, () => {
        it("can't be reached from localhost", async () => {
            build(...flags);
            const browser = await launch({ extension: `${ext}/dist/${mode}`, query: { ext: "", scenarios: "reachable" } });
            try {
                assert.deepEqual(await browser.report("reachable"), { connect: false });
            } finally {
                await browser.close();
            }
        });
    });
}
