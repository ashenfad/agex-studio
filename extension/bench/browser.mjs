/**
 * The bench's browser: Playwright's Chromium, headless, as a person's
 * Chrome would introduce itself, and the extension's test pages served
 * locally (a site's `fixture:` URL).
 */

import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const PAGES = join(here, "..", "test", "page");

/** A Chromium to read pages in, and the URL a site's `fixture:` names. */
export async function launch() {
    const server = createServer((req, res) => {
        const file = join(PAGES, new URL(req.url ?? "/", "http://x").pathname.replace(/^\/+/, ""));
        if (!file.startsWith(PAGES) || !existsSync(file)) {
            res.statusCode = 404;
            res.end();
            return;
        }
        res.setHeader("content-type", file.endsWith(".html") ? "text/html" : "text/javascript");
        res.end(readFileSync(file));
    });
    await new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(undefined)));
    const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
    const context = await chromium.launchPersistentContext("", {
        // the full Chromium, whose new headless mode renders as a window does
        channel: "chromium",
        headless: true,
        viewport: { width: 1280, height: 900 },
        locale: "en-US",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    });
    return {
        context,
        /** @param {string} url */
        resolve: (url) => (url.startsWith("fixture:") ? `http://127.0.0.1:${port}/${url.slice("fixture:".length)}` : url),
        async close() {
            await context.close();
            server.close();
        },
    };
}

/** Wait for a page to draw what it loads after it loads: its network
 *  quiet a while, or 15 s, then 2.5 s more. @param {import("playwright").Page} page */
export async function settle(page) {
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(2_500);
}
