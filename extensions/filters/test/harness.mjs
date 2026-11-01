/**
 * The site-filter extension's end-to-end tests: a build of it loaded into
 * Playwright's Chromium (headless unless `HEADED=1`), in a fresh profile
 * each time.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

/**
 * Chromium with the build at `dir` loaded, and its service worker.
 *
 * @param {string} dir
 */
export async function launch(dir) {
    const profile = mkdtempSync(join(tmpdir(), "agex-filters-"));
    const context = await chromium.launchPersistentContext(profile, {
        channel: "chromium",
        headless: process.env.HEADED !== "1",
        args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`],
    });
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    return {
        context,
        worker,
        /** The extension's id, as Chrome gave it. */
        id: new URL(worker.url()).host,
        async close() {
            await context.close();
            rmSync(profile, { recursive: true, force: true });
        },
    };
}
