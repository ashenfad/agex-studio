#!/usr/bin/env node
// Load the spike's build into Chromium (Playwright's, headless) and run
// each probe through the service worker, printing what came back.
//
//     node spike/extension-agent/run.mjs [dist-dir]

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(process.argv[2] ?? join(here, "dist"));
const profile = mkdtempSync(join(tmpdir(), "agex-spike-"));
const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});
try {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    for (const what of ["here", "probes", "agent", "restart", "agent"]) {
        const started = Date.now();
        const result = await sw.evaluate((w) => globalThis.spike(w), what);
        console.log(`\n== ${what} (${Date.now() - started} ms)\n${JSON.stringify(result, null, 2)}`);
    }
} finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
}
