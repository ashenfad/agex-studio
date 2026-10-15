#!/usr/bin/env node
/**
 * Drive the studio from a terminal: a person's checks, and an agent's.
 *
 * Starts the dev server (or uses `--url`), opens the studio in headless
 * Chromium, sets the model, sends each prompt as a turn, and prints what
 * came of it: each turn's ending, its tool calls and their results, the
 * agent's reply, and the workspace's files. It works the studio through
 * its dev-only hook (`window.__studio`), so it doesn't depend on the
 * markup.
 *
 *     pnpm drive "Write a haiku about rivers to /workspace/haiku.txt"
 *     pnpm drive --profile .drive-profile --reload      # the record, after a reload
 *     pnpm drive --scripted steps.json "go"             # no model call
 *     pnpm drive "write a.txt" --exec "s.fork('fresh')" --exec "s.files()"
 *                                       # hook calls (s = __studio), in order
 *
 * The model and key come from the environment, and the key is never
 * printed:
 *   DRIVE_MODE      openrouter (default) | custom | scripted
 *   DRIVE_MODEL     default meta/muse-spark-1.3-contributor
 *   OPENROUTER_API_KEY (the model's in openrouter mode; web and media's
 *                   in any mode), DRIVE_API_KEY (custom, if the endpoint needs one)
 *   DRIVE_BASE_URL, DRIVE_WIRE (custom: anthropic | openai)
 *   CHROME          a Chromium executable, if Playwright's isn't installed
 *   DRIVE_SYNC_REPO, DRIVE_SYNC_TOKEN   connect sync to this repo (owner/name)
 *   DRIVE_PUBLISH_TOKEN   a token that can write gists, for publishing
 *
 * Options:
 *   --url <url>         a studio already running (default: start `vite`)
 *   --profile <dir>     keep the browser's data (IndexedDB) in <dir>, so
 *                       a later run sees this one's sessions
 *   --open <path>       open the studio at this path first (a published
 *                       session's /run/?gist=… link, say)
 *   --apps <dir>        serve this agex-studio-apps clone as the preview's
 *                       origin, rather than apps.agex.studio
 *
 * The studio is served on DRIVE_PORT, default 5173: the apps origin's
 * bootloader takes its app only from a studio on 5173 or 4173, and a
 * kept profile's data belongs to its origin, port and all.
 *   --reload            after the prompts, reload and print the record again
 *   --scripted <file>   a JSON list of model steps (DRIVE_MODE=scripted)
 *   --shot <file>       save a screenshot of the page at the end
 *   --viewport <WxH>    the page's size (default 1280x720; 390x844 a phone)
 *   --exec <expr>       evaluate `<expr>` in the page with `s` the hook,
 *                       in order among the prompts, and print its result
 *   --quiet             print only endings and the final reply
 *   --requests          print each model request (a POST off the studio's
 *                       origin): its URL and affinity key, no auth headers
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const args = process.argv.slice(2);
const opts = {
    prompts: /** @type {string[]} */ ([]),
    /** prompts and hook calls, in the order given */
    steps: /** @type {{ kind: "say" | "exec", text: string }[]} */ ([]),
};
for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--url") opts.url = args[++i];
    else if (a === "--profile") opts.profile = args[++i];
    else if (a === "--reload") opts.reload = true;
    else if (a === "--scripted") opts.scripted = args[++i];
    else if (a === "--shot") opts.shot = args[++i];
    else if (a === "--viewport") opts.viewport = args[++i];
    else if (a === "--quiet") opts.quiet = true;
    else if (a === "--requests") opts.requests = true;
    else if (a === "--apps") opts.apps = args[++i];
    else if (a === "--open") opts.open = args[++i];
    else if (a === "--exec") opts.steps.push({ kind: "exec", text: args[++i] });
    else {
        opts.prompts.push(a);
        opts.steps.push({ kind: "say", text: a });
    }
}

const env = process.env;
const mode = opts.scripted ? "scripted" : (env.DRIVE_MODE ?? "openrouter");
const settings =
    mode === "scripted"
        ? { accessMode: "scripted" }
        : mode === "custom"
          ? {
                accessMode: "custom",
                baseUrl: env.DRIVE_BASE_URL ?? "",
                wire: env.DRIVE_WIRE ?? "anthropic",
                endpointKey: env.DRIVE_API_KEY ?? "",
                // web and media, beside the endpoint's model
                routerKey: env.OPENROUTER_API_KEY ?? "",
                endpointModel: env.DRIVE_MODEL ?? "",
            }
          : {
                accessMode: "openrouter",
                routerKey: env.OPENROUTER_API_KEY ?? "",
                routerModel: env.DRIVE_MODEL ?? "meta/muse-spark-1.3-contributor",
            };
if (env.DRIVE_PUBLISH_TOKEN) settings.publishToken = env.DRIVE_PUBLISH_TOKEN;
if (env.DRIVE_SYNC_REPO && env.DRIVE_SYNC_TOKEN) {
    Object.assign(settings, { syncRepo: env.DRIVE_SYNC_REPO, syncToken: env.DRIVE_SYNC_TOKEN });
}
if (mode === "openrouter" && settings.routerKey === "") {
    console.error("OPENROUTER_API_KEY isn't set (or use --scripted, or DRIVE_MODE=custom)");
    process.exit(2);
}

/** Serve `dir` as the preview's origin; its URL. */
async function serveApps(dir) {
    const { createServer } = await import("node:http");
    const { readFile } = await import("node:fs/promises");
    const { join, normalize } = await import("node:path");
    const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
    const server = createServer(async (req, res) => {
        const path = normalize(new URL(req.url ?? "/", "http://x").pathname).replace(/^(\.\.[/\\])+/, "");
        const file = join(dir, path.endsWith("/") ? `${path}index.html` : path);
        try {
            const body = await readFile(file);
            res.writeHead(200, { "content-type": types[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream" });
            res.end(body);
        } catch {
            res.writeHead(404).end();
        }
    });
    await new Promise((resolve) => server.listen(0, "localhost", resolve));
    const address = /** @type {import("node:net").AddressInfo} */ (server.address());
    return { url: `http://localhost:${address.port}`, stop: () => server.close() };
}

/** Start `vite`; its URL once it is listening. */
async function startServer(appsOrigin) {
    const port = Number(env.DRIVE_PORT ?? 5173);
    const server = spawn("npx", ["vite", "--port", String(port), "--strictPort"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...env, ...(appsOrigin && { VITE_APPS_ORIGIN: appsOrigin }) },
    });
    let output = "";
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`vite didn't start:\n${output}`)), 30_000);
        const seen = (/** @type {Buffer} */ d) => {
            output += d;
            if (output.includes("Local:")) {
                clearTimeout(timer);
                resolve(undefined);
            }
        };
        server.stdout.on("data", seen);
        server.stderr.on("data", seen);
        server.on("exit", (code) =>
            reject(new Error(`vite exited ${code} (port ${port} taken? set DRIVE_PORT=4173, or pass --url):\n${output}`)),
        );
    });
    return { url: `http://localhost:${port}/`, stop: () => server.kill() };
}

/** @param {unknown} value @param {number} n */
const cut = (value, n) => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > n ? `${text.slice(0, n)}… (${text.length} chars)` : text;
};

/** Print one stored run. */
function printRun(run) {
    console.log(`\n── run ${run.runId.slice(0, 8)}: ${run.status}`);
    for (const message of run.messages) {
        for (const part of message.parts) {
            if (message.role === "user" && part.kind === "text") console.log(`  person: ${cut(part.text, 400)}`);
            else if (part.kind === "thinking" && !opts.quiet) console.log(`  thinking: ${cut(part.text, 200)}`);
            else if (part.kind === "text") console.log(`  agent: ${part.text}`);
            else if (part.kind === "tool_call" && !opts.quiet) console.log(`  → ${part.name} ${cut(part.args, 600)}`);
            else if (part.kind === "tool_result" && !opts.quiet) {
                console.log(`  ← ${part.name}${part.isError ? " (error)" : ""}: ${cut(part.content, 600)}`);
            }
        }
    }
}

const apps = opts.apps ? await serveApps(opts.apps) : null;
const server = opts.url ? null : await startServer(apps?.url);
const url = opts.url ?? server.url;
const [width, height] = (opts.viewport ?? "1280x720").split("x").map(Number);
const viewport = { width, height };
const launch = { headless: true, ...(env.CHROME && { executablePath: env.CHROME }) };
const context = opts.profile
    ? await chromium.launchPersistentContext(opts.profile, { ...launch, viewport })
    : await (await chromium.launch(launch)).newContext({ viewport });
const page = context.pages()[0] ?? (await context.newPage());
page.on("pageerror", (e) => console.log(`[page error] ${e.message}`));
if (opts.requests) {
    page.on("request", (r) => {
        const target = new URL(r.url());
        // the model's calls are POSTs elsewhere; fonts and modules aren't
        if (target.origin === new URL(url).origin || r.method() !== "POST") return;
        const key = r.headers()["x-session-affinity"];
        console.log(`[request] ${r.method()} ${target.origin}${target.pathname}${key ? ` affinity=${key}` : ""}`);
    });
}
page.on("console", (m) => {
    if (m.type() === "error") console.log(`[console] ${m.text()}`);
});

let first = true;
const ready = async () => {
    await page.goto(first && opts.open ? new URL(opts.open, url).href : url);
    first = false;
    // the hook is there at once; the session opens a moment after
    await page.waitForFunction(() => /** @type {any} */ (window).__studio?.ready === true);
};

let failed = false;
try {
    await ready();
    const shown = await page.evaluate((s) => /** @type {any} */ (window).__studio.configure(s), settings);
    const model = shown.accessMode === "custom" ? shown.endpointModel : shown.routerModel;
    console.log(`studio at ${url} — ${shown.accessMode}${model ? ` ${model}` : ""}`);
    if (opts.scripted) {
        const steps = JSON.parse(readFileSync(opts.scripted, "utf-8"));
        await page.evaluate((s) => /** @type {any} */ (window).__studio.script(s), steps);
    }
    const before = (await page.evaluate(() => /** @type {any} */ (window).__studio.transcript())).length;
    for (const step of opts.steps) {
        if (step.kind === "exec") {
            const result = await page.evaluate(async (expr) => {
                const s = /** @type {any} */ (window).__studio;
                const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
                return await new AsyncFunction("s", `return (${expr})`)(s);
            }, step.text);
            console.log(`\n> ${step.text}\n${JSON.stringify(result, null, 2)}`);
            continue;
        }
        const started = Date.now();
        const ended = await page.evaluate((p) => /** @type {any} */ (window).__studio.say(p), step.text);
        console.log(`\nturn: ${ended.status}${ended.error ? ` (${ended.error})` : ""} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
        if (ended.status !== "completed") failed = true;
    }
    const runs = await page.evaluate(() => /** @type {any} */ (window).__studio.transcript());
    // with no prompts, what the record holds (once: after the reload, if asked)
    if (opts.prompts.length > 0) for (const run of runs.slice(before)) printRun(run);
    else if (!opts.reload) for (const run of runs) printRun(run);
    if (opts.reload) {
        await ready();
        const again = await page.evaluate(() => /** @type {any} */ (window).__studio.transcript());
        console.log(`\nafter a reload: ${again.length} run(s) in the record`);
        if (opts.prompts.length === 0) for (const run of again) printRun(run);
    }
    const files = await page.evaluate(() => /** @type {any} */ (window).__studio.files("/workspace"));
    console.log(`\nfiles: ${files.length === 0 ? "(none)" : files.join(", ")}`);
    if (opts.shot) {
        await page.screenshot({ path: opts.shot, fullPage: true });
        console.log(`screenshot: ${opts.shot}`);
    }
} catch (e) {
    failed = true;
    console.error(e instanceof Error ? e.message : String(e));
} finally {
    await context.close();
    server?.stop();
    apps?.stop();
}
process.exit(failed ? 1 : 0);
