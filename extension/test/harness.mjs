/**
 * A browser with the extension loaded, for the end-to-end tests: Chromium
 * started as a plain process (no automation protocol attached, which would
 * keep the extension's service worker from ever going idle), and a local
 * server for the page that plays the studio. The page runs its scenarios
 * and posts each one's report here.
 *
 * The server answers on `localhost` (and its subdomains, which Chromium
 * sends to loopback) and on `127.0.0.1`: two domains for the tab tests,
 * one granted, one not. It keeps every request it
 * serves (`served`), so a test can say a page never loaded, and
 * `/redirect?to=URL` redirects.
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
    /** @type {{ host: string, path: string, id: string | null }[]} */
    const served = [];
    const server = createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", "http://x");
        const path = url.pathname;
        served.push({ host: req.headers.host ?? "", path, id: url.searchParams.get("id") });
        if (path === "/redirect") {
            res.writeHead(302, { location: url.searchParams.get("to") ?? "/" });
            res.end();
            return;
        }
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
        // a page's window.open needs no click, as on a site the agent clicks through
        "--disable-popup-blocking",
        ...(process.env.HEADED ? [] : ["--headless=new"]),
        // GitHub's Linux runners can't give Chromium its sandbox
        ...(process.platform === "linux" ? ["--no-sandbox"] : []),
        `http://localhost:${port}/test/page/runner.html?${new URLSearchParams(query)}`,
    ];
    // a process group of its own, so closing it stops its helper processes too
    const browser = spawn(await chromiumPath(), args, { stdio: ["ignore", "ignore", "pipe"], detached: true });
    // what Chromium said last, and the head of a crash's report, which a long
    // stack and the noise after it would push out of the tail
    let stderr = "";
    let crash = "";
    browser.stderr.on("data", (d) => {
        const joined = stderr + d;
        stderr = joined.slice(-4000);
        if (crash === "") {
            const at = joined.search(/Received signal|Check failed|FATAL:/);
            if (at >= 0) crash = joined.slice(at, at + 6000);
        } else if (crash.length < 6000) {
            crash = (crash + d).slice(0, 6000);
        }
    });
    const said = () => (crash === "" ? stderr : `${crash}\n...\n${stderr}`);

    return {
        port,
        /** Every request the server has answered. */
        served: () => [...served],
        /**
         * The report the page posts under `name`.
         * @param {string} name @param {number} [ms]
         */
        report(name, ms = 20_000) {
            if (reports.has(name)) return Promise.resolve(reports.get(name));
            return new Promise((ok, no) => {
                const timer = setTimeout(() => no(new Error(`no "${name}" report in ${ms}ms; Chromium said:\n${said()}`)), ms);
                waiting.set(name, (r) => {
                    clearTimeout(timer);
                    ok(r);
                });
            });
        },
        async close() {
            const exited = new Promise((ok) => (browser.exitCode !== null ? ok(undefined) : browser.once("exit", ok)));
            try {
                process.kill(-(/** @type {number} */ (browser.pid)), "SIGKILL");
            } catch {
                browser.kill("SIGKILL"); // gone already, or no group to signal
            }
            await exited;
            server.close();
            // a helper still writing as it dies can leave the profile unremovable for a moment;
            // a temporary directory left behind fails no test
            try {
                rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
            } catch (e) {
                console.warn(`couldn't remove the test profile ${profile}: ${e}`);
            }
        },
    };
}
