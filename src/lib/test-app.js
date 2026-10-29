/**
 * The `test_app` tool: the agent checks its app by acting on it, in a
 * hidden test iframe built from the files under `app/` now, or (`live`)
 * in the preview the person is looking at.
 *
 * A screenshot comes back as an image in the same result, so a model
 * that sees images looks at it on its next call.
 */

import { buildAppPage, reseedAppPage } from "./app-html.js";
import { readApp, hasApp } from "./app-files.js";
import { LOAD_TIMEOUT_MS, getLiveIframe, runLiveApp, runTestApp, whenLiveSettled } from "./app-control.js";
import { appDbs } from "./app-db-clients.js";
import { NEEDS_PATH, parseNeeds } from "./app-needs.js";
import { read as readAppStorage } from "./app-storage.js";
import { appAgent } from "./app-tasks.svelte.js";
import { errorText } from "./errors.js";
import { GRID_MAX, tileGrid } from "./grid.js";
import { STAND_INS_MAX, parseStandIns } from "./stand-ins.js";
import { liveVariables } from "./variables.js";

/** What the model reads of a value: JSON, cut at `max` characters. */
const shown = (/** @type {unknown} */ value, max = 4000) => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text === undefined ? String(value) : text.length > max ? `${text.slice(0, max)}… (${text.length} chars)` : text;
};

const TEST_APP_DESCRIPTION = `Check the app under /workspace/app by acting on it in a browser.

By default it runs in a fresh hidden iframe built from the app's files as they are now (its storage seeded from the person's, writes discarded; agex.db is a copy of the person's database as it is now, kept across the test's reloads and discarded after: the person's is never written). Before the first action it waits for the page to load (its scripts and their imports, which can take seconds from esm.sh), then for the app to settle; if it still hasn't loaded after ${LOAD_TIMEOUT_MS / 1000}s, the actions run anyway and the result says so. With live: true it acts on the preview the person is looking at instead, with the person's own storage and agex.db: what it writes there stays.

actions: a list of plain objects, run in order:
- {click: "#sel"} · {type: "#sel", value: "text"} · {select: "#sel", value: "an option's value"}: each waits up to 1s for its target to appear (timeout: ms to change that). A target that never appears, or is disabled, ends the call with an error. A click is real pointer and mouse events at the element's center, so SVG elements take it too
- {waitFor: "#sel"}: wait until the selector matches · {waitUntil: "expr"}: wait until a JS expression is true (a throw counts as not yet). Up to 5s (timeout: ms); running out ends the call with an error. After an eval or a click that changes state, wait for what it renders before reading or clicking it, rather than guessing a {wait: ms}
- {wait: 500}: sleep, in ms
- {read: "#sel"} or {read: "#sel", prop: "value"}: innerText (the text as shown), or a property (prop: "textContent" for the raw text)
- {eval: "expr", label: "name"}: a JS expression in the app's page; a Promise is awaited. The optional label names it in the result in place of its code
- {assert: "expr", message: "..."}: a failing assertion ends the call with an error. With soft: true a failure is reported and the actions go on; the call then ends as an error saying how many soft asserts failed
- {screenshot: true} or {screenshot: "#sel"}: a PNG, attached to this result
- {screenshot: true | "#sel", grid: "name", label: "1.5s title"}: held, and every frame of a grid comes back tiled into ONE captioned image at the end (also when an action fails); up to ${GRID_MAX} frames a grid. Use it to check several states (scenes, steps) for the cost of one image
- {viewport: "mobile" | "tablet" | "desktop" | {width, height}}: resize (not live)
- {reload: true}: reload the page (rebuilt from the same files), keeping what this test wrote to localStorage, sessionStorage and agex.db, and wait for it to load again: checks what survives a reload. The person's storage and database are never written (not live)

An action that fails ends the call with an error, after the results that came before it; an eval that throws is reported and the actions go on.
viewport sets the hidden iframe's starting size (default 800x600); fresh: true starts it with empty storage and an empty agex.db.
standIns: canned responses for the services the app calls, so a test needs no key and doesn't reach the services they stand in for (not live). Up to ${STAND_INS_MAX}, each {url: "https://api.example.com/v1/items", method?: "GET", status?: 200, headers?: {...}, json?: any value | body?: "text"}; it answers that method (any, without one) to that origin and path, whatever the query. A request with a secret (agex.fetch with \${NAME} in its header) is checked as for real, then answered by its stand-in and never sent; one no stand-in matches is refused. A request without one (fetch, in the page or a worker, or agex.fetch) is answered by its stand-in in place of the network; one no stand-in matches goes out for real, so give a stand-in to every request the test shouldn't send. Each shows in the console output as [stand-in], with the headers that named a secret.
The result lists the app's console output, then each action's result. The app's own timers keep running between actions, so compare time-driven values with a tolerance, or give the app a hook to pause or step it. While the studio's tab is in the background, the browser pauses animation frames and slows timers: the result says so when that happened.`;

/** The line a result gets when the studio's page was hidden during the call. */
export const HIDDEN_NOTE = "Note: the studio's tab was in the background during this test: animation frames were paused and timers slowed, so timing-based results may be wrong. Keep the studio window at least partly visible while testing.";

/**
 * Watch whether `doc` (the studio's page, which every app frame in it
 * follows) is hidden at any point until the function returned is
 * called, which stops watching and says whether it was. A hidden page
 * gets no animation frames, and its timers are slowed to about one a
 * second, so a test's timing then means little.
 *
 * @param {Document | undefined} [doc]
 * @returns {() => boolean}
 */
export function watchHidden(doc = globalThis.document) {
    if (doc === undefined) return () => false;
    let hidden = false;
    const look = () => {
        if (doc.visibilityState === "hidden") hidden = true;
    };
    look();
    doc.addEventListener("visibilitychange", look);
    return () => {
        look();
        doc.removeEventListener("visibilitychange", look);
        return hidden;
    };
}

/**
 * The tool, over `session`: a chat session, or a delegate's workspace
 * (`ws`, and `name` the session whose app storage seeds the test). A
 * delegate's `live` is refused: the preview shows another session's
 * app.
 *
 * @param {{ ws: import("@agex-ts/world").Workspace | null, name: string, delegate?: boolean }} session
 * @returns {import("@agex-ts/world").Tool}
 */
export function testAppTool(session) {
    return {
        name: "test_app",
        description: TEST_APP_DESCRIPTION,
        parameters: {
            type: "object",
            properties: {
                actions: { type: "array", items: { type: "object" } },
                live: { type: "boolean" },
                viewport: {
                    anyOf: [
                        { type: "string", enum: ["desktop", "tablet", "mobile"] },
                        { type: "object", properties: { width: { type: "number" }, height: { type: "number" } } },
                    ],
                },
                fresh: { type: "boolean" },
                standIns: { type: "array", items: { type: "object" } },
            },
        },
        async call(args) {
            // a page hidden at any point makes the test's timing suspect: said with the result
            const wasHidden = watchHidden();
            const out = await runTest(session, args);
            return wasHidden() ? { ...out, text: `${out.text}\n${HIDDEN_NOTE}` } : out;
        },
    };
}

/**
 * Run a call's actions, in a test iframe or (`live`) the preview, and
 * say what came of them.
 *
 * @param {{ ws: import("@agex-ts/world").Workspace | null, name: string, delegate?: boolean }} session
 * @param {Record<string, unknown>} args
 * @returns {Promise<import("@agex-ts/world").ToolOutput>}
 */
async function runTest(session, args) {
    const ws = session.ws;
    if (ws === null) return { text: "the session isn't open", images: [], isError: true };
    const actions = Array.isArray(args.actions) ? args.actions : [];
    const { standIns, errors } = parseStandIns(args.standIns);
    if (errors.length > 0) return { text: errors.join("\n"), images: [], isError: true };
    if (args.live === true && standIns.length > 0) {
        return { text: "standIns are for a hidden test: live acts on the preview the person is looking at, with its real services; test without live", images: [], isError: true };
    }
    /** @type {any[]} */
    let results;
    try {
        if (args.live === true && session.delegate) {
            return { text: "live: true acts on the preview the person is looking at, which shows the session that asked you, not your app: test without live", images: [], isError: true };
        }
        if (args.live === true) {
            // files just written: the preview rebuilds from them first
            await whenLiveSettled();
            const iframe = getLiveIframe();
            if (iframe === null) {
                return { text: "the preview isn't open: the person has to show it for live: true; test without live instead", images: [], isError: true };
            }
            results = await runLiveApp({ iframe, actions });
        } else {
            const app = await readApp(ws);
            if (!hasApp(app)) {
                return { text: "there is no app yet: write /workspace/app/index.html (or app/main.js) first", images: [], isError: true };
            }
            /** Who the app is, for asking: in a hidden test, nobody is asked. */
            const asker = async () => {
                const { studio } = await import("./studio.svelte.js");
                const ask = (studio.sessions.find((x) => x.name === session.name)?.source ?? null) !== null;
                return { ask, appKey: studio.appKey(session.name), needs: parseNeeds(app.files[NEEDS_PATH] ?? null).needs };
            };
            /** The test's copy of the database, made on the app's first agex.db call. @type {Promise<import("@agex-ts/kvsql/client").DatabaseClient> | null} */
            let testDb = null;
            try {
                results = await runTestApp({
                    appFiles: app.files,
                    appBinaries: app.binaries,
                    actions,
                    appStorageSeed: args.fresh === true ? {} : readAppStorage(session.name),
                    // the page has its session's variables as window.env (a delegate's, its top session's)
                    buildAppPage: (/** @type {Record<string, string>} */ files, /** @type {any} */ opts) =>
                        buildAppPage(files, { ...opts, variables: liveVariables(session.name) }),
                    reseedAppPage,
                    cacheHandler: (/** @type {string} */ key) => ws.cache.get(key),
                    // the app's agent tasks run for real, on its session's meter
                    taskHandler: async (/** @type {{ spec: unknown, inputs: unknown }} */ call) => {
                        // an app from elsewhere runs here only once the person allowed it in the preview
                        return appAgent.call(session.name, call, { ...(await asker()), prompt: false });
                    },
                    // and its own agent's model calls, likewise
                    modelHandler: async (call, opts) => {
                        return appAgent.model(session.name, call, { ...(await asker()), prompt: false, ...opts });
                    },
                    // its requests with a secret use the app's grants; one
                    // with none fails rather than asks
                    grantFor: async (need) => {
                        const [{ studio }, { vault }] = await Promise.all([import("./studio.svelte.js"), import("./vault.svelte.js")]);
                        return vault.valueFor(studio.appKey(session.name), need);
                    },
                    standIns,
                    dbHandler: () => (testDb ??= appDbs.testDb(session.name, { empty: args.fresh === true })),
                    viewport: /** @type {any} */ (args.viewport) ?? null,
                });
            } finally {
                // gone with the test: deleting removes its file
                void testDb?.then((db) => db.delete()).catch((e) => console.warn("agex.db: deleting a test's copy failed:", e));
            }
        }
    } catch (e) {
        // a failed action ends the call, with what came before it
        const message = errorText(e);
        const before = /** @type {any} */ (e)?.results;
        if (!Array.isArray(before) || before.length === 0) return { text: message, images: [], isError: true };
        const out = await formatResults(before);
        return { text: `${out.text}\n${message}`, images: out.images, isError: true };
    }
    return formatResults(results);
}

/**
 * The results as the model reads them, screenshots attached as images:
 * each on its own, or a grid's frames tiled into one image at the end
 * (by `tile`; frames past `GRID_MAX` are left out, and said so). Soft
 * asserts that failed are counted at the end, and make the result an
 * error. An eval with a label shows the label in place of its code.
 *
 * @param {any[]} results
 * @param {{ tile?: (frames: { data: string, label: string }[]) => Promise<string> }} [opts]
 * @returns {Promise<import("@agex-ts/world").ToolOutput>}
 */
export async function formatResults(results, { tile = tileGrid } = {}) {
    /** @type {string[]} */
    const lines = [];
    /** @type {{ data: string, format: "png" }[]} */
    const images = [];
    /** The grids' frames, by name, in the order each grid began. */
    /** @type {Map<string, { data: string, label: string }[]>} */
    const grids = new Map();
    let softFailed = 0;
    for (const r of results) {
        const named = r?.type === "eval" && typeof r.label === "string" ? `[${r.label}]` : null;
        if (r?.type === "log") {
            lines.push(`[${r.level}] ${shown(r.message)}`);
        } else if (r?.type === "eval" && r.error) {
            lines.push(`eval ${named ?? shown(r.expr, 200)} threw: ${shown(r.error)}`);
        } else if (r?.type === "eval") {
            lines.push(`eval ${named ?? shown(r.expr, 200)} → ${shown(r.value)}`);
        } else if (r?.type === "assert" && r.soft === true) {
            softFailed += 1;
            lines.push(`soft assert failed: ${shown(r.message)}`);
        } else if (r?.type === "reload") {
            lines.push(String(r.message));
        } else if (r?.type === "read") {
            lines.push(`read ${r.selector} → ${shown(r.value)}`);
        } else if (r?.type === "screenshot" && !(typeof r.data === "string" && r.data !== "")) {
            lines.push(`screenshot failed: ${shown(r.error ?? "no image")}`);
        } else if (r?.type === "screenshot" && typeof r.grid === "string") {
            const frames = grids.get(r.grid) ?? [];
            grids.set(r.grid, frames);
            const label = typeof r.label === "string" ? r.label : "";
            if (frames.length < GRID_MAX) {
                frames.push({ data: r.data, label });
                lines.push(`screenshot: grid ${r.grid}, frame ${frames.length}${label ? ` (${label})` : ""}`);
            } else {
                lines.push(`screenshot: grid ${r.grid} is full (${GRID_MAX} frames): this one${label ? ` (${label})` : ""} is left out`);
            }
        } else if (r?.type === "screenshot") {
            images.push({ data: r.data, format: "png" });
            lines.push(`screenshot ${images.length}: attached`);
        } else {
            lines.push(shown(r));
        }
    }
    for (const [name, frames] of grids) {
        const labels = frames.map((f, i) => `${i + 1} ${f.label}`.trim()).join(" · ");
        try {
            images.push({ data: await tile(frames), format: "png" });
            lines.push(`grid ${name}: ${frames.length} frame${frames.length === 1 ? "" : "s"} (${labels}), attached as image ${images.length}`);
        } catch (e) {
            // a grid that couldn't be drawn still shows its frames, one by one
            for (const f of frames) images.push({ data: f.data, format: "png" });
            lines.push(`grid ${name}: couldn't be tiled (${errorText(e)}): its ${frames.length} frames attached one by one`);
        }
    }
    if (softFailed > 0) {
        lines.push(`${softFailed} soft assert${softFailed === 1 ? "" : "s"} failed`);
    }
    return {
        text: lines.length === 0 ? "(no console output, and no action gave a result)" : lines.join("\n"),
        images,
        isError: softFailed > 0,
    };
}
