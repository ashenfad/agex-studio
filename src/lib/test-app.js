/**
 * The `test_app` tool: the agent checks its app by acting on it, in a
 * hidden test iframe built from the files under `app/` now, or (`live`)
 * in the preview the person is looking at.
 *
 * A screenshot comes back as an image in the same result, so a model
 * that sees images looks at it on its next call.
 */

import { buildAppHtml } from "./app-html.js";
import { readApp, hasApp } from "./app-files.js";
import { getLiveIframe, runLiveApp, runTestApp } from "./app-control.js";
import { read as readAppStorage } from "./app-storage.js";

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
                        buildAppHtml,
                        cacheHandler: (/** @type {string} */ key) => ws.cache.get(key),
                        viewport: /** @type {any} */ (args.viewport) ?? null,
                    });
                }
            } catch (e) {
                // a failing assertion ends the call
                return { text: e instanceof Error ? e.message : String(e), images: [], isError: true };
            }
            return formatResults(results);
        },
    };
}

/**
 * The results as the model reads them, screenshots attached as images.
 *
 * @param {any[]} results
 * @returns {import("@agex-ts/world").ToolOutput}
 */
export function formatResults(results) {
    /** @type {string[]} */
    const lines = [];
    /** @type {{ data: string, format: "png" }[]} */
    const images = [];
    for (const r of results) {
        if (r?.type === "log") {
            lines.push(`[${r.level}] ${shown(r.message)}`);
        } else if (r?.type === "eval" && r.error) {
            lines.push(`eval ${shown(r.expr, 200)} threw: ${shown(r.error)}`);
        } else if (r?.type === "eval") {
            lines.push(`eval ${shown(r.expr, 200)} → ${shown(r.value)}`);
        } else if (r?.type === "read") {
            lines.push(`read ${r.selector} → ${shown(r.value)}`);
        } else if (r?.type === "screenshot") {
            if (typeof r.data === "string" && r.data !== "") {
                images.push({ data: r.data, format: "png" });
                lines.push(`screenshot ${images.length}: attached`);
            } else {
                lines.push(`screenshot failed: ${shown(r.error ?? "no image")}`);
            }
        } else {
            lines.push(shown(r));
        }
    }
    return {
        text: lines.length === 0 ? "(no console output, and no action gave a result)" : lines.join("\n"),
        images,
        isError: false,
    };
}
