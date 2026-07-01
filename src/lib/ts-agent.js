/**
 * Studio-side helpers for the agex-ts kernel — the equivalent of
 * `agent.js` for Pyodide / agex-py.
 *
 * Two responsibilities:
 *
 *   1. Agent lifecycle: `initAgent(settings)` constructs the
 *      `agex-ts` `Agent` with the studio's state / fs config and
 *      caches it as a module-level singleton. Runtime-changeable
 *      settings (model, key, chaptering threshold) flow through
 *      `agent.reconfigure`; structural ones (state / fs backend)
 *      still need a page reload.
 *
 *   2. Branch-implicit helpers the TsKernelAdapter wraps: VFS reads
 *      and writes against the active branch, history rendering,
 *      token telemetry computation, etc. Mirrors the per-function
 *      shape of `agent.js` so the adapter's call sites parallel
 *      `py-kernel-adapter.js` line-for-line.
 */

import { createAgent } from "agex-ts";
import { KvgitState } from "agex-ts/state";
import { Staged, VersionedKV } from "@agex-ts/kvgit";
import { IndexedDB } from "@agex-ts/kvgit/backends/idb";
import {
    polymorphicEncoder,
    polymorphicDecoder,
} from "@agex-ts/termish/fs/kvgit";
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
import _chatAgentPrimer from "./primers/ts-chat-agent.md?raw";
import _noVisionNote from "./primers/no-vision.md?raw";
import _chatPrimer from "./primers/ts-chat-task.md?raw";
import _numericalSkill from "./skills/numerical.md?raw";
import _interactiveAppSkill from "./skills/interactive-app.md?raw";
import _spawnSkill from "./skills/spawn.md?raw";
import _mediaSkill from "./skills/media.md?raw";
import _supabaseAuthSkill from "./skills/supabase-auth.md?raw";
import { resolveBaseUrl, resolveProvider } from "./settings.js";
import { extrasFor, supportsServiceTier, hasVision } from "./models.js";
import {
    runTestApp as appControlRunTestApp,
    runLiveApp as appControlRunLiveApp,
    getLiveIframe as appControlGetLiveIframe,
} from "./app-control.js";
import { buildAppHtml } from "./app-html.js";
import { read as readAppStorage } from "./app-storage.js";
import { runEsbuildCommand } from "./esbuild-terminal.js";
import { search as runSearchHelper } from "./search.js";
import {
    createImage as createImageHelper,
    createMusic as createMusicHelper,
    createSpeech as createSpeechHelper,
} from "./media.js";
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
    serializeSpawnChips,
} from "./ts-event-translator.js";
import { interleaveSpawnChips } from "./event-utils.js";
import { normalizeChatResponse, chatResponseSchema } from "./ts-chat-response.js";

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
    starred: "__session_starred__",
});

/** Branch-meta storage keys + the state-value decoder, exported for
 *  the sync roster's cloud-stub titles (read one key at a remote tip
 *  via readKeyAtTip, decode it the way readBranchMeta would). */
export const BRANCH_META_KEYS = META_KEYS;

export function decodeStateValue(bytes) {
    return polymorphicDecoder(bytes);
}

// --- Per-branch agent pool (Phase 2) ---------------------------------
//
// Each studio session is its own single-session agex-ts Agent — its own
// Web Worker and a working tree pinned to that session's branch over ONE
// shared kvgit store. Concurrent sessions run on independent agents, so a
// turn (or its cancel / timeout) on one never disturbs another. See
// roadmap/concurrent-sessions.md.

/**
 * @typedef {{
 *   agent: Agent,
 *   chatTask: (message: string, opts?: import('agex-ts/types').TaskCallOptions) => Promise<string>,
 *   busy: boolean,
 *   lastUsed: number,
 * }} PoolEntry
 */

/** Live agents keyed by branch. */
/** @type {Map<string, PoolEntry>} */
const _pool = new Map();

/** Max concurrently-live agents (each owns a Worker). When a new branch
 *  pushes past this, the least-recently-used IDLE agent is disposed — its
 *  session's state persists in the shared store and re-opens on demand.
 *  Busy agents (mid-turn) are never evicted. */
const MAX_LIVE_AGENTS = 5;

/** Studio settings captured at init — used to build each pooled agent's
 *  LLM client + chaptering trigger lazily. */
let _settings = /** @type {KernelSettings | null} */ (null);

/** Shared LLM client (stateless per request) handed to every pooled
 *  agent; rebuilt + hot-swapped into all live agents on settings change. */
let _llm = /** @type {LLMClient | null} */ (null);

/** The studio's single shared kvgit substrate — one IndexedDB database
 *  (KVStore) holding every session as a branch. Opened once. */
let _kvstore = /** @type {import('@agex-ts/kvgit').KVStore | null} */ (null);

/** Management working tree over the shared store — a single Staged used
 *  ONLY for branch admin (list / meta / create / fork / delete /
 *  inspect), which are quick, user-initiated, and don't run concurrently.
 *  It switches branches freely; the per-session agents never do. */
let _mgmt = /** @type {import('@agex-ts/kvgit').Staged | null} */ (null);

/** Db name connectState used for the pinned "default" session
 *  (`kvgit/<session>`). Reused verbatim so existing sessions stay
 *  readable — all `chat-*` branches already live in this one database. */
const SHARED_DB = "kvgit/default";

/** Polymorphic codec — lets one Staged carry termish VFS FileRecords and
 *  JSON-able state (cache, event log, meta) in one atomic commit.
 *  Mirrors connectState's versioned-path construction. */
const _CODEC = { encoder: polymorphicEncoder, decoder: polymorphicDecoder };

/** Test-only injection seams (default → production). Set via
 *  `_configureForTesting` so e2e tests drive the real pool with an
 *  in-process runtime + scripted LLM + memory store (no Worker / IDB).
 *  @type {{
 *    makeRuntime?: () => any,
 *    makeLlm?: (branch?: string) => LLMClient,
 *    makeStore?: () => Promise<any> | any,
 *  } | null} */
let _testHooks = null;

/** Inject test doubles for the runtime / LLM / store. `null` clears.
 *  Not part of the studio's public surface. */
export function _configureForTesting(hooks) {
    _testHooks = hooks;
}

/** Open the shared KVStore once. */
async function _openStore() {
    if (_kvstore === null) {
        _kvstore = _testHooks?.makeStore
            ? await _testHooks.makeStore()
            : await IndexedDB.open({ dbName: SHARED_DB });
    }
    return _kvstore;
}

/** The management Staged (lazily created), for branch admin only. */
async function _getMgmt() {
    if (_mgmt === null) {
        const store = await _openStore();
        const vk = await VersionedKV.open(store);
        _mgmt = new Staged(vk, _CODEC);
    }
    return _mgmt;
}

/** The shared `VersionedKV` (the management tree's) — for bundle export /
 *  import / stats, which read a branch's commit subgraph directly. */
export async function getSharedVersioned() {
    return (await _getMgmt()).versioned;
}

/** Build a StateResolver pinned to one branch over the shared store. The
 *  agent's single "default" session resolves to a Staged on `branch`
 *  (polymorphic codec). Cached per session id so the agent sees a stable
 *  backend across state/events/fs/cache calls. */
function _branchResolver(branch) {
    /** @type {Map<string, import('agex-ts/state').StateBackend>} */
    const cache = new Map();
    return {
        versioned: true,
        /** @param {string} session */
        async resolve(session) {
            const hit = cache.get(session);
            if (hit !== undefined) return hit;
            const store = await _openStore();
            const vk = await VersionedKV.open(store, { branch });
            const fresh = new KvgitState(new Staged(vk, _CODEC));
            cache.set(session, fresh);
            return fresh;
        },
    };
}

/** Get-or-create the pool entry for `branch`. Lazily boots the agent
 *  (and its Worker) on first use; bumps LRU; evicts idle agents past the
 *  cap. */
async function _entryForBranch(branch) {
    const existing = _pool.get(branch);
    if (existing) {
        existing.lastUsed = Date.now();
        return existing;
    }
    const entry = await _createBranchAgent(branch);
    _pool.set(branch, entry);
    await _evictIdle(branch);
    return entry;
}

/** The agent for `branch` (single-session "default" pinned to it). */
async function _agentForBranch(branch) {
    return (await _entryForBranch(branch)).agent;
}

/** The kvgit `Staged` backing `branch`'s working tree (for resetTo). */
async function _stagedFor(branch) {
    const agent = await _agentForBranch(branch);
    const state = await agent.state(SESSION);
    return /** @type {import('@agex-ts/kvgit').Staged} */ (
        /** @type {import('agex-ts/state').KvgitState} */ (state).staged
    );
}

/** Dispose `branch`'s agent (terminates its Worker) and drop it from the
 *  pool. The branch's state persists in the shared store. Idempotent. */
export async function disposeBranchAgent(branch) {
    const entry = _pool.get(branch);
    if (!entry) return;
    _pool.delete(branch);
    try {
        await entry.agent.dispose();
    } catch (e) {
        console.warn("[ts-agent] dispose failed:", e);
    }
}

/** Dispose every pooled agent (terminates all workers). Kernel teardown. */
export async function disposeAll() {
    const branches = [..._pool.keys()];
    await Promise.all(branches.map((b) => disposeBranchAgent(b)));
}

/** Evict least-recently-used IDLE agents until within MAX_LIVE_AGENTS.
 *  Never evicts `keep` or a busy (mid-turn) agent. */
async function _evictIdle(keep) {
    if (_pool.size <= MAX_LIVE_AGENTS) return;
    const victims = [..._pool.entries()]
        .filter(([b, e]) => b !== keep && !e.busy)
        .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [b] of victims) {
        if (_pool.size <= MAX_LIVE_AGENTS) break;
        await disposeBranchAgent(b);
    }
}

/** Agent-level primer for `model`: the base studio primer, plus a no-vision
 *  capability note when the model can't see images — so it stops reaching
 *  for screenshots / image observations it can't read. Reconfigurable (the
 *  agent primer hot-swaps via `reconfigure`), so it updates on a mid-session
 *  model switch. */
function agentPrimerFor(model) {
    return hasVision(model)
        ? _chatAgentPrimer
        : `${_chatAgentPrimer}\n\n${_noVisionNote}`;
}

/**
 * Construct (or reuse) the agex-ts Agent for the studio.  Idempotent
 * for the lifetime of the page — the second caller's settings are
 * ignored.
 *
 * @param {KernelSettings} settings
 */
export async function initAgent(settings) {
    // Capture settings + (re)build the shared LLM client. Pooled agents
    // read `_settings`/`_llm` when created; live ones get the new client
    // hot-swapped in below. (state / fs / runtime aren't reconfigurable —
    // mutating those mid-session would orphan workers or break the
    // substrate; model / key / baseUrl / provider all flow through
    // `_buildLlmClient`.)
    _settings = settings;
    _llm = _testHooks?.makeLlm ? _testHooks.makeLlm() : _buildLlmClient(settings);
    if (_kvstore !== null) {
        // Already booted — propagate the new client + chaptering trigger
        // to every live agent.
        for (const entry of _pool.values()) {
            entry.agent.reconfigure({
                llm: _llm,
                // Hot-swap the agent primer too — the no-vision note must
                // track the active model on a mid-session switch.
                primer: agentPrimerFor(settings.model),
                chapteringTrigger: _chapteringTrigger(settings),
                maxIterations: MAX_ITERATIONS,
            });
        }
        return;
    }
    // First init: open the shared store. Agents (and their workers) are
    // created lazily per branch on first use.
    await _openStore();
}

/** Chaptering threshold from settings, falling back to the default. */
function _chapteringTrigger(settings) {
    return typeof settings.chapteringTrigger === "number"
        ? settings.chapteringTrigger
        : DEFAULT_CHAPTERING_TRIGGER;
}

/**
 * Construct a fresh single-session agent pinned to `branch` over the
 * shared store, with every studio registration applied. Each agent owns
 * its own Web Worker. Returns a pool entry.
 *
 * @param {string} branch
 * @returns {Promise<PoolEntry>}
 */
async function _createBranchAgent(branch) {
    if (_settings === null || _llm === null) {
        throw new Error(
            "agex-ts kernel not initialized — call initAgent first",
        );
    }
    const settings = _settings;
    const llm = _testHooks?.makeLlm ? _testHooks.makeLlm(branch) : _llm;
    const runtime = _testHooks?.makeRuntime
        ? _testHooks.makeRuntime()
        : workerRuntime({
              // Vite-bundled worker URL (the `?worker&url` import) —
              // without it the prod worker 404s on its bare imports.
              // Per-emission wall-clock budget: generous because spawn
              // clones multiplex onto this agent's worker and a deep
              // search runs 60–90s; a runaway is still bounded and the
              // chat-UI cancel exits faster via the AbortSignal.
              workerUrl: _agexWorkerUrl,
              timeoutMs: 180_000,
          });
    const agent = await createAgent({
        name: "chat",
        // Agent-level primer (system message, built once + cached): the
        // evergreen studio environment and "active" capabilities (rich
        // responses / dashboards). Per-task output contract lives on the
        // task instead (see `_chatTask`), so it's scoped to this task
        // and not the agent. See primers/ts-chat-agent.md. A no-vision note
        // is appended for text-only models (see `agentPrimerFor`).
        primer: agentPrimerFor(settings.model),
        llm,
        runtime,
        state: { type: "resolver", resolver: _branchResolver(branch) },
        fs: { type: "kvgit" },
        chapteringTrigger: _chapteringTrigger(settings),
        maxIterations: MAX_ITERATIONS,
        // Enable native `spawn` (agex-ts builtin) for script-side
        // delegation / fan-out. The same `spawn` is reached host-side
        // (via `agent.spawn`) for app-initiated calls — see
        // `spawnFromApp`. Default is 8; set explicitly for intent.
        maxSpawns: 8,
        // Capture per-clone event timelines onto the task's terminal
        // event (`spawnEvents` on success/fail/cancelled; agex-ts >=
        // 0.4.0). Invisible to the parent LLM — it's the durable record
        // `loadHistory` uses to rebuild spawn drill-down chips after a
        // reload. Cost: wide fan-outs make terminal events (and so
        // commits/bundles) proportionally larger.
        captureSpawnEvents: true,
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
    agent.namespace(
        { url: "https://esm.sh/apache-arrow" },
        { name: "apache-arrow" },
    );
    agent.namespace(
        { url: "https://esm.sh/arquero" },
        { name: "arquero" },
    );

    // Cat-on-demand skills. Bundled at build time via vite's ?raw
    // loader; agex creates the `/skills/<name>/SKILL.md` VFS overlay
    // for `cat` access. Chaptering keeps these out of context when
    // not relevant.
    agent.skill(_numericalSkill, { name: "numerical" });
    agent.skill(_interactiveAppSkill, { name: "interactive-app" });
    // Generative media — depth for createImage / createMusic / createSpeech:
    // prompt-craft, the speech voice catalog + emotion-tag vocabulary, and
    // game-asset workflows. The fn descriptions point here.
    agent.skill(_mediaSkill, { name: "media" });
    // Spawn skill — when/how to reach for `spawn` (script-side fan-out
    // and app-embedded callbacks). A clone inherits the agent's skills,
    // but is depth-1 (no nested `spawn`) so it can't recurse.
    agent.skill(_spawnSkill, { name: "spawn" });
    // Supabase auth & shared state — how an app gets real users and
    // cross-device shared state, plus the studio-specific popup+relay
    // sign-in pattern (redirect-based OAuth would lose app state).
    agent.skill(_supabaseAuthSkill, { name: "supabase-auth" });

    // Chat task. The per-task primer carries ONLY the output contract
    // (the renderer's part-shape table) — it's task-scoped and repeats
    // in each task-start, so it's kept tight; the evergreen environment
    // and rich-response guidance live in the agent primer (system
    // message, built once + cached). The freeform return is normalized
    // at the adapter boundary (see `ts-chat-response.js`) so the chat
    // shell renders text / tables / Plotly charts inline. Both primers
    // are inlined at build time via vite's ?raw loader.
    const chatTask = agent.task({
        description: "Answer the user's chat message.",
        primer: _chatPrimer,
        // Validate the response shape so a bare domain object (which the
        // renderer can't display) bounces back to the agent with
        // guidance instead of rendering as "[object Object]". Accepts a
        // string, a renderable part, or an array of parts.
        output: chatResponseSchema,
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

    agent.fn(
        async function testApp(...args) {
            // agex-ts appends `ctx` as the trailing positional arg
            // (per `wantsContext: true`). Since the agent may pass
            // 0–2 user args, declaring fixed positions for actions /
            // fresh would put ctx at the wrong index — pull it off
            // the end and slice the user args explicitly.
            const ctx = args[args.length - 1];
            const [actions, fresh, viewport] = args.slice(0, -1);
            const fs = await agent.fs(SESSION);
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
            // One pass collecting both maps (a missing `app/` dir just
            // yields empty maps, so the orchestrator returns a clean
            // "no app files" result rather than throwing).
            await _eachAppFile(fs, async (full) => {
                const bytes = await fs.read(full);
                if (isBinaryAppFile(full)) appBinaries[full] = bytes;
                else appFiles[full] = decoder.decode(bytes);
            });
            let appStorageSeed = {};
            if (!fresh) {
                appStorageSeed = readAppStorage("ts", branch);
            }
            const results = await appControlRunTestApp({
                appFiles,
                appBinaries,
                actions: actions ?? [],
                appStorageSeed,
                buildAppHtml,
                queryHandler: null, // TS adapter has no runQuery
                cacheHandler: (key) => getCacheValue(branch, key),
                viewport: viewport ?? null,
            });
            return _postProcessResults(ctx, results);
        },
        {
            name: "testApp",
            wantsContext: true,
            description: [
                "(Pre-registered global — `await testApp(...)`, no import needed.)",
                "Build a hidden iframe from your uncommitted app/ files, run optional UI actions, and return console + action results. Use to verify app changes before taskSuccess; screenshots auto-ship to your next-turn observation.",
                "Signature: `testApp(actions?: ActionDict[], fresh?: boolean, viewport?: 'desktop'|'tablet'|'mobile'|{width,height}): Promise<ResultDict[]>` (`fresh=true` skips seeding persisted app-storage; `viewport` sizes the test iframe so you can verify responsive layouts — default 800×600).",
                "Action shapes (click / type / read / eval / assert / screenshot), screenshot timing, viewport presets, and the act→observe rule are in the interactive-app skill — `cat /skills/interactive-app/SKILL.md` before building.",
            ].join("\n"),
        },
    );

    agent.fn(
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
                "(Pre-registered global — `await liveApp(...)`, no import needed.)",
                "Interact with the LIVE preview the user sees (the last COMMITTED app/ files — uncommitted changes won't appear until taskSuccess). Use to read user-entered state or drive the running app; use `testApp` to verify changes made this turn.",
                "Signature: `liveApp(actions?: ActionDict[]): Promise<ResultDict[]>` — same `actions` shape as `testApp` (see the interactive-app skill).",
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
    agent.fn(runSearchHelper, {
        name: "search",
        description: [
            "(Pre-registered global — `await search(query)`, no import needed.)",
            "Web search via perplexity; returns a text summary with cited source URLs.",
            "Signature: `search(query: string, deep?: boolean): Promise<string>` — `deep: true` uses the multi-step research model (slower, for complex questions); default is single-shot.",
            "Gather distinct topics concurrently with `Promise.all([search(a), search(b), ...])` — each is an independent fetch.",
        ].join("\n"),
    });

    // `createImage` host-bound fn — image generation / editing via
    // OpenRouter (Google Nano Banana). Same OpenRouter-key + bridge as
    // `search`, so `Promise.all([createImage(a), createImage(b)])` fans out
    // concurrently. Returns PNG bytes; the agent decides what to do with
    // them (write an app asset, return a part, inspect).
    agent.fn(createImageHelper, {
        name: "createImage",
        description: [
            "(Pre-registered global — `await createImage(prompt)`, no import needed.)",
            "Generate an image from a text prompt (Google Nano Banana). Returns a PNG `Uint8Array`.",
            "Signature: `createImage(prompt: string, opts?: { image?: Uint8Array | Uint8Array[], quality?: 'standard' | 'high' }): Promise<Uint8Array>`. Pass `image` to EDIT / compose the reference image(s) per the prompt (multiple images compose). `quality: 'high'` is slower and higher-fidelity.",
            "Generate an app asset: `const bytes = await createImage('pixel-art castle, transparent bg'); await fs.write('app/assets/castle.png', bytes)` — then reference `assets/castle.png` in your app code. Edit one: `await createImage('recolor to blue', { image: await fs.read('app/assets/logo.png') })`.",
            "To show the user, return `{ type: 'image', data: bytes }` from `taskSuccess`. To inspect it yourself, `console.log(bytes)` (only useful if your model has vision).",
            "Fan out with `Promise.all([createImage(a), createImage(b), ...])` — each is an independent request.",
            "See the `media` skill for prompt-craft and asset workflows.",
        ].join("\n"),
    });

    // `createMusic` host-bound fn — music generation via OpenRouter (Google
    // Lyria). Streams MP3 (Lyria requires streaming); the helper collects the
    // audio chunks and returns the bytes. Same OpenRouter-key + bridge as the
    // others, so `Promise.all` fans out.
    agent.fn(createMusicHelper, {
        name: "createMusic",
        description: [
            "(Pre-registered global — `await createMusic(prompt)`, no import needed.)",
            "Generate music from a text prompt (Google Lyria). Returns an MP3 `Uint8Array`.",
            "Signature: `createMusic(prompt: string, opts?: { length?: 'clip' | 'full' }): Promise<Uint8Array>`. `length: 'clip'` (default) is a ~30-second clip; `'full'` is a longer structured song (slower, costlier). Put ALL musical control in the prompt — genre, instruments, tempo/BPM, key, mood, and structure tags like [Verse]/[Chorus]. There is NO duration, seed, or loop parameter.",
            "Use it as an app asset: `const bg = await createMusic('lo-fi hip hop, mellow, 80 BPM'); await fs.write('app/assets/bg.mp3', bg)` — then `<audio src=\"assets/bg.mp3\" loop>` in your app. There's no seamless-loop or exact-length control; for background loops, prompt for ambient material with no hard downbeats and rely on `<audio loop>`.",
            "To play it inline in the chat reply instead, return it: `taskSuccess({ type: 'audio', data: track, title: 'lo-fi loop' })`. Prefer `fs.write` for real app assets — a chat audio part is committed into the session, so reserve it for short clips / listening.",
            "Fan out with `Promise.all([createMusic(a), createMusic(b)])`.",
            "See the `media` skill for prompt-craft (genre/tempo/key/structure) and workflows.",
        ].join("\n"),
    });

    // `createSpeech` host-bound fn — text-to-speech via OpenRouter (Google
    // Gemini Flash TTS). Uses the dedicated /audio/speech endpoint (raw MP3
    // bytes). Emotion is authored inline in the text via Gemini's tags.
    agent.fn(createSpeechHelper, {
        name: "createSpeech",
        description: [
            "(Pre-registered global — `await createSpeech(text)`, no import needed.)",
            "Generate spoken audio from text (Google Gemini Flash TTS). Returns a WAV `Uint8Array` (24 kHz mono).",
            "Signature: `createSpeech(text: string, opts?: { voice?: string }): Promise<Uint8Array>`. `voice` is one of ~30 prebuilt voices (e.g. Kore, Charon, Puck, Fenrir, Zephyr, Leda, Aoede, Orus — default Kore); give each character a distinct voice.",
            "Direct emotion and delivery with inline tags written INTO the text: `'[whispers] I have been waiting... [suddenly angry] Why did you leave?'`. Tags like [laughs], [sighs], [nervous], [shouting], [excited] steer the performance mid-line.",
            "Use it as character VO: `const vo = await createSpeech('[weary] What do you want?', { voice: 'Charon' }); await fs.write('app/assets/vo/innkeeper_01.wav', vo)` — play on the dialog event. Or return `taskSuccess({ type: 'audio', data: vo, title: 'Innkeeper' })` to play it in the chat.",
            "Fan out lines with `Promise.all([createSpeech(a), createSpeech(b)])`.",
            "See the `media` skill for the full voice catalog, the emotion-tag vocabulary, and dialog workflows.",
        ].join("\n"),
    });

    // PDF helpers — render selected pages to PNG `Uint8Array`s. The
    // shared module in `pdf-render.js` does the actual pdf.js work
    // (same path the py kernel uses, just without the base64
    // round-trip the py worker needs). Returning `Uint8Array[]`
    // means the agent can `console.log(pages[0])` to surface a page
    // as an image observation directly — agex-ts's console-capture
    // detects PNG magic bytes and routes through the image pipeline.
    agent.fn(
        async function renderPdf(bytes, pages = null, scale = 2) {
            return await renderPdfPagesToBytes(bytes, pages, scale);
        },
        {
            name: "renderPdf",
            description: [
                "(Pre-registered global — `await renderPdf(bytes)`, no import needed.)",
                "Render PDF pages to PNG images. Signature: `renderPdf(bytes: Uint8Array, pages?: number[] | null, scale?: number): Promise<Uint8Array[]>` — `bytes` from `fs.read('doc.pdf')`; `pages` null = first 20 (0-based indices otherwise); `scale` default 2.",
                "There is no PDF text-extraction API — you READ pages visually: `console.log('p3', pages[3])` surfaces the page as an image observation you'll see next turn. Log each page's `Uint8Array` as its own bare console.log argument — do NOT wrap the bytes in an object or array (the wrapper JSON-serializes instead of rendering).",
                "Return a page via `taskSuccess(['caption', page])` to embed it in the chat response.",
            ].join("\n"),
        },
    );

    agent.fn(
        async function pdfPageCount(bytes) {
            return await getPdfPageCount(bytes);
        },
        {
            name: "pdfPageCount",
            description: [
                "(Pre-registered global — `await pdfPageCount(bytes)`, no import needed.)",
                "Number of pages in a PDF. Signature: `pdfPageCount(bytes: Uint8Array): Promise<number>` — `bytes` from `fs.read('doc.pdf')`. Use before renderPdf to size or stride through long docs.",
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
    agent.terminal(
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

    // --- Spawn -----------------------------------------------------------
    //
    // Script-side delegation / fan-out is the native agex-ts `spawn`
    // builtin, injected by the runtime because `maxSpawns > 0` (set on
    // createAgent above) — no host-fn registration needed. App-embedded
    // callbacks reach the same capability host-side via `spawnFromApp`
    // (the kernel adapter's `spawn`). See the `spawn` skill.

    return { agent, chatTask, busy: false, lastUsed: Date.now() };
}

/** Send a chat message through `branch`'s chat task. The pool entry's
 *  `busy` flag is held for the turn so eviction never disposes an agent
 *  mid-turn. */
export async function chatMessage(branch, message, opts = {}) {
    const entry = await _entryForBranch(branch);
    entry.busy = true;
    try {
        return await entry.chatTask(message, { session: SESSION, ...opts });
    } finally {
        entry.busy = false;
    }
}

/** Per-page-session cap on app-initiated `spawn` calls. Trust/cost
 *  guard: an embedded app — possibly imported, not authored by the
 *  person running it — can drive real LLM spend. Per page load, not
 *  persisted. Script-side `spawn` is uncapped (the user drives chat
 *  directly). */
const APP_SPAWN_CAP = 200;
let _appSpawns = 0;

/**
 * Run a `spawn` on behalf of an embedded app (iframe-initiated). The
 * kernel adapter and `AppPreview` route `agex-spawn` bridge messages
 * here. The app passes a full `SpawnSpec` inline (the app source is the
 * registry — there is no named-task lookup). App runtime is not chat
 * narrative, so nothing is recorded. Resolves with the clone's result;
 * rejects if it fails / is cancelled (the app should try/catch).
 *
 * Two app-specific guards beyond the script-side path: a per-session
 * invocation cap, and `view` is stripped — an app-initiated clone never
 * gets a window onto the user's real files.
 *
 * @param {string | object} spec - a SpawnSpec (or prose task string).
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<unknown>}
 */
export async function spawnFromApp(branch, spec, opts = {}) {
    const agent = await _agentForBranch(branch);
    if (++_appSpawns > APP_SPAWN_CAP) {
        throw new Error(
            `This app has reached the per-session limit of ${APP_SPAWN_CAP} AI calls. Reload to reset.`,
        );
    }
    // Strip `view`: an app-initiated clone must not reach the user's VFS.
    let safeSpec = spec;
    if (spec && typeof spec === "object" && "view" in spec) {
        const { view: _view, ...rest } = /** @type {any} */ (spec);
        safeSpec = rest;
    }
    return agent.spawn(safeSpec, { signal: opts.signal });
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
    // User's provider pin for this model — a HARD pin (only this provider,
    // no fallbacks). Wins over any preset `extras.provider` (overwrites,
    // doesn't merge). OpenRouter-only; ignored in custom / direct modes.
    const providerPin = isOpenRouter ? settings.providerPins?.[model] : null;
    if (providerPin) {
        modelExtras.provider = {
            order: [providerPin],
            allow_fallbacks: false,
        };
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

// ---------------------------------------------------------------------------
// Branch operations — run on the management Staged (`_getMgmt`) over the
// shared store, independent of the per-session agent pool. They're quick,
// user-initiated, and don't run concurrently, so a single admin working
// tree that switches branches is fine. Writes to a branch that also has a
// live agent are reconciled by kvgit's CAS + three-way merge on the
// agent's next commit (different keys → no conflict).
// ---------------------------------------------------------------------------

export async function listBranches() {
    const staged = await _getMgmt();
    const all = await staged.listBranches();
    return all.filter((b) => b.startsWith("chat-"));
}

export async function listBranchesWithMeta() {
    const staged = await _getMgmt();
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
                starred: await peekBool(branch, META_KEYS.starred),
            })),
    );
}

export async function createBranch(name, opts = {}) {
    const staged = await _getMgmt();
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
    staged.set(META_KEYS.updated, new Date().toISOString());
    staged.set(META_KEYS.kernel, "ts");
    await staged.commit();
}

/** Prefixes the studio considers "agent memory" — the keys
 *  `wipeAgentMemory` tombstones. The VFS file blobs (`f:` / `d:`
 *  prefixes via @agex-ts/termish kvgit-fs) and the session meta
 *  keys (`__session_*__`) are deliberately not in this list: a
 *  memory wipe clears the conversation context while keeping the
 *  workspace and session identity intact. */
const AGENT_MEMORY_PREFIXES = ["evt/", "cache/"];
const AGENT_MEMORY_EXACT_KEYS = [
    "__event_log__",
    // Legacy sub-task keys (pre-`spawn` migration). No longer written,
    // but old sessions may still carry these blobs — keep tombstoning
    // them so a memory wipe stays thorough.
    "__subtasks__",
    "__subtask_invocations__",
];

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
 * and legacy sub-task keys — while leaving the VFS file blobs
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
    // Drop any live agent first so it re-opens against the wiped state
    // (its working tree is a separate Staged that would otherwise hold
    // pre-wipe reads).
    await disposeBranchAgent(branch);
    const staged = await _getMgmt();
    const cur = staged.currentBranch;
    const switched = branch !== cur;
    if (switched) await staged.switchBranch(branch);
    try {
        // Walk all keys once. Per-key delete is cheap (in-memory
        // staged-buffer set add); the cost is the keys iteration.
        const victims = [];
        for await (const k of staged.keys()) {
            if (_isAgentMemoryKey(k)) victims.push(k);
        }
        if (victims.length === 0) return; // already clean
        for (const k of victims) staged.delete(k);
        await staged.commit();
    } finally {
        if (switched) await staged.switchBranch(cur);
    }
}

export async function deleteBranch(name) {
    // Tear down the live agent (terminates its Worker) before removing
    // the branch from under it.
    await disposeBranchAgent(name);
    const staged = await _getMgmt();
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
}

export async function readBranchMeta(name) {
    const staged = await _getMgmt();
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
        starred: await peekBool(META_KEYS.starred),
    });
}

export async function writeBranchMeta(name, patch) {
    /** @param {{ set: (k: string, v: unknown) => void }} target */
    const applyPatch = (target) => {
        if (patch.title !== undefined) target.set(META_KEYS.title, patch.title);
        if (patch.name !== undefined) target.set(META_KEYS.name, patch.name);
        if (patch.description !== undefined)
            target.set(META_KEYS.description, patch.description);
        if (patch.external !== undefined)
            target.set(META_KEYS.external, patch.external);
        if (patch.starred !== undefined)
            target.set(META_KEYS.starred, patch.starred);
        // Always bump `updated` alongside any other write so the
        // session-list ordering reflects the edit.
        target.set(META_KEYS.updated, patch.updated ?? new Date().toISOString());
    };
    // Hot path: a live agent on this branch (e.g. `persistSessionMeta`
    // right after a turn). Write through it so there's one writer per
    // branch — no CAS-merge against the management tree.
    const live = _pool.get(name);
    if (live) {
        const state = await live.agent.state(SESSION);
        applyPatch(state);
        await live.agent.commit(SESSION);
        return;
    }
    // Otherwise use the management tree (switch, write, restore).
    const staged = await _getMgmt();
    const cur = staged.currentBranch;
    const switched = name !== cur;
    if (switched) await staged.switchBranch(name);
    try {
        applyPatch(staged);
        await staged.commit();
    } finally {
        if (switched) await staged.switchBranch(cur);
    }
}

// ---------------------------------------------------------------------------
// State / commits
// ---------------------------------------------------------------------------

export async function getCurrentCommit(branch) {
    const agent = await _agentForBranch(branch);
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
export async function commitSession(branch) {
    const agent = await _agentForBranch(branch);
    await agent.commit(SESSION);
}

export async function undoToCommit(branch, hash) {
    const staged = await _stagedFor(branch);
    // staged.resetTo clears Staged's read cache + buffered writes on
    // success, so reads after the rewind see the post-reset state.
    await staged.resetTo(hash);
}

// ---------------------------------------------------------------------------
// VFS
// ---------------------------------------------------------------------------

export async function listFiles(branch) {
    const agent = await _agentForBranch(branch);
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

export async function readFile(branch, path) {
    const agent = await _agentForBranch(branch);
    const fs = await agent.fs(SESSION);
    return fs.read(path);
}

export async function fileSize(branch, path) {
    const agent = await _agentForBranch(branch);
    const fs = await agent.fs(SESSION);
    const stat = await fs.stat(path);
    return stat.size;
}

export async function writeFiles(branch, files) {
    const agent = await _agentForBranch(branch);
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

export async function deleteFilesHelper(branch, paths) {
    const agent = await _agentForBranch(branch);
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
export async function getCacheValue(branch, key) {
    const agent = await _agentForBranch(branch);
    const cache = await agent.cache(SESSION);
    return cache.get(key);
}

/**
 * Walk the active session's `app/` directory, invoking `visit(fullPath)`
 * for each regular file (full path includes the `app/` prefix). The list
 * + per-file `isFile` round-trips fan out concurrently — app dirs are
 * usually small, so unbounded concurrency is fine. Files that vanish or
 * fail mid-walk are skipped; a missing `app/` dir yields no visits.
 *
 * Shared by the text-only / binary-only / both-at-once readers so the
 * walk boilerplate lives once. Each visitor does its own byte read, so a
 * single-purpose reader can skip the half it doesn't want *before*
 * reading (preserving the read-saving the `readAppFiles` /
 * `readAppBinaries` split was built for).
 *
 * @param {any} fs
 * @param {(fullPath: string) => Promise<void>} visit
 */
async function _eachAppFile(fs, visit) {
    let entries;
    try {
        entries = await fs.list("app/", { recursive: true });
    } catch {
        return;
    }
    await Promise.all(
        entries.map(async (rel) => {
            const full = "app/" + rel;
            try {
                if (await fs.isFile(full)) await visit(full);
            } catch {
                // Skip files that vanish or fail to read mid-walk.
            }
        }),
    );
}

export async function readAppFiles(branch) {
    const fs = await (await _agentForBranch(branch)).fs(SESSION);
    const decoder = new TextDecoder("utf-8", { fatal: false });
    /** @type {Record<string, string>} */
    const out = {};
    // Binary assets are skipped here (no byte read) — `readAppBinaries`
    // is the parallel call that collects those as raw bytes.
    await _eachAppFile(fs, async (full) => {
        if (isBinaryAppFile(full)) return;
        out[full] = decoder.decode(await fs.read(full));
    });
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
export async function readAppBinaries(branch) {
    const fs = await (await _agentForBranch(branch)).fs(SESSION);
    /** @type {Record<string, Uint8Array>} */
    const out = {};
    await _eachAppFile(fs, async (full) => {
        if (isBinaryAppFile(full)) out[full] = await fs.read(full);
    });
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
export async function loadHistory(branch) {
    const agent = await _agentForBranch(branch);
    const log = await agent.events(SESSION);

    // Flatten pass: substitute each ChapterEvent with its
    // (recursively-resolved) originals so the visible scroll renders
    // the pre-fold turns. `collect: true` also drains top-level chapter
    // metadata (name, message, modal-contents) into `chapterMeta`, in
    // flatten-encounter order, for the `__chapter__` `success` handler
    // below.
    const { flat, chapterMeta } = await _flattenLogEvents(log, true);

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
            // A text-only (pure narration) turn now synthesizes to an
            // action with no emissions — text bodies are surfaced as the
            // report bubble below, not as activity-card sections. Don't
            // push an empty action: it would render as a contentless
            // "Activity" card on reload.
            if (action.emissions.length) currentEvents.push(action);
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
            // Reconstruct spawn chips from the terminal event's captured
            // clone timelines (`captureSpawnEvents` on createAgent) so
            // the turn's fan-out — and its drill-down detail — survives
            // reload. Interleaved at their spawn points (chip
            // `startedAt` vs action `ts`), matching the live feed.
            currentEvents = interleaveSpawnChips(
                currentEvents,
                _spawnChipsOf(e),
            );
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
            currentEvents = interleaveSpawnChips(
                currentEvents,
                _spawnChipsOf(e),
            );
            messages.push({
                role: "agent",
                content: { type: "text", content: `Error: ${message}` },
                events: [...currentEvents],
                timestamp: ts,
            });
            currentEvents = [];
            currentTaskName = null;
        } else if (t === "cancelled") {
            currentEvents = interleaveSpawnChips(
                currentEvents,
                _spawnChipsOf(e),
            );
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

/** Spawn chips for a terminal event's captured `spawnEvents`, or `[]`
 *  when the field is absent (pre-capture sessions, no fan-out). */
function _spawnChipsOf(terminalEvent) {
    const se = /** @type {any} */ (terminalEvent)?.spawnEvents;
    return Array.isArray(se) && se.length ? serializeSpawnChips(se) : [];
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

/**
 * Collect the active event log into a flat array with every
 * ChapterEvent substituted by its (recursively-resolved) original
 * events. Mirrors py's `token_history` flatten (chaptering.py):
 * chaptering replaces a folded action range in the active index with a
 * single ChapterEvent placeholder, so a plain `log.iter()` walk drops
 * those actions from token accounting. Flattening restores them,
 * keeping the Context Usage plot dense after compression.
 *
 * Shared by the token-telemetry callers and `loadHistory`'s pre-pass —
 * `collect` toggles whether top-level chapter metadata (name, message,
 * recursive modal-contents) is gathered alongside `flat`. The telemetry
 * callers pass `false` (they only need the flattened originals);
 * `loadHistory` passes `true` to also drain `chapterMeta` into its
 * chaptering bands.
 *
 * @param {Object} log  EventLog for SESSION
 * @param {boolean} [collect=false]  gather chapter metadata into `chapterMeta`
 * @returns {Promise<{ flat: Array<Object>, chapterMeta: Array<Object> }>}
 */
async function _flattenLogEvents(log, collect = false) {
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
    // Pre-collect so the flatten pass (and `loadHistory`'s main walk)
    // can be plain `for...of`. For typical session sizes the buffer
    // cost is small compared to per-event IDB latency, which we'd pay
    // either way.
    /** @type {Array<Object>} */
    const rawEvents = [];
    for await (const e of log.iter()) rawEvents.push(e);
    /** @type {Array<Object>} */
    const flat = [];
    /** @type {Array<Object>} */
    const chapterMeta = [];
    await _doFlatten(rawEvents, flat, chapterMeta, resolveByKey, collect);
    return { flat, chapterMeta };
}

export async function estimateLogTokens(branch) {
    const agent = await _agentForBranch(branch);
    const log = await agent.events(SESSION);
    const { flat } = await _flattenLogEvents(log);
    let latestActionTokens = 0;
    for (const e of flat) {
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

export async function getTokenHistory(branch) {
    const agent = await _agentForBranch(branch);
    const log = await agent.events(SESSION);
    const { flat } = await _flattenLogEvents(log);
    /** @type {number[]} */
    const out = [];
    for (const e of flat) {
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
    const staged = await _getMgmt();
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
        if (switched) await staged.switchBranch(cur);
    }
}

/** Run chaptering on `branch`'s agent (folds its event log into chapter
 *  summaries). The adapter commits afterward — agex-ts doesn't
 *  auto-commit the ChapterEvent + rewritten index. */
export async function runChaptering(branch) {
    const agent = await _agentForBranch(branch);
    await agent.runChaptering(SESSION);
}

// ---------------------------------------------------------------------------
// Test seam — reset module state between test suites
// ---------------------------------------------------------------------------

/** Reset module-level singletons. Tests that exercise different
 *  studio configurations need this between suites. Not part of the
 *  public studio surface. */
export function _resetForTesting() {
    _pool.clear();
    _kvstore = null;
    _mgmt = null;
    _settings = null;
    _llm = null;
    _testHooks = null;
    _appSpawns = 0;
}
