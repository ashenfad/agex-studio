/**
 * The `test_app` tool: the agent checks its app by acting on it, in a
 * hidden test iframe built from the files under `app/` now, or (`live`)
 * in the preview the person is looking at.
 *
 * A screenshot comes back as an image in the same result, so a model
 * that sees images looks at it on its next call.
 */

import { buildAppPage } from "./app-html.js";
import { readApp, hasApp } from "./app-files.js";
import { getLiveIframe, runLiveApp, runTestApp } from "./app-control.js";
import { read as readAppStorage } from "./app-storage.js";
import { appAgent } from "./app-tasks.svelte.js";
import { GRID_MAX, tileGrid } from "./grid.js";

/** What the model reads of a value: JSON, cut at `max` characters. */
const shown = (/** @type {unknown} */ value, max = 4000) => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text === undefined ? String(value) : text.length > max ? `${text.slice(0, max)}… (${text.length} chars)` : text;
};

export const TEST_APP_DESCRIPTION = `Check the app under /workspace/app by acting on it in a browser.

By default it runs in a fresh hidden iframe built from the app's files as they are now (its storage seeded from the person's, writes discarded). With live: true it acts on the preview the person is looking at instead.

actions: a list of plain objects, run in order:
- {click: "#sel"} · {type: "#sel", value: "text"} · {select: "#sel", value: "opt"} · {wait: 500}
- {read: "#sel"} or {read: "#sel", prop: "value"}: textContent, or a property
- {eval: "expr"}: a JS expression in the app's page; a Promise is awaited
- {assert: "expr", message: "..."}: a failing assertion ends the call with an error
- {screenshot: true} or {screenshot: "#sel"}: a PNG, attached to this result
- {screenshot: true | "#sel", grid: "name", label: "1.5s title"}: held, and every frame of a grid comes back tiled into ONE captioned image at the end (also when an assert fails); up to ${GRID_MAX} frames a grid. Use it to check several states (scenes, steps) for the cost of one image
- {viewport: "mobile" | "tablet" | "desktop" | {width, height}}: resize (not live)

viewport sets the hidden iframe's starting size (default 800x600); fresh: true starts it with empty storage.
The result lists the app's console output, then each action's result.`;

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
            },
        },
        async call(args) {
            const ws = session.ws;
            if (ws === null) return { text: "the session isn't open", images: [], isError: true };
            const actions = Array.isArray(args.actions) ? args.actions : [];
            /** @type {any[]} */
            let results;
            try {
                if (args.live === true && session.delegate) {
                    return { text: "live: true acts on the preview the person is looking at, which shows the session that asked you, not your app: test without live", images: [], isError: true };
                }
                if (args.live === true) {
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
                    results = await runTestApp({
                        appFiles: app.files,
                        appBinaries: app.binaries,
                        actions,
                        appStorageSeed: args.fresh === true ? {} : readAppStorage("ts", session.name),
                        buildAppPage,
                        cacheHandler: (/** @type {string} */ key) => ws.cache.get(key),
                        // the app's agent tasks run for real, counted in its session's budget
                        taskHandler: async (/** @type {{ spec: unknown, inputs: unknown }} */ call) => {
                            // an app from elsewhere runs here only once the person allowed it in the preview
                            const { studio } = await import("./studio.svelte.js");
                            const imported = (studio.sessions.find((x) => x.name === session.name)?.source ?? null) !== null;
                            return appAgent.call(session.name, call, { ask: imported, prompt: false });
                        },
                        viewport: /** @type {any} */ (args.viewport) ?? null,
                    });
                }
            } catch (e) {
                // a failing assertion ends the call, with what came before it
                const message = e instanceof Error ? e.message : String(e);
                const before = /** @type {any} */ (e)?.results;
                if (!Array.isArray(before)) return { text: message, images: [], isError: true };
                const out = await formatResults(before);
                return { text: `${out.text}\n${message}`, images: out.images, isError: true };
            }
            return formatResults(results);
        },
    };
}

/**
 * The results as the model reads them, screenshots attached as images:
 * each on its own, or a grid's frames tiled into one image at the end
 * (by `tile`; frames past `GRID_MAX` are left out, and said so).
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
    for (const r of results) {
        if (r?.type === "log") {
            lines.push(`[${r.level}] ${shown(r.message)}`);
        } else if (r?.type === "eval" && r.error) {
            lines.push(`eval ${shown(r.expr, 200)} threw: ${shown(r.error)}`);
        } else if (r?.type === "eval") {
            lines.push(`eval ${shown(r.expr, 200)} → ${shown(r.value)}`);
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
            lines.push(`grid ${name}: couldn't be tiled (${e instanceof Error ? e.message : String(e)}): its ${frames.length} frames attached one by one`);
        }
    }
    return {
        text: lines.length === 0 ? "(no console output, and no action gave a result)" : lines.join("\n"),
        images,
        isError: false,
    };
}
