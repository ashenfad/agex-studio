/**
 * A browser with the extension loaded, for the end-to-end tests: Chromium
 * started as a plain process (no automation protocol attached, which would
 * keep the extension's service worker from ever going idle), and a local
 * server for the page that plays the studio. The page runs its scenarios
 * and posts each one's report here.
 *
 * Chromium is Playwright's (`pnpm exec playwright install chromium`), or
 * `CHROME`, a path to another Chromium or Chrome for Testing (branded
 * Chrome ignores `--load-extension`). `HEADED=1` shows the window.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

// the page imports the extension's own protocol module, as the studio will
const root = fileURLToPath(new URL("..", import.meta.url));
const TYPES = { ".html": "text/html", ".js": "text/javascript" };

/** @returns {Promise<string>} */
async function chromiumPath() {
    if (process.env.CHROME) return process.env.CHROME;
    const { chromium } = await import("playwright");
    const path = chromium.executablePath();
    if (!existsSync(path)) throw new Error(`no Chromium at ${path}: run \`pnpm exec playwright install chromium\`, or set CHROME`);
    return path;
}

/**
 * Serve the page, start Chromium with `extension` loaded on
 * `test/page/runner.html?<query>`, and collect the page's reports.
 *
 * @param {{ extension: string, query: Record<string, string> }} opts
 */
export async function launch({ extension, query }) {
    /** @type {Map<string, unknown>} */
    const reports = new Map();
    /** @type {Map<string, (r: unknown) => void>} */
    const waiting = new Map();
    const server = createServer(async (req, res) => {
        const path = new URL(req.url ?? "/", "http://x").pathname;
        if (req.method === "POST" && path === "/report") {
            let body = "";
            for await (const chunk of req) body += chunk;
            const { name, report } = JSON.parse(body);
            reports.set(name, report);
            waiting.get(name)?.(report);
            res.end("ok");
            return;
        }
        try {
            const file = join(root, path.slice(1));
            res.setHeader("content-type", TYPES[/** @type {keyof TYPES} */ (extname(file))] ?? "application/octet-stream");
            res.end(readFileSync(file));
        } catch {
            res.statusCode = 404;
            res.end();
        }
    });
    await new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(undefined)));
    const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;

    const profile = mkdtempSync(join(tmpdir(), "agex-ext-test-"));
    const args = [
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
        ...(process.env.HEADED ? [] : ["--headless=new"]),
        // GitHub's Linux runners can't give Chromium its sandbox
        ...(process.platform === "linux" ? ["--no-sandbox"] : []),
        `http://localhost:${port}/test/page/runner.html?${new URLSearchParams(query)}`,
    ];
    const browser = spawn(await chromiumPath(), args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    browser.stderr.on("data", (d) => {
        stderr = (stderr + d).slice(-4000);
    });

    return {
        /**
         * The report the page posts under `name`.
         * @param {string} name @param {number} [ms]
         */
        report(name, ms = 20_000) {
            if (reports.has(name)) return Promise.resolve(reports.get(name));
            return new Promise((ok, no) => {
                const timer = setTimeout(() => no(new Error(`no "${name}" report in ${ms}ms; Chromium said:\n${stderr}`)), ms);
                waiting.set(name, (r) => {
                    clearTimeout(timer);
                    ok(r);
                });
            });
        },
        async close() {
            browser.kill();
            await new Promise((ok) => (browser.exitCode !== null ? ok(undefined) : browser.once("exit", ok)));
            server.close();
            rmSync(profile, { recursive: true, force: true });
        },
    };
}
