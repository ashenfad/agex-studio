/**
 * Studio-side helpers for the agex-ts kernel — the equivalent of
 * `agent.js` for Pyodide / agex-py.
 *
 * Two responsibilities:
 *
 *   1. Agent lifecycle: `initAgent(settings)` constructs the
 *      `agex-ts` `Agent` with the studio's state / fs config and
 *      caches it as a module-level singleton. Re-init for settings
 *      changes is no-op for now (matches agex-py side; settings
 *      changes need a page reload until Phase 5 PR 2 wires re-init).
 *
 *   2. Branch-implicit helpers the TsKernelAdapter wraps: VFS reads
 *      and writes against the active branch, history rendering,
 *      token telemetry computation, etc. Mirrors the per-function
 *      shape of `agent.js` so the adapter's call sites parallel
 *      `py-kernel-adapter.js` line-for-line.
 *
 * **Phase 5 PR 1 scope (this commit).** Chat task, LLM client,
 * runtime adapter, and skill registration are deliberately not
 * wired — those land in PR 2 alongside the TS chat primer and
 * skill set. Adapter methods that depend on them (`sendMessage`,
 * `runChaptering`, `runQuery`) throw `not yet implemented`.
 * Everything else (branch ops, VFS, bundle, history, telemetry)
 * is real.
 */

import { createAgent } from "agex-ts";
import { Anthropic } from "@agex-ts/anthropic";
import { OpenAI } from "@agex-ts/openai";
import { workerRuntime } from "@agex-ts/runtime-worker";
// Bundled worker URL. The `?worker&url` query asks vite to treat
// `dist/worker.js` as a worker entry point — it bundles all the
// worker's imports (`agex-ts/wrap-fs`, sibling chunks) into a
// single self-contained file and gives us back the hashed URL.
// Without this, vite just copies the raw worker source into dist,
// leaving its bare imports unresolvable in the browser — which
// surfaces in prod as "worker failed during boot" the first time
// the runtime tries to execute an emission. Dev never trips this
// because vite's dev server resolves bare specifiers on the fly.
import _agexWorkerUrl from "@agex-ts/runtime-worker/worker?worker&url";
import _chatPrimer from "./primers/ts-chat-task.md?raw";
import _numericalSkill from "./skills/numerical.md?raw";
import _interactiveAppSkill from "./skills/interactive-app.md?raw";
import { resolveBaseUrl, resolveProvider } from "./settings.js";
import { extrasFor, supportsServiceTier } from "./models.js";
import {
    runTestApp as appControlRunTestApp,
    runLiveApp as appControlRunLiveApp,
    getLiveIframe as appControlGetLiveIframe,
} from "./app-control.js";
import { buildAppHtml } from "./pyodide.js";
import { read as readAppStorage } from "./app-storage.js";
import { runEsbuildCommand } from "./esbuild-terminal.js";
import { search as runSearchHelper } from "./search.js";
import {
    renderPdfPagesToBytes,
    getPdfPageCount,
} from "./pdf-render.js";
import { isBinaryAppFile } from "./app-assets.js";
import {
    emitObservations,
    normalizeEvalValues,
} from "./ts-result-helpers.js";
import {
    synthesizeAction,
    serializeOutputParts,
    splitOutputEvents,
    serializeChapterEvents,
} from "./ts-event-translator.js";
import { normalizeChatResponse } from "./ts-chat-response.js";

/**
 * @typedef {import('agex-ts').Agent} Agent
 * @typedef {import('agex-ts').LLMClient} LLMClient
 * @typedef {import('@agex-ts/kvgit').VersionedKV} VersionedKV
 * @typedef {import('./kernel-adapter.js').KernelSettings} KernelSettings
 * @typedef {import('./kernel-adapter.js').BranchMeta} BranchMeta
 */

const SESSION = "default";

// `esbuild-bridge.js` is a sibling module — vite emits it as its
// own code-split chunk, so the dynamic `import()` in the terminal
// handler below pays nothing until the agent first runs `esbuild`.
// The py kernel imports the same module via its vite-resolved URL
// (forwarded into the worker via the `init` postMessage from
// `pyodide.js`), so both kernels share one source of truth.

/** Per-task iteration cap. agex-ts default is lower; chat-driven app
 *  building can legitimately need more turns (write file → bundle →
 *  testApp → fix → re-test → ...) and the user can interrupt via the
 *  cancel button anyway, so we lift the cap. */
const MAX_ITERATIONS = 40;

/** Default chaptering trigger when settings.chapteringTrigger is unset.
 *  Mirrors the value the studio's Py side passes. Big enough to avoid
 *  thrashing for short conversations; well below typical context
 *  windows so multi-turn sessions actually fold. */
const DEFAULT_CHAPTERING_TRIGGER = 100_000;

const META_KEYS = /** @type {const} */ ({
    title: "__session_title__",
    name: "__session_name__",
    description: "__session_description__",
    updated: "__session_updated__",
    kernel: "__session_kernel__",
    external: "__session_external__",
});

/** @type {Agent | null} */
let _agent = null;

/** @type {((message: string, opts?: import('agex-ts/types').TaskCallOptions) => Promise<string>) | null} */
let _chatTask = null;

/** Module-level cache of the active branch — avoids redundant
 *  `versioned.switchBranch(...)` calls when the caller is operating
 *  on the same branch repeatedly. The adapter's `_ensureBranch`
 *  reads/writes this. */
let _activeBranch = /** @type {string | null} */ (null);

/**
 * Construct (or reuse) the agex-ts Agent for the studio.  Idempotent
 * for the lifetime of the page — the second caller's settings are
 * ignored.
 *
 * @param {KernelSettings} settings
 */
export async function initAgent(settings) {
    // Already-constructed agent: hot-swap the safe-to-mutate fields
    // (LLM client, chaptering trigger) and bail. The runtime / state /
    // fs are deliberately not in `reconfigure`'s surface — mutating
    // those mid-session would orphan workers or break substrate
    // invariants. Settings the user can change at runtime (model,
    // API key, baseUrl, provider, chaptering threshold) all flow
    // through `_buildLlmClient` + `chapteringTrigger`.
    if (_agent) {
        _agent.reconfigure({
            llm: _buildLlmClient(settings),
            chapteringTrigger:
                typeof settings.chapteringTrigger === "number"
                    ? settings.chapteringTrigger
                    : DEFAULT_CHAPTERING_TRIGGER,
            maxIterations: MAX_ITERATIONS,
        });
        return;
    }
    const llm = _buildLlmClient(settings);
    const runtime = workerRuntime({
        // Hand vite-bundled worker URL through explicitly. The
        // runtime would otherwise fall back to its own
        // `new URL('./worker.js', import.meta.url)` which only
        // resolves against the *vendored* worker file — vite
        // copies that file as-is into dist with its bare
        // `agex-ts/wrap-fs` imports unresolved, so the worker
        // 404s during boot in production. The `?worker&url`
        // import above gives us a self-contained bundled worker.
        workerUrl: _agexWorkerUrl,
        //
        // Per-emission wall-clock budget. The default 5s is too
        // tight for studio agents: a single `await testApp(...)`
        // covers iframe creation + script load (Plotly etc. on
        // cold cache routinely takes 3–8s), and `await
        // search(..., {deep: true})` can run 10–30s on multi-step
        // queries. Bumping to 60s gives those room without
        // letting genuine infinite loops hang the worker — the
        // user can always hit the chat-UI cancel for shorter
        // exits via the AbortSignal we plumb through.
        timeoutMs: 60_000,
    });
    _agent = await createAgent({
        name: "chat",
        primer: "You are a helpful assistant.",
        llm,
        runtime,
        state: { type: "versioned", storage: "indexeddb" },
        fs: { type: "kvgit" },
        chapteringTrigger:
            typeof settings.chapteringTrigger === "number"
                ? settings.chapteringTrigger
                : DEFAULT_CHAPTERING_TRIGGER,
        maxIterations: MAX_ITERATIONS,
        // Open-mode imports: any bare specifier the agent writes that
        // isn't in the registered namespace map (the explicit
        // `agent.namespace(...)` calls below) falls through to here
        // and gets routed to esm.sh. Direct URL imports pass through
        // as-is. Net effect: agents can `import x from 'd3'` for any
        // npm package without us needing to pre-declare it.
        //
        // Why this is fine in our threat model: agex-ts's interpreter
        // bounds what imported code can do (only registered host fns
        // are reachable; no fs / env / raw-fetch access). A
        // compromised library can return weird values but can't
        // exfil or escape the worker. CSP + CORS bound network reach
        // for anything the host fns might do downstream. Namespaces
        // in browser/worker aren't a security gate; they're a UX +
        // quality concern, and esm.sh handles ~all of npm cleanly.
        //
        // See namespaceResolver-v0.md for the full rationale.
        namespaceResolver: (specifier) => {
            if (
                specifier.startsWith("http://") ||
                specifier.startsWith("https://")
            ) {
                return specifier;
            }
            return `https://esm.sh/${specifier}`;
        },
    });

    // Pinned namespace registrations — take precedence over the
    // resolver. Useful as version-pinning hooks: today these resolve
    // to the same esm.sh URLs the resolver would return, but having
    // them as explicit registrations means we can pin to a known-
    // good version (e.g. `https://esm.sh/arquero@5.4.0`) if a future
    // release breaks something we depend on without affecting the
    // open-resolver fallback for everything else.
    _agent.namespace(
        { url: "https://esm.sh/apache-arrow" },
        { name: "apache-arrow" },
    );
    _agent.namespace(
        { url: "https://esm.sh/arquero" },
        { name: "arquero" },
    );

    // Cat-on-demand skills. Bundled at build time via vite's ?raw
    // loader; agex creates the `/skills/<name>/SKILL.md` VFS overlay
    // for `cat` access. Chaptering keeps these out of context when
    // not relevant.
    _agent.skill(_numericalSkill, { name: "numerical" });
    _agent.skill(_interactiveAppSkill, { name: "interactive-app" });

    // Chat task — `string | array | object`. Rich multi-part responses
    // are normalized at the adapter boundary (see `ts-chat-response.js`)
    // so the chat shell renders text / tables / Plotly charts inline.
    // The primer markdown lives alongside this file under primers/ and
    // is inlined at build time via vite's ?raw loader.
    _chatTask = _agent.task({
        description: "Answer the user's chat message.",
        primer: _chatPrimer,
    });

    // App-preview agent.fn registrations. Both call host-resident
    // orchestration in `app-control.js` directly (no worker round-trip
    // — agent.fn host-bound functions invoke from the worker but
    // execute on the main thread, where DOM access is fine).
    //
    // `testApp` builds a hidden iframe from the agent's app/ files,
    // runs optional UI actions, and returns console + result entries.
    // The iframe's `query()` bridge throws (TS adapter doesn't
    // implement runQuery) — apps that need agent data should use
    // `getCacheValue(key)` instead, which we wire in via cacheHandler.
    /** Compose the TS-side result post-processors that turn raw
     *  iframe-bridge output into what an agent-side caller wants:
     *
     *    1. `normalizeEvalValues` — parse eval-value JSON strings
     *       back to native JS (the bridge always JSON-stringifies
     *       for py-side `reprobate` compatibility).
     *    2. `emitObservations` — emit screenshot images + capture
     *       failures via `ctx.console.log` so they auto-flow as
     *       next-turn observations even when the agent discarded
     *       the return value.
     *
     *  Both helpers live in `ts-result-helpers.js` so they can be
     *  unit-tested independently of the rest of `initAgent`. */
    function _postProcessResults(ctx, results) {
        return emitObservations(ctx, normalizeEvalValues(results));
    }

    _agent.fn(
        async function testApp(...args) {
            // agex-ts appends `ctx` as the trailing positional arg
            // (per `wantsContext: true`). Since the agent may pass
            // 0–2 user args, declaring fixed positions for actions /
            // fresh would put ctx at the wrong index — pull it off
            // the end and slice the user args explicitly.
            const ctx = args[args.length - 1];
            const [actions, fresh] = args.slice(0, -1);
            const fs = await _agent.fs(SESSION);
            // Split the app/ dir into text files (HTML / JS / CSS / JSON
            // — passed as decoded strings) and binary assets (images /
            // fonts — passed as raw bytes). Decoding binaries as UTF-8
            // gives garbage strings that the iframe can't use; the
            // asset-rewriter in buildAppHtml needs raw bytes to produce
            // data URLs.
            /** @type {Record<string, string>} */
            const appFiles = {};
            /** @type {Record<string, Uint8Array>} */
            const appBinaries = {};
            const decoder = new TextDecoder("utf-8", { fatal: false });
            try {
                const entries = await fs.list("app/", { recursive: true });
                await Promise.all(
                    entries.map(async (rel) => {
                        const full = "app/" + rel;
                        try {
                            if (await fs.isFile(full)) {
                                const bytes = await fs.read(full);
                                if (isBinaryAppFile(full)) {
                                    appBinaries[full] = bytes;
                                } else {
                                    appFiles[full] = decoder.decode(bytes);
                                }
                            }
                        } catch {
                            // Skip files that vanish or fail mid-walk.
                        }
                    }),
                );
            } catch {
                // No `app/` dir yet — fall through with empty appFiles
                // so the orchestrator returns a clean "no app files"
                // entry rather than throwing.
            }
            let appStorageSeed = {};
            if (!fresh && _activeBranch) {
                appStorageSeed = readAppStorage("ts", _activeBranch);
            }
            const results = await appControlRunTestApp({
                appFiles,
                appBinaries,
                actions: actions ?? [],
                appStorageSeed,
                buildAppHtml,
                queryHandler: null, // TS adapter has no runQuery
                cacheHandler: (key) => getCacheValue(key),
            });
            return _postProcessResults(ctx, results);
        },
        {
            name: "testApp",
            wantsContext: true,
            description: [
                "(Pre-registered global — call directly with `await testApp(...)`, no import needed.)",
                "Build a hidden iframe from the agent's app/ files, run optional UI actions, return console + action results.",
                "Use to verify uncommitted app changes before taskSuccess.",
                "",
                "Signature: `testApp(actions?: Array<ActionDict>, fresh?: boolean): Promise<Array<ResultDict>>`",
                "",
                "NOT a Playwright/Puppeteer callback API — there is no `page` object. `actions` is a flat array of plain objects, each one of:",
                "  - `{ click: '#sel' }` — click an element",
                "  - `{ type: '#sel', value: 'text' }` — type into an input",
                "  - `{ select: '#sel', value: 'opt' }` — select an option",
                "  - `{ wait: 500 }` — wait N milliseconds",
                "  - `{ read: '#sel' }` — read element textContent",
                "  - `{ read: '#sel', prop: 'value' }` — read an element property",
                "  - `{ eval: 'document.querySelectorAll(\"li\").length' }` — evaluate a JS expression in the iframe, capture the result",
                "  - `{ assert: 'document.querySelector(\"#chart\")', message: 'chart rendered' }` — evaluate a JS expression as truthy/falsy. Passes are silent (no result entry); a failing assertion throws from `testApp`, which surfaces to your code as a thrown error and to the next agent turn as a recoverable error you can read and self-correct. Use this to gate `taskSuccess` on app correctness — just write the assertion and call `taskSuccess` next; if the assertion fails the throw bypasses success automatically.",
                "  - `{ screenshot: true }` (full document) or `{ screenshot: '#sel' }` (specific element) — capture a base64 PNG. **The image is auto-shipped to your next-turn observation** — no manual handling needed; just include the action and the rendered image appears in your context. Returned result entry's `data` is a sentinel; the actual base64 has already been emitted as an image observation.",
                "",
                "All values must be JSON-serializable — functions / closures will fail with DataCloneError. Use `eval` / `assert` actions for in-iframe JS.",
                "",
                "`fresh=true` skips seeding the iframe's app-storage from the persisted session (useful when iterating on first-load behavior).",
                "",
                "Returns an array mixing console logs (`{type: 'log', level, message}`) and action results — `{type: 'eval', expr, value}`, `{type: 'read', selector, value}`, `{type: 'screenshot', data}`. Note: eval/read results carry the result on `value`, not `data`; screenshot's `data` is the post-emit sentinel.",
            ].join("\n"),
        },
    );

    _agent.fn(
        async function liveApp(...args) {
            // Same rest-and-extract pattern as `testApp` — ctx is
            // the trailing arg per `wantsContext: true`.
            const ctx = args[args.length - 1];
            const [actions] = args.slice(0, -1);
            const results = await appControlRunLiveApp({
                iframe: appControlGetLiveIframe(),
                actions: actions ?? [],
            });
            return _postProcessResults(ctx, results);
        },
        {
            name: "liveApp",
            wantsContext: true,
            description: [
                "(Pre-registered global — call directly with `await liveApp(...)`, no import needed.)",
                "Interact with the live app preview the user sees (the LAST COMMITTED app/ files — uncommitted changes won't appear until taskSuccess).",
                "Use to read user-entered state, click UI elements, inspect DOM, etc. Use `testApp` instead to verify changes you've made this turn.",
                "",
                "Signature: `liveApp(actions?: Array<ActionDict>): Promise<Array<ResultDict>>`",
                "",
                "Same `actions` shape as `testApp` — flat array of `{click}` / `{type}` / `{read}` / `{eval}` / `{screenshot}` / etc. plain objects, all values JSON-serializable. Screenshots auto-flow as image observations to your next turn (no manual handling). NOT a Playwright/Puppeteer callback API.",
            ].join("\n"),
        },
    );

    // `search` host-bound fn — web search via OpenRouter's perplexity
    // models. Routed through the same OpenAI-compatible endpoint the
    // chat LLM uses; auth comes from the studio's settings store at
    // call time so settings changes (model swap, key rotation) are
    // picked up without re-init.
    //
    // Multiple in-flight host calls are supported by the runtime
    // bridge (each gets its own callId), so `Promise.all([search(a),
    // search(b), ...])` from the agent results in genuinely
    // concurrent fetches — same parallelism the py-side
    // `asyncio.gather(search(a), search(b), ...)` pattern unlocks.
    _agent.fn(runSearchHelper, {
        name: "search",
        description: [
            "(Pre-registered global — call directly with `await search(query)`, no import needed.)",
            "Web search via perplexity. Returns a text summary with cited source URLs inline.",
            "",
            "Signature: `search(query: string, deep?: boolean): Promise<string>`",
            "  - `query`: the question or search terms.",
            "  - `deep`: when `true`, uses the multi-step `sonar-pro-search` model for complex research; default is the single-shot `sonar`.",
            "",
            "**Run several in parallel with `Promise.all`** when you need to gather distinct topics — each search is an independent HTTP fetch and the runtime dispatches them concurrently:",
            "  ```ts",
            "  const [a, b, c] = await Promise.all([",
            "    search('topic A'),",
            "    search('topic B'),",
            "    search('topic C'),",
            "  ]);",
            "  ```",
            "Sequential `await search(...); await search(...); ...` works but is slower by exactly the search latency × N.",
        ].join("\n"),
    });

    // PDF helpers — render selected pages to PNG `Uint8Array`s. The
    // shared module in `pdf-render.js` does the actual pdf.js work
    // (same path the py kernel uses, just without the base64
    // round-trip the py worker needs). Returning `Uint8Array[]`
    // means the agent can `console.log(pages[0])` to surface a page
    // as an image observation directly — agex-ts's console-capture
    // detects PNG magic bytes and routes through the image pipeline.
    _agent.fn(
        async function renderPdf(bytes, pages = null, scale = 2) {
            return await renderPdfPagesToBytes(bytes, pages, scale);
        },
        {
            name: "renderPdf",
            description: [
                "(Pre-registered global — call directly with `await renderPdf(bytes)`, no import needed.)",
                "Render PDF pages to PNG images.",
                "",
                "Signature: `renderPdf(bytes: Uint8Array, pages?: number[] | null, scale?: number): Promise<Uint8Array[]>`",
                "  - `bytes`: PDF file bytes — typically `await fs.read('doc.pdf')`.",
                "  - `pages`: 0-based page indices to render. `null` (default) renders the first 20 pages.",
                "  - `scale`: pdf.js viewport scale factor (default `2` ≈ 144 DPI). Higher = sharper but larger.",
                "",
                "Returns one PNG `Uint8Array` per requested page, in the order you asked for them. Out-of-range page indices yield empty `Uint8Array` slots — check `.length` before using.",
                "",
                "**To view a page as an image**: `console.log(pages[0])` — agex-ts detects PNG magic bytes on `Uint8Array`s and routes through the image-observation pipeline so you can reason over the page contents.",
                "",
                "**To embed in the chat response**: return via `taskSuccess([\"Here's page 3:\", pages[0]])` — PNG `Uint8Array`s render as inline images in rich responses.",
            ].join("\n"),
        },
    );

    _agent.fn(
        async function pdfPageCount(bytes) {
            return await getPdfPageCount(bytes);
        },
        {
            name: "pdfPageCount",
            description: [
                "(Pre-registered global — call directly with `await pdfPageCount(bytes)`, no import needed.)",
                "Return the number of pages in a PDF.",
                "",
                "Signature: `pdfPageCount(bytes: Uint8Array): Promise<number>`",
                "  - `bytes`: PDF file bytes — typically `await fs.read('doc.pdf')`.",
                "",
                "Use before `renderPdf` when you need to know how many pages exist (e.g. to render the last page, or to pick a stride through a long doc).",
            ].join("\n"),
        },
    );

    // `esbuild` terminal command — bundles agent JSX/TSX/JS/TS app
    // sources into a runnable ES module via esbuild-wasm. The handler
    // dynamic-imports `./esbuild-bridge.js` (shared with the py
    // kernel; vite code-splits it into its own chunk) on first
    // invocation so cold-boot pays nothing for the ~10MB wasm;
    // subsequent invocations reuse the cached module + esbuild
    // instance for the worker lifetime.
    //
    // Note that `agent.terminal` registrations don't have a
    // `visibility` knob the way agex-py's `@agent.terminal(visibility=
    // "low")` does — the description ships in the agent's tool list
    // unconditionally. Kept short here, with the longer story in the
    // interactive-app skill.
    _agent.terminal(
        async (ctx) => {
            const { runEsbuild } = await import("./esbuild-bridge.js");
            await runEsbuildCommand(ctx, runEsbuild);
        },
        {
            name: "esbuild",
            description:
                "Bundle JSX/TSX/JS/TS source files under app/ and helpers/ into a single ES module. " +
                "Bare imports (react, @scope/pkg) stay external and are resolved by the iframe's import map; " +
                "local imports (./Chart.jsx) are bundled inline. Usage: `esbuild <entry> --outfile=<output> [--minify]`. " +
                "Run `esbuild --help` for details.",
        },
    );
}

/** Send a chat message through the registered chat task. The
 *  TsKernelAdapter's sendMessage wraps this with the branch-explicit
 *  signature; this helper is the studio-side entry point matching
 *  agent.js's `sendMessage(message, onToken)` shape. */
export async function chatMessage(message, opts = {}) {
    if (!_chatTask) {
        throw new Error("chat task not registered — call initAgent first");
    }
    return _chatTask(message, { session: SESSION, ...opts });
}

/** Construct the LLM client for the configured provider. The studio's
 *  settings shape (apiKey / model / provider / baseUrl /
 *  reasoningEffort / toolUseWireFormat) is already kernel-agnostic; we
 *  just translate to the right provider's options shape. */
function _buildLlmClient(settings) {
    // Wire-format provider auto-resolves in OpenRouter mode (Anthropic
    // models → anthropic shape so cache_control flows through). Custom
    // mode honors the explicit provider choice.
    const provider = resolveProvider(settings);
    const apiKey = settings.apiKey;
    const model = settings.model;
    // Viewer mode: no API key configured. Return a stub LLMClient so
    // the rest of `initAgent` (state, fs, host fns, namespaces, skills,
    // task registration) completes normally — a visitor opening a
    // published-artifact URL can read history, browse files, and
    // interact with the live app preview without configuring their
    // own provider. `complete()` throws if anything actually tries to
    // hit the LLM; the chat shell gates Send on `configured` so the
    // throw only fires for code paths that shouldn't run at all in
    // viewer mode (defense in depth).
    if (!apiKey) {
        return {
            complete: async function* () {
                throw new Error("LLM API key required");
            },
            dumpConfig: () => ({
                provider: provider || "openai",
                model: model || "",
                timeoutSeconds: 0,
            }),
        };
    }
    if (!model) {
        throw new Error("LLM model required");
    }
    const baseUrl = resolveBaseUrl(settings);
    const isOpenRouter = settings.accessMode === "openrouter";
    if (provider === "anthropic") {
        return new Anthropic({
            apiKey,
            model,
            ...(baseUrl ? { baseUrl } : {}),
            ...(isOpenRouter
                ? {
                      // OpenRouter's `/v1/messages` CORS allow-list
                      // rejects the `anthropic-version` header that
                      // @agex-ts/anthropic sends by default. `null` deletes
                      // it (per the headers contract). Attribution
                      // headers (`http-referer` / `x-title`) match
                      // what the OpenAI branch sends so Anthropic
                      // calls show up as "Agex Studio" in the
                      // OpenRouter dashboard instead of "unknown".
                      headers: {
                          "anthropic-version": null,
                          "http-referer": "https://agex.studio",
                          "x-title": "Agex Studio",
                      },
                      // Pin to Anthropic-direct so prompt-cache hits
                      // are consistent across turns. Without this,
                      // OpenRouter may route to Bedrock / Vertex on
                      // some turns; each backend has its own separate
                      // cache, so turn-N cache lookups against
                      // turn-(N-1)'s write would miss.
                      extras: { provider: { only: ["anthropic"] } },
                  }
                : {}),
        });
    }
    // openai / openai-compatible (OpenRouter, local servers, etc.)
    // Per-model `extras` (e.g. provider routing pins) only make
    // sense against OpenRouter — direct OpenAI ignores `provider`,
    // and local servers wouldn't recognize it either.
    const modelExtras = { ...(isOpenRouter ? extrasFor(model) : {}) };
    // Layer in the user's service-tier choice when the (mode,
    // provider, model) combo supports it. `standard` means "omit
    // the field entirely" — sending the literal string would pin
    // us to a tier we'd otherwise auto-route past. Only `flex` and
    // `priority` get forwarded.
    if (
        (settings.serviceTier === "flex" || settings.serviceTier === "priority") &&
        supportsServiceTier(settings.accessMode, "openai", model)
    ) {
        modelExtras.service_tier = settings.serviceTier;
    }
    return new OpenAI({
        apiKey,
        model,
        ...(baseUrl ? { baseUrl } : {}),
        // OpenRouter attribution headers — surface the studio in the
        // OpenRouter analytics dashboard and earn fairer rate-limit
        // weighting on free models. Mirrors the py side's
        // `app_url` / `app_title` injection in agent.js.
        ...(isOpenRouter
            ? {
                  headers: {
                      "http-referer": "https://agex.studio",
                      "x-title": "Agex Studio",
                  },
              }
            : {}),
        ...(Object.keys(modelExtras).length > 0 ? { extras: modelExtras } : {}),
    });
}

/** Module-internal accessor.  Throws if `initAgent` hasn't run yet. */
export function _getAgent() {
    if (!_agent) {
        throw new Error("agex-ts kernel not initialized — call initAgent first");
    }
    return _agent;
}

/** Read the underlying @agex-ts/kvgit `Staged` for the studio's pinned
 *  default session. HEAD-movers (`switchBranch`, `resetTo`, `refresh`)
 *  must go through Staged so its read cache is invalidated — direct
 *  reach-through to `staged.versioned.switchBranch(...)` would leave
 *  Staged's per-key cache holding stale data from the prior branch. */
async function _getStaged() {
    const agent = _getAgent();
    const state = await agent.state(SESSION);
    return /** @type {import('@agex-ts/kvgit').Staged} */ (
        /** @type {import('agex-ts/state').KvgitState} */ (state).staged
    );
}

/** Switch kvgit's current branch if not already there. Mirrors the
 *  PyKernelAdapter's _ensureBranch pattern; cached so repeat calls
 *  on the same branch are zero-op. */
async function _ensureBranch(branch) {
    if (_activeBranch === branch) return;
    const staged = await _getStaged();
    if (staged.currentBranch !== branch) {
        await staged.switchBranch(branch);
    }
    _activeBranch = branch;
}

/** Invalidate the cached active-branch — call when an external
 *  operation (like `versioned.deleteBranch` or `resetTo`) may have
 *  changed kvgit's current_branch out from under us. */
function _invalidateActiveBranch() {
    _activeBranch = null;
}

// ---------------------------------------------------------------------------
// Branch operations
// ---------------------------------------------------------------------------

export async function listBranches() {
    const staged = await _getStaged();
    const all = await staged.listBranches();
    return all.filter((b) => b.startsWith("chat-"));
}

export async function listBranchesWithMeta() {
    const staged = await _getStaged();
    const all = await staged.listBranches();
    // staged.peek returns the already-decoded value (T | undefined),
    // using the same encoder/decoder pair the underlying state was
    // built with — so a `state.set(key, "string-value")` write round-
    // trips back as a string here without manual JSON unwrap.
    const peekStr = async (branch, key) => {
        const v = await staged.peek(key, { branch });
        return typeof v === "string" ? v : "";
    };
    const peekBool = async (branch, key) => {
        const v = await staged.peek(key, { branch });
        return Boolean(v);
    };
    // Fan out the per-branch peeks. Each peek is one IDB read, and on
    // worker-backed substrates that's a cross-thread round-trip too —
    // serializing N branches × 5 fields visibly stalls the drawer for
    // sessions with more than a handful of branches.
    return Promise.all(
        all
            .filter((b) => b.startsWith("chat-"))
            .map(async (branch) => ({
                branch,
                title:
                    (await peekStr(branch, META_KEYS.title)) || "New Chat",
                name: await peekStr(branch, META_KEYS.name),
                description: await peekStr(branch, META_KEYS.description),
                updated: await peekStr(branch, META_KEYS.updated),
                external: await peekBool(branch, META_KEYS.external),
            })),
    );
}

export async function createBranch(name, opts = {}) {
    const agent = _getAgent();
    const staged = await _getStaged();
    if (opts.from) {
        // Fork-from semantics: switch to opts.from so the new branch
        // is created off its HEAD. Matches agex-py forkSession
        // (createBranch with no `at=` forks from current).
        await staged.switchBranch(opts.from);
        await staged.createBranch(name);
    } else {
        // `initialCommit` is a sync accessor over an async parent-chain
        // walk; first-call must `await initial()` to populate the cache.
        // TODO(@agex-ts/kvgit): if Staged grows an `initial()` analog, drop
        // the versioned reach-through here.
        const initialCommit = await staged.versioned.initial();
        await staged.createBranch(name, { at: initialCommit });
    }
    await staged.switchBranch(name);
    _activeBranch = name;

    const state = await agent.state(SESSION);
    state.set(META_KEYS.updated, new Date().toISOString());
    state.set(META_KEYS.kernel, "ts");
    await agent.commit(SESSION);
}

/** Prefixes the studio considers "agent memory" — the keys
 *  `wipeAgentMemory` tombstones. The VFS file blobs (`f:` / `d:`
 *  prefixes via @agex-ts/termish kvgit-fs) and the session meta
 *  keys (`__session_*__`) are deliberately not in this list: a
 *  memory wipe clears the conversation context while keeping the
 *  workspace and session identity intact. */
const AGENT_MEMORY_PREFIXES = ["evt/", "cache/"];
const AGENT_MEMORY_EXACT_KEYS = ["__event_log__", "__subtasks__"];

/** Predicate used by `wipeAgentMemory` to decide which kvgit keys
 *  to tombstone. Exported with the underscore-prefix convention
 *  because it's an internal contract — but pinned with tests
 *  since the categorization is easy to get wrong (e.g.
 *  accidentally treating `f:` as memory would wipe the VFS too). */
export function _isAgentMemoryKey(key) {
    if (AGENT_MEMORY_EXACT_KEYS.includes(key)) return true;
    return AGENT_MEMORY_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * Drop every "agent memory" key on `branch` — event log, cache,
 * and the sub-task registry — while leaving the VFS file blobs
 * and session meta intact.
 *
 * Exposed as an adapter primitive (toward a future "soft wipe in
 * place" feature) — it currently has no caller in the fork path.
 * The fresh-chat fork (`sessions.forkSessionFreshChat`) instead
 * squashes: it reads the source's VFS files and rewrites them onto
 * a fresh empty branch, so there are no agent-memory keys to wipe.
 *
 * Idempotent. No-op when the branch's memory keys are already
 * absent (e.g. fresh branch from initial commit). Switches branches
 * temporarily if `branch` isn't current, restoring on the way out.
 *
 * @param {string} branch
 */
export async function wipeAgentMemory(branch) {
    const staged = await _getStaged();
    const cur = staged.currentBranch;
    const switched = branch !== cur;
    if (switched) {
        await staged.switchBranch(branch);
        _activeBranch = branch;
    }
    try {
        // Walk all keys once. Per-key delete is cheap (in-memory
        // staged-buffer set add); the cost is the keys iteration.
        // For sessions with thousands of events this is still
        // milliseconds — the iteration's the same shape backups,
        // chaptering, and the existing keys-walks already use.
        const victims = [];
        for await (const k of staged.keys()) {
            if (_isAgentMemoryKey(k)) victims.push(k);
        }
        if (victims.length === 0) return; // already clean
        for (const k of victims) staged.delete(k);
        await _getAgent().commit(SESSION);
    } finally {
        if (switched) {
            await staged.switchBranch(cur);
            _activeBranch = cur;
        }
    }
}

export async function deleteBranch(name) {
    const staged = await _getStaged();
    if (staged.currentBranch === name) {
        // Adapter's contract: the adapter falls back to another
        // chat- branch internally so subsequent ops don't trip on
        // a missing active branch. Shell decides what to render.
        const others = (await staged.listBranches()).filter(
            (b) => b.startsWith("chat-") && b !== name,
        );
        if (others.length > 0) {
            // Pick whichever; shell will redirect via switchSession
            // immediately afterwards.
            await staged.switchBranch(others[0]);
        } else {
            // No other chat- branches; switch to anything else.
            const all = (await staged.listBranches()).filter(
                (b) => b !== name,
            );
            if (all.length > 0) {
                await staged.switchBranch(all[0]);
            }
        }
    }
    await staged.deleteBranch(name);
    // Reclaim storage from the now-orphan commits / blobs / HAMT
    // nodes. `staged.deleteBranch` only removes the HEAD pointer;
    // without this sweep, every session a user ever deletes leaves
    // its full content footprint in IDB, growing unbounded until
    // they hit Chrome's quota. `minAge: 0` is safe here because an
    // explicit user-initiated delete is single-tab in practice;
    // see commit message for the trade-off.
    try {
        await staged.versioned.cleanOrphans({ minAge: 0 });
    } catch (e) {
        // Non-fatal: the delete itself succeeded. A failed sweep
        // just means orphans linger until the next successful sweep
        // (next delete, or a future startup-time pass).
        console.warn("[deleteBranch] cleanOrphans failed:", e);
    }
    _invalidateActiveBranch();
}

export async function readBranchMeta(name) {
    const staged = await _getStaged();
    /** @param {string} key */
    const peekStr = async (key) => {
        const v = await staged.peek(key, { branch: name });
        return typeof v === "string" ? v : "";
    };
    /** @param {string} key */
    const peekBool = async (key) => {
        const v = await staged.peek(key, { branch: name });
        return Boolean(v);
    };
    return /** @type {BranchMeta} */ ({
        title: (await peekStr(META_KEYS.title)) || "New Chat",
        name: await peekStr(META_KEYS.name),
        description: await peekStr(META_KEYS.description),
        updated: await peekStr(META_KEYS.updated),
        external: await peekBool(META_KEYS.external),
    });
}

export async function writeBranchMeta(name, patch) {
    const agent = _getAgent();
    const staged = await _getStaged();
    const cur = staged.currentBranch;
    const switched = name !== cur;
    if (switched) await staged.switchBranch(name);
    try {
        const state = await agent.state(SESSION);
        if (patch.title !== undefined) state.set(META_KEYS.title, patch.title);
        if (patch.name !== undefined) state.set(META_KEYS.name, patch.name);
        if (patch.description !== undefined) state.set(META_KEYS.description, patch.description);
        if (patch.external !== undefined) state.set(META_KEYS.external, patch.external);
        // Always bump `updated` alongside any other write so the
        // session-list ordering reflects the edit.
        state.set(
            META_KEYS.updated,
            patch.updated ?? new Date().toISOString(),
        );
        await agent.commit(SESSION);
    } finally {
        if (switched) {
            await staged.switchBranch(cur);
            _activeBranch = cur;
        } else {
            _activeBranch = name;
        }
    }
}

// ---------------------------------------------------------------------------
// State / commits
// ---------------------------------------------------------------------------

export async function getCurrentCommit() {
    const agent = _getAgent();
    const state = await agent.state(SESSION);
    return state.currentCommit ?? null;
}

/** Flush the active session's pending state writes to kvgit. agex-ts
 *  doesn't auto-commit anywhere — `task.ts` writes events into the
 *  Staged buffer via `eventLog.add()` and re-throws on abort without
 *  flushing. The host is responsible for committing both successful
 *  and cancelled turns; otherwise the events vanish on the next
 *  reload (only side-effect ops like uploads, which commit on their
 *  own, accidentally salvage them). Idempotent — committing with no
 *  staged changes is a no-op. */
export async function commitSession() {
    const agent = _getAgent();
    await agent.commit(SESSION);
}

export async function undoToCommit(hash) {
    const staged = await _getStaged();
    // staged.resetTo clears Staged's read cache + buffered writes on
    // success, so reads after the rewind see the post-reset state.
    await staged.resetTo(hash);
    _invalidateActiveBranch();
}

// ---------------------------------------------------------------------------
// VFS
// ---------------------------------------------------------------------------

export async function listFiles() {
    const agent = _getAgent();
    const fs = await agent.fs(SESSION);
    const all = await fs.list(undefined, { recursive: true });
    // Filter to actual files (list returns dirs too with isDir=true
    // entries in the listDetailed path). `list` returns paths only;
    // @agex-ts/termish's MountFS list filters by what backing reports, so
    // overlay-aware. Filter explicitly so the shell doesn't see
    // overlay infrastructure paths.
    // Skip /chapters and /skills overlay roots — those are
    // synthesized read-only mounts; the shell wants the agent's
    // actual VFS entries. `isFile` is per-path round-trip; fan out.
    const checked = await Promise.all(
        all.map(async (path) => {
            if (path.startsWith("chapters/") || path.startsWith("skills/")) {
                return null;
            }
            return (await fs.isFile(path)) ? path : null;
        }),
    );
    return checked.filter((p) => p !== null).sort();
}

export async function readFile(path) {
    const agent = _getAgent();
    const fs = await agent.fs(SESSION);
    return fs.read(path);
}

export async function fileSize(path) {
    const agent = _getAgent();
    const fs = await agent.fs(SESSION);
    const stat = await fs.stat(path);
    return stat.size;
}

export async function writeFiles(files) {
    const agent = _getAgent();
    const fs = await agent.fs(SESSION);
    // Ensure each unique parent directory exists before writing.
    // kvgit-fs `write` requires `dirname(path)` to be present (no
    // implicit auto-mkdir) — uploads at the root never hit this,
    // but writes into nested paths (e.g. `app/characters/img.png`
    // during a squash fork from a session that organized files
    // by subdir) need explicit mkdir-p. Sorting by depth and
    // deduping keeps it O(unique-dirs) instead of O(files).
    const parents = new Set();
    for (const path of Object.keys(files)) {
        const slashIdx = path.lastIndexOf("/");
        if (slashIdx > 0) parents.add(path.slice(0, slashIdx));
    }
    // Shallow → deep so each mkdir sees its own parent already
    // present. `{parents: true}` also covers this, but explicit
    // ordering keeps the call count tight (one mkdir per unique
    // dir, not per nested ancestor).
    const sortedParents = [...parents].sort(
        (a, b) => a.split("/").length - b.split("/").length,
    );
    for (const dir of sortedParents) {
        await fs.mkdir(dir, { parents: true, existOk: true });
    }
    const added = [];
    for (const [path, bytes] of Object.entries(files)) {
        await fs.write(path, bytes);
        added.push(path);
    }
    // Persist a user-initiated FileEvent into the event log. agex-py
    // auto-emits these on fs ops; agex-ts defines the type but
    // doesn't auto-emit — that's the host's job. Without this, file
    // uploads survive in kvgit (the file is in the FS) but the
    // upload "bubble" doesn't render on reload (loadHistory has
    // nothing to walk), AND the agent has no event in their context
    // signaling "user added files."
    const log = await agent.events(SESSION);
    await log.add(
        /** @type {any} */ ({
            type: "file",
            source: "user",
            added,
            modified: [],
            removed: [],
            timestamp: new Date().toISOString(),
            agentName: "chat",
        }),
    );
    await agent.commit(SESSION);
}

export async function deleteFilesHelper(paths) {
    const agent = _getAgent();
    const fs = await agent.fs(SESSION);
    const removed = [];
    for (const path of paths) {
        try {
            await fs.remove(path);
            removed.push(path);
        } catch {
            // Ignore missing files — match agex-py's `remove_many`
            // tolerance (callers can pass stale paths if the list
            // was built before another delete).
        }
    }
    // Symmetric with writeFiles: log user-initiated deletes so
    // history rendering shows the "Deleted:" bubble on reload and
    // the agent's context reflects the change.
    if (removed.length > 0) {
        const log = await agent.events(SESSION);
        await log.add(
            /** @type {any} */ ({
                type: "file",
                source: "user",
                added: [],
                modified: [],
                removed,
                timestamp: new Date().toISOString(),
                agentName: "chat",
            }),
        );
    }
    await agent.commit(SESSION);
}

/**
 * Read a value from the agent's cache for the active session.
 *
 * Used by iframe apps via the `getCacheValue(key)` bridge to pull
 * agent-stashed data without a full `runQuery` round-trip. Agent code
 * stashes via `cache.set(key, value)`; this reads it back. Returns
 * `undefined` for unset keys.
 *
 * Values are decoded by `polymorphicDecoder` (the same codec the
 * event log uses) so `Map` / `Set` / `Date` / typed arrays etc. all
 * round-trip — but the iframe bridge marshals the result through
 * postMessage, which structured-clones into the iframe's realm. Stick
 * to JSON-roundtrippable shapes for app↔agent passing.
 *
 * @param {string} key
 * @returns {Promise<unknown>}
 */
export async function getCacheValue(key) {
    const agent = _getAgent();
    const cache = await agent.cache(SESSION);
    return cache.get(key);
}

export async function readAppFiles() {
    const agent = _getAgent();
    const fs = await agent.fs(SESSION);
    const decoder = new TextDecoder("utf-8", { fatal: false });
    /** @type {Record<string, string>} */
    const out = {};
    let entries;
    try {
        entries = await fs.list("app/", { recursive: true });
    } catch {
        return out;
    }
    // Fan out the per-file `isFile` + `read` round-trips. App
    // directories are usually small (a handful of HTML/JS files),
    // so unbounded concurrency is fine here. Binary assets are
    // skipped here — `readAppBinaries` is the parallel call that
    // collects those as raw bytes.
    await Promise.all(
        entries.map(async (rel) => {
            const full = "app/" + rel;
            if (isBinaryAppFile(full)) return;
            try {
                if (await fs.isFile(full)) {
                    const bytes = await fs.read(full);
                    out[full] = decoder.decode(bytes);
                }
            } catch {
                // Skip files that vanish or fail to read mid-walk.
            }
        }),
    );
    return out;
}

/**
 * Read the active session's `app/` binary assets — images / fonts /
 * other non-text files. Returned as a `path → Uint8Array` map (full
 * paths including the `app/` prefix). `buildAppHtml` consumes this
 * alongside the text-file map from `readAppFiles` and inlines the
 * binaries as data URLs so the iframe can use them via `<img>`,
 * CSS `url(...)`, or `fetch`.
 *
 * Returns an empty map if `app/` doesn't exist yet.
 *
 * @returns {Promise<Record<string, Uint8Array>>}
 */
export async function readAppBinaries() {
    const agent = _getAgent();
    const fs = await agent.fs(SESSION);
    /** @type {Record<string, Uint8Array>} */
    const out = {};
    let entries;
    try {
        entries = await fs.list("app/", { recursive: true });
    } catch {
        return out;
    }
    await Promise.all(
        entries.map(async (rel) => {
            const full = "app/" + rel;
            if (!isBinaryAppFile(full)) return;
            try {
                if (await fs.isFile(full)) {
                    out[full] = await fs.read(full);
                }
            } catch {
                // Skip files that vanish or fail to read mid-walk.
            }
        }),
    );
    return out;
}

// ---------------------------------------------------------------------------
// History rendering
// ---------------------------------------------------------------------------

/**
 * Walk `events`, substituting each `ChapterEvent` with its
 * (recursively-resolved) underlying events written into `flatOut`,
 * and collecting top-level chapter metadata into `metaOut`. Mirrors
 * py's `_do_flatten` (`py-kernel-adapter.js:557`) field-for-field.
 *
 *   - `collect=true` at the top level: record `{name, message, events}`
 *     for each ChapterEvent encountered. The `events` payload is the
 *     output of `serializeChapterEvents`, which is itself recursive
 *     and produces the modal-drill-down shape `ChapterModal` expects.
 *   - `collect=false` when recursing into a ChapterEvent's resolved
 *     events: still flatten any nested chapters into `flatOut` (so the
 *     main scroll sees deeply-folded originals), but don't push their
 *     metadata to the queue — nested chapters' metadata lives inside
 *     the parent chapter's modal-contents payload already.
 *
 * @param {ReadonlyArray<Object>} events
 * @param {Array<Object>} flatOut
 * @param {Array<Object>} metaOut
 * @param {(stateKey: string) => Promise<Object | null>} resolveByKey
 * @param {boolean} collect
 */
async function _doFlatten(events, flatOut, metaOut, resolveByKey, collect) {
    for (const e of events) {
        const t = e && typeof e === "object" ? /** @type {any} */ (e).type : null;
        if (t === "chapter") {
            const ce = /** @type {any} */ (e);
            if (collect) {
                metaOut.push({
                    name: ce.name,
                    message: ce.message,
                    events: await serializeChapterEvents(
                        ce.eventRefs || [],
                        resolveByKey,
                        normalizeChatResponse,
                    ),
                });
            }
            // Recurse into the originals so nested chapters' inner
            // events also reach the main scroll.
            /** @type {Array<Object>} */
            const resolved = [];
            for (const key of ce.eventRefs || []) {
                const inner = await resolveByKey(key);
                if (inner) resolved.push(inner);
            }
            await _doFlatten(resolved, flatOut, metaOut, resolveByKey, false);
        } else {
            flatOut.push(e);
        }
    }
}

/**
 * Walk the active branch's event log and render UI-message rows in
 * the studio shell's canonical (agex-py-shaped) form.
 *
 * Per-event decoding is handed off to `ts-event-translator`, which
 * produces the same `{ type, kind, ... }` dicts the shell's
 * EventDetail / MessageList components consume on the py path.
 *
 * Chapter handling mirrors py's `_do_flatten` + main-walk structure
 * (see `py-kernel-adapter.js:540-700`):
 *
 *   1. **Pre-pass flatten.** Each `ChapterEvent` is substituted with
 *      its underlying events (resolved via `EventLog.byKey`); nested
 *      ChapterEvents are expanded recursively. The visible scroll
 *      thus renders the original turns as if no fold had happened.
 *      Top-level chapter metadata (name, message, recursive
 *      modal-contents) is collected into a FIFO queue.
 *
 *   2. **Main walk.** The `__chapter__` task's `taskStart` pushes an
 *      empty chaptering band into the message list; its `success`
 *      drains `min(N, queue.length)` entries off the front of the
 *      queue (where N is the chapter task's `result.length`) and
 *      attaches them to the most-recent open band. This produces
 *      one band per chaptering run at the position of the task
 *      that did the fold — semantically "everything above this
 *      band has been folded into a summary."
 *
 * The same recursive walk in `ts-event-translator.js`
 * (`serializeChapterEvents`) is reused to build each chapter's
 * modal-contents `events` array, so the drill-down view is
 * structurally identical to py's.
 *
 * @returns {Promise<Array<Object>>}
 */
export async function loadHistory() {
    const agent = _getAgent();
    const log = await agent.events(SESSION);
    /** Resolve a ChapterEvent's `eventRefs` state keys to the original
     *  events. The originals are left at their state keys when
     *  `replaceRange` rewrites the active index (see
     *  agex-ts:event-log.ts), so `byKey` is the right primitive to
     *  follow the refs without re-walking the active index. */
    const resolveByKey = async (key) => {
        if (typeof (/** @type {any} */ (log).byKey) === "function") {
            return await /** @type {any} */ (log).byKey(key);
        }
        return null;
    };

    // Pre-collect so we can run an async flatten pass (and so the
    // main walk can be plain `for...of`). For typical session sizes
    // the buffer cost is small compared to per-event IDB latency,
    // which we'd pay either way.
    /** @type {Array<Object>} */
    const rawEvents = [];
    for await (const e of log.iter()) rawEvents.push(e);

    /** Flat event list with ChapterEvents substituted by their
     *  (recursively-resolved) originals. */
    /** @type {Array<Object>} */
    const flat = [];
    /** Top-level chapter metadata, in flatten-encounter order. Drained
     *  by the `__chapter__` `success` handler below. */
    /** @type {Array<Object>} */
    const chapterMeta = [];
    await _doFlatten(rawEvents, flat, chapterMeta, resolveByKey, true);

    /** @type {Array<Object>} */
    const messages = [];
    /** @type {string | null} */
    let currentTaskName = null;
    /** @type {Array<Object>} */
    let currentEvents = [];

    for (const e of flat) {
        const t = /** @type {any} */ (e).type;
        const ts = _toDate(/** @type {any} */ (e).timestamp);
        const commitHash = /** @type {any} */ (e).commitHash || "";
        if (t === "taskStart") {
            currentEvents = [];
            currentTaskName = /** @type {any} */ (e).taskName ?? null;
            if (currentTaskName === "__chapter__") {
                // Push an open chaptering band; `success` below
                // drains chapter metadata into its `chapters` array.
                messages.push({
                    role: "chaptering",
                    timestamp: ts,
                    commit_hash: commitHash,
                    chapters: [],
                });
            } else {
                const inputs = /** @type {any} */ (e).inputs;
                const content =
                    typeof inputs === "string"
                        ? inputs
                        : inputs && typeof inputs === "object" && "message" in inputs
                          ? String(/** @type {any} */ (inputs).message ?? "")
                          : String(inputs ?? "");
                messages.push({
                    role: "user",
                    content,
                    timestamp: ts,
                    commit_hash: commitHash,
                });
            }
        } else if (t === "action") {
            const action = synthesizeAction(/** @type {any} */ (e));
            currentEvents.push(action);
            // Surface text-emission report bodies as their own agent
            // messages, matching the py path. Lets the chat thread
            // show the model's narration inline above the event card.
            if (action.report) {
                messages.push({
                    role: "agent",
                    content: action.report,
                    isReport: true,
                    timestamp: ts,
                });
            }
        } else if (t === "output") {
            const parts = serializeOutputParts(/** @type {any} */ (e));
            currentEvents.push(...splitOutputEvents(parts));
        } else if (t === "file") {
            // FileEvents from user uploads/deletes get rendered as
            // markdown user messages so the chat shows the action
            // alongside the conversation. agex-ts's FileEvent uses
            // `source` (matching the type definition); previously
            // checked `fileSource` here which silently filtered all
            // events out — symptom: no upload bubbles on reload.
            const fe = /** @type {any} */ (e);
            if (fe.source === "user") {
                messages.push({
                    role: "user",
                    content: _renderFileEvent(fe),
                    timestamp: ts,
                    commit_hash: commitHash,
                    isMarkdown: true,
                });
            }
        } else if (t === "success") {
            const result = /** @type {any} */ (e).result;
            if (currentTaskName === "__chapter__") {
                // Drain N top-level chapter metadata entries (where N
                // is the chapter task's result length) into the most-
                // recent open chaptering band. Mirrors py's
                // `_chapter_meta[:take]` slice + reversed-search for
                // the open band. Without this drain the band would
                // render as "0 chapters created" — same symptom we
                // saw pre-aggregation, now defended differently.
                let n = 0;
                if (Array.isArray(result)) {
                    for (const ch of result) {
                        if (ch && typeof ch === "object" && "name" in ch) n++;
                    }
                }
                const take = Math.min(n, chapterMeta.length);
                if (take > 0) {
                    for (let i = messages.length - 1; i >= 0; i--) {
                        if (messages[i].role === "chaptering") {
                            messages[i].chapters = chapterMeta.slice(0, take);
                            break;
                        }
                    }
                    chapterMeta.splice(0, take);
                }
                currentEvents = [];
                currentTaskName = null;
                continue;
            }
            // Normalizer routes structured returns (`["text", figure,
            // table]`, single figure / table, etc.) into the renderer's
            // expected shape. Bare strings still land as a simple text
            // bubble.
            messages.push({
                role: "agent",
                content: normalizeChatResponse(result),
                events: [...currentEvents],
                timestamp: ts,
            });
            currentEvents = [];
            currentTaskName = null;
        } else if (t === "fail") {
            const message = /** @type {any} */ (e).message ?? "Task failed";
            messages.push({
                role: "agent",
                content: { type: "text", content: `Error: ${message}` },
                events: [...currentEvents],
                timestamp: ts,
            });
            currentEvents = [];
            currentTaskName = null;
        } else if (t === "cancelled") {
            messages.push({
                role: "agent",
                content: { type: "text", content: "" },
                events: [...currentEvents],
                timestamp: ts,
                cancelled: true,
            });
            currentEvents = [];
            currentTaskName = null;
        }
        // No `chapter` branch — ChapterEvents have been substituted by
        // their originals during `_doFlatten`; bands are created from
        // the `__chapter__` task's `taskStart`/`success` handlers
        // above using metadata collected during flatten.
    }

    // Flush any orphan events with no preceding TaskStart — match
    // Py's "trailing agent message" behavior.
    if (currentEvents.length > 0 && currentTaskName === null) {
        messages.push({
            role: "agent",
            content: { type: "text", content: "" },
            events: [...currentEvents],
            timestamp: new Date(),
        });
    }

    return messages;
}

function _toDate(value) {
    if (value instanceof Date) return value;
    if (typeof value === "string") {
        const d = new Date(value);
        return Number.isNaN(d.getTime()) ? new Date() : d;
    }
    return new Date();
}

function _renderFileEvent(fe) {
    const parts = [];
    const tick = (s) => "`" + s + "`";
    const added = [...(fe.added || [])].sort();
    const modified = [...(fe.modified || [])].sort();
    const removed = [...(fe.removed || [])].sort();
    const uploads = [...added, ...modified];
    if (uploads.length === 1) {
        parts.push(`**Uploaded:** ${tick(uploads[0])}`);
    } else if (uploads.length > 1) {
        const list = uploads.map((f) => `- ${tick(f)}`).join("\n");
        parts.push(`**Uploaded ${uploads.length} files:**\n${list}`);
    }
    if (removed.length === 1) {
        parts.push(`**Deleted:** ${tick(removed[0])}`);
    } else if (removed.length > 1) {
        const list = removed.map((f) => `- ${tick(f)}`).join("\n");
        parts.push(`**Deleted ${removed.length} files:**\n${list}`);
    }
    return parts.length > 0 ? parts.join("  \n") : "**File change**";
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

export async function estimateLogTokens() {
    const agent = _getAgent();
    const log = await agent.events(SESSION);
    let latestActionTokens = 0;
    for await (const e of log.iter()) {
        if (
            e &&
            typeof e === "object" &&
            /** @type {any} */ (e).type === "action"
        ) {
            const t = /** @type {any} */ (e).inputTokens;
            if (typeof t === "number") latestActionTokens = t;
        }
    }
    return latestActionTokens;
}

export async function getTokenHistory() {
    const agent = _getAgent();
    const log = await agent.events(SESSION);
    /** @type {number[]} */
    const out = [];
    for await (const e of log.iter()) {
        if (
            e &&
            typeof e === "object" &&
            /** @type {any} */ (e).type === "action"
        ) {
            const t = /** @type {any} */ (e).inputTokens;
            out.push(typeof t === "number" ? t : 0);
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Debug
// ---------------------------------------------------------------------------

export async function getSessionDebugInfo(branch) {
    const staged = await _getStaged();
    // TODO(@agex-ts/kvgit): bulk read still goes through `versioned.getMany`
    // since Staged doesn't expose a cache-aware `getMany` yet (kvgit-py
    // does — `get_many(*keys)`). Singleton-loop fallback would be
    // cache-coherent but slower; this debug path tolerates the gap.
    const versioned = staged.versioned;
    const cur = staged.currentBranch;
    const switched = branch !== cur;
    if (switched) await staged.switchBranch(branch);
    try {
        // Walk the commit chain
        let commits = 0;
        for await (const _h of staged.history()) commits++;

        // Count user-visible keys at HEAD (skip kvgit / agex internals)
        const userKeys = [];
        for await (const k of staged.keys()) {
            if (!k.startsWith("__")) userKeys.push(k);
        }
        userKeys.sort();

        // Per-key sizes — use getMany for efficiency where possible.
        // Top-10 by byte count, mirroring the Py side's debug panel.
        const allKeys = [];
        for await (const k of staged.keys()) allKeys.push(k);
        const valuesMap =
            allKeys.length > 0 ? await versioned.getMany(allKeys) : new Map();
        let totalBytes = 0;
        /** @type {Array<[string, number]>} */
        const sizes = [];
        for (const [k, v] of valuesMap) {
            totalBytes += v.byteLength;
            sizes.push([k, v.byteLength]);
        }
        sizes.sort((a, b) => b[1] - a[1]);
        const topKeys = sizes.slice(0, 10).map(([key, bytes]) => ({ key, bytes }));

        return {
            branch,
            commit: staged.currentCommit?.slice(0, 12) ?? null,
            commits,
            keys_total: allKeys.length,
            keys: userKeys,
            bytes: totalBytes,
            top_keys: topKeys,
        };
    } finally {
        if (switched) {
            await staged.switchBranch(cur);
            _activeBranch = cur;
        }
    }
}

// ---------------------------------------------------------------------------
// Test seam — reset module state between test suites
// ---------------------------------------------------------------------------

/** Reset module-level singletons. Tests that exercise different
 *  studio configurations need this between suites. Not part of the
 *  public studio surface. */
export function _resetForTesting() {
    _agent = null;
    _chatTask = null;
    _activeBranch = null;
}
