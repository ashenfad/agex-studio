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
import { Anthropic } from "agex-anthropic";
import { OpenAI } from "agex-openai";
import { workerRuntime } from "agex-runtime-worker";
import _chatPrimer from "./primers/ts-chat-task.md?raw";

/**
 * @typedef {import('agex-ts').Agent} Agent
 * @typedef {import('agex-ts').LLMClient} LLMClient
 * @typedef {import('kvgit-ts').VersionedKV} VersionedKV
 * @typedef {import('./kernel-adapter.js').KernelSettings} KernelSettings
 * @typedef {import('./kernel-adapter.js').BranchMeta} BranchMeta
 */

const SESSION = "default";

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
    if (_agent) return;
    const llm = _buildLlmClient(settings);
    const runtime = workerRuntime({
        // Vite resolves `new URL('./worker.js', import.meta.url)`
        // inside the agex-runtime-worker package via its own
        // import.meta context, so we just pass the default by
        // omitting `workerUrl` — agex-runtime-worker handles it.
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
    });

    // Chat task — `string -> string` for now. Multi-part responses
    // (DataFrames, charts) come when the TS side has equivalent rich
    // types to surface. The primer markdown lives alongside this
    // file under primers/ and is inlined at build time via vite's
    // ?raw loader.
    _chatTask = _agent.task({
        description: "Answer the user's chat message.",
        primer: _chatPrimer,
    });
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
    const provider = settings.provider || "anthropic";
    const apiKey = settings.apiKey;
    const model = settings.model;
    if (!apiKey) {
        throw new Error("LLM API key required");
    }
    if (!model) {
        throw new Error("LLM model required");
    }
    if (provider === "anthropic") {
        return new Anthropic({
            apiKey,
            model,
            ...(settings.baseUrl ? { baseUrl: settings.baseUrl } : {}),
        });
    }
    // openai / openai-compatible (OpenRouter, local servers, etc.)
    return new OpenAI({
        apiKey,
        model,
        ...(settings.baseUrl ? { baseUrl: settings.baseUrl } : {}),
    });
}

/** Module-internal accessor.  Throws if `initAgent` hasn't run yet. */
export function _getAgent() {
    if (!_agent) {
        throw new Error("agex-ts kernel not initialized — call initAgent first");
    }
    return _agent;
}

/** Read the underlying kvgit-ts `Versioned` for the studio's pinned
 *  default session. Branch operations live below the agex-ts Agent's
 *  session abstraction — same pattern the studio uses on the Py side
 *  (`_state.versioned.list_branches()`). */
async function _getVersioned() {
    const agent = _getAgent();
    const state = await agent.state(SESSION);
    // KvgitState exposes `.staged` for kvgit-specific surface; that's
    // documented as the path for callers needing branches / history
    // walks. `staged.versioned` is the underlying VersionedKV.
    return /** @type {VersionedKV} */ (
        /** @type {import('agex-ts/state').KvgitState} */ (state).staged.versioned
    );
}

/** Switch kvgit's current branch if not already there. Mirrors the
 *  PyKernelAdapter's _ensureBranch pattern; cached so repeat calls
 *  on the same branch are zero-op. */
async function _ensureBranch(branch) {
    if (_activeBranch === branch) return;
    const versioned = await _getVersioned();
    if (versioned.currentBranch !== branch) {
        await versioned.switchBranch(branch);
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
    const versioned = await _getVersioned();
    const all = await versioned.listBranches();
    return all.filter((b) => b.startsWith("chat-"));
}

export async function createBranch(name, opts = {}) {
    const agent = _getAgent();
    const versioned = await _getVersioned();
    if (opts.from) {
        // Fork-from semantics: switch to opts.from so the new branch
        // is created off its HEAD. Matches agex-py forkSession
        // (createBranch with no `at=` forks from current).
        await versioned.switchBranch(opts.from);
        await versioned.createBranch(name);
    } else {
        await versioned.createBranch(name, {
            at: versioned.initialCommit,
        });
    }
    await versioned.switchBranch(name);
    _activeBranch = name;

    const state = await agent.state(SESSION);
    state.set(META_KEYS.updated, new Date().toISOString());
    state.set(META_KEYS.kernel, "ts");
    await agent.commit(SESSION);
}

export async function deleteBranch(name) {
    const versioned = await _getVersioned();
    if (versioned.currentBranch === name) {
        // Adapter's contract: the adapter falls back to another
        // chat- branch internally so subsequent ops don't trip on
        // a missing active branch. Shell decides what to render.
        const others = (await versioned.listBranches()).filter(
            (b) => b.startsWith("chat-") && b !== name,
        );
        if (others.length > 0) {
            // Pick whichever; shell will redirect via switchSession
            // immediately afterwards.
            await versioned.switchBranch(others[0]);
        } else {
            // No other chat- branches; switch to anything else.
            const all = (await versioned.listBranches()).filter(
                (b) => b !== name,
            );
            if (all.length > 0) {
                await versioned.switchBranch(all[0]);
            }
        }
    }
    await versioned.deleteBranch(name);
    _invalidateActiveBranch();
}

export async function readBranchMeta(name) {
    const versioned = await _getVersioned();
    const decoder = new TextDecoder();
    /** @param {string} key */
    const peekStr = async (key) => {
        const raw = await versioned.peek(key, { branch: name });
        if (raw === null) return "";
        try {
            const v = JSON.parse(decoder.decode(raw));
            return typeof v === "string" ? v : "";
        } catch {
            return "";
        }
    };
    return /** @type {BranchMeta} */ ({
        title: (await peekStr(META_KEYS.title)) || "New Chat",
        name: await peekStr(META_KEYS.name),
        description: await peekStr(META_KEYS.description),
        updated: await peekStr(META_KEYS.updated),
    });
}

export async function writeBranchMeta(name, patch) {
    const agent = _getAgent();
    const versioned = await _getVersioned();
    const cur = versioned.currentBranch;
    const switched = name !== cur;
    if (switched) await versioned.switchBranch(name);
    try {
        const state = await agent.state(SESSION);
        if (patch.title !== undefined) state.set(META_KEYS.title, patch.title);
        if (patch.name !== undefined) state.set(META_KEYS.name, patch.name);
        if (patch.description !== undefined) state.set(META_KEYS.description, patch.description);
        // Always bump `updated` alongside any other write so the
        // session-list ordering reflects the edit.
        state.set(
            META_KEYS.updated,
            patch.updated ?? new Date().toISOString(),
        );
        await agent.commit(SESSION);
    } finally {
        if (switched) {
            await versioned.switchBranch(cur);
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

export async function undoToCommit(hash) {
    const versioned = await _getVersioned();
    await versioned.resetTo(hash);
    // Staged buffer may hold cached reads against the pre-reset state.
    // Drop our cached active branch so next op re-syncs.
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
    // termish-ts's MountFS list filters by what backing reports, so
    // overlay-aware. Filter explicitly so the shell doesn't see
    // overlay infrastructure paths.
    const out = [];
    for (const path of all) {
        // Skip /chapters and /skills overlay roots — those are
        // synthesized read-only mounts; the shell wants the agent's
        // actual VFS entries.
        if (path.startsWith("chapters/") || path.startsWith("skills/")) continue;
        if (await fs.isFile(path)) out.push(path);
    }
    return out.sort();
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
    for (const [path, bytes] of Object.entries(files)) {
        await fs.write(path, bytes);
    }
    await agent.commit(SESSION);
}

export async function deleteFilesHelper(paths) {
    const agent = _getAgent();
    const fs = await agent.fs(SESSION);
    for (const path of paths) {
        try {
            await fs.remove(path);
        } catch {
            // Ignore missing files — match agex-py's `remove_many`
            // tolerance (callers can pass stale paths if the list
            // was built before another delete).
        }
    }
    await agent.commit(SESSION);
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
    for (const rel of entries) {
        const full = "app/" + rel;
        try {
            if (await fs.isFile(full)) {
                const bytes = await fs.read(full);
                out[full] = decoder.decode(bytes);
            }
        } catch {
            // Skip files that vanish or fail to read mid-walk.
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// History rendering
// ---------------------------------------------------------------------------

/**
 * Walk the active branch's event log and render UI-message rows.
 *
 * **PR 1 stub.** Returns `[]` for now. The full event-renderer (chapter
 * flattening, multi-part Response normalization, action/output event
 * grouping, file-event recap rendering, chaptering-row synthesis)
 * lands in Phase 5 PR 2 alongside the chat task. The branch is set up
 * but no chat task means no events have been recorded; an empty
 * history is the honest answer until then.
 */
export async function loadHistory() {
    const agent = _getAgent();
    const log = await agent.events(SESSION);
    // Defensive: even with no chat task registered, log.iter() is
    // valid; just won't produce any chat-shaped events.
    /** @type {Array<unknown>} */
    const events = [];
    for await (const e of log.iter()) events.push(e);
    // PR 2 will produce UiMessage[] from these events.
    return [];
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
    const versioned = await _getVersioned();
    const cur = versioned.currentBranch;
    const switched = branch !== cur;
    if (switched) await versioned.switchBranch(branch);
    try {
        // Walk the commit chain
        let commits = 0;
        for await (const _h of versioned.history()) commits++;

        // Count user-visible keys at HEAD (skip kvgit / agex internals)
        const userKeys = [];
        for await (const k of versioned.keys()) {
            if (!k.startsWith("__")) userKeys.push(k);
        }
        userKeys.sort();

        // Per-key sizes — use getMany for efficiency where possible.
        // Top-10 by byte count, mirroring the Py side's debug panel.
        const allKeys = [];
        for await (const k of versioned.keys()) allKeys.push(k);
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
            commit: versioned.currentCommit?.slice(0, 12) ?? null,
            commits,
            keys_total: allKeys.length,
            keys: userKeys,
            bytes: totalBytes,
            top_keys: topKeys,
        };
    } finally {
        if (switched) {
            await versioned.switchBranch(cur);
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
