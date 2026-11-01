// The studio's heartbeat, end to end: a port it pings stays up past the
// service worker's idle limit. A file of its own, since a worker kept up
// can't also show a quiet port dropping (`port.e2e.mjs`), and the wait
// runs beside the other files'.
//
//     pnpm extension:test

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DEV_EXTENSION_ID, HEARTBEAT_MS } from "../src/protocol.js";
import { build, launch } from "./harness.mjs";

const ext = fileURLToPath(new URL("..", import.meta.url));

describe("the heartbeat", () => {
    /** @type {Awaited<ReturnType<typeof launch>>} */
    let browser;
    before(async () => {
        build("--dev");
        browser = await launch({ extension: `${ext}/dist/dev`, query: { ext: DEV_EXTENSION_ID, scenarios: "heartbeat" } });
    });
    after(() => browser?.close());

    it(`keeps a port pinged every ${HEARTBEAT_MS / 1000}s up past the idle limit`, async () => {
        const { up, pings } = await browser.report("heartbeat", 120_000);
        assert.equal(up, true);
        assert.ok(pings >= 3, `${pings} pings`);
    });
});
