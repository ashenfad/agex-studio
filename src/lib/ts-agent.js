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
import _numericalSkill from "./skills/numerical.md?raw";
import { resolveBaseUrl, resolveProvider } from "./settings.js";
import {
    synthesizeAction,
    serializeOutputParts,
    splitOutputEvents,
} from "./ts-event-translator.js";
import { normalizeChatResponse } from "./ts-chat-response.js";

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
        });
        return;
    }
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

    // Lazy URL-shipped namespaces. agex-ts records the URL but does
    // not fetch — the worker only triggers a network call on the first
    // emission that actually does `import { ... } from 'arquero'`. Cold
    // boot pays nothing; per-module first use pays one fetch; cached
    // for the rest of the worker lifetime.
    _agent.namespace(
        { url: "https://esm.sh/apache-arrow" },
        { name: "apache-arrow" },
    );
    _agent.namespace(
        { url: "https://esm.sh/arquero" },
        { name: "arquero" },
    );

    // Cat-on-demand skill describing the data libraries above. The
    // agent reads `/skills/numerical/SKILL.md` (the agex skill VFS
    // overlay) when a task touches data work; chaptering keeps it
    // out of context when irrelevant. Skill content is bundled at
    // build time via vite's ?raw loader.
    _agent.skill(_numericalSkill, { name: "numerical" });

    // Chat task — `string | array | object`. Rich multi-part responses
    // are normalized at the adapter boundary (see `ts-chat-response.js`)
    // so the chat shell renders text / tables / Plotly charts inline.
    // The primer markdown lives alongside this file under primers/ and
    // is inlined at build time via vite's ?raw loader.
    _chatTask = _agent.task({
        description: "Answer the user's chat message.",
        primer: _chatPrimer,
    });

    // TODO: TS skill set + agent.fn registrations (test_app, live_app,
    // esbuild) — deferred from Phase 5 PR 2a-iv. The py side registers
    // these at init time via agent_helpers.register; the TS side
    // currently boots with just the chat task and the worker runtime's
    // built-in surface (terminal, fileWrite, fileEdit, ts emissions).
    // Add the skill registrations here once the matching TS helpers
    // (esbuild-wasm pipeline, app-preview hooks) exist.
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
    if (!apiKey) {
        throw new Error("LLM API key required");
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
                      // agex-anthropic sends by default. `null` deletes
                      // it (per the headers contract).
                      headers: { "anthropic-version": null },
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
    });
}

/** Module-internal accessor.  Throws if `initAgent` hasn't run yet. */
export function _getAgent() {
    if (!_agent) {
        throw new Error("agex-ts kernel not initialized — call initAgent first");
    }
    return _agent;
}

/** Read the underlying kvgit-ts `Staged` for the studio's pinned
 *  default session. HEAD-movers (`switchBranch`, `resetTo`, `refresh`)
 *  must go through Staged so its read cache is invalidated — direct
 *  reach-through to `staged.versioned.switchBranch(...)` would leave
 *  Staged's per-key cache holding stale data from the prior branch. */
async function _getStaged() {
    const agent = _getAgent();
    const state = await agent.state(SESSION);
    return /** @type {import('kvgit-ts').Staged} */ (
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
        // TODO(kvgit-ts): if Staged grows an `initial()` analog, drop
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
    // termish-ts's MountFS list filters by what backing reports, so
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
    // so unbounded concurrency is fine here.
    await Promise.all(
        entries.map(async (rel) => {
            const full = "app/" + rel;
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

// ---------------------------------------------------------------------------
// History rendering
// ---------------------------------------------------------------------------

/**
 * Walk the active branch's event log and render UI-message rows in
 * the studio shell's canonical (agex-py-shaped) form.
 *
 * Per-event decoding is handed off to `ts-event-translator`, which
 * produces the same `{ type, kind, ... }` dicts the shell's
 * EventDetail / MessageList components consume on the py path.
 *
 * Still-deferred relative to the py renderer:
 *
 *   - **No chapter flattening.** ChapterEvents render as a single
 *     `'chaptering'` row carrying the chapter's name+message.  The
 *     Py side flattens chapters to show the original events inside
 *     them; TS side will do that follow-up once chaptering parity
 *     matters. For now, the user sees that chaptering happened but
 *     can't expand to inspect.
 *
 * @returns {Promise<Array<Object>>}
 */
export async function loadHistory() {
    const agent = _getAgent();
    const log = await agent.events(SESSION);
    /** @type {Array<Object>} */
    const messages = [];
    /** @type {string | null} */
    let currentTaskName = null;
    /** @type {Array<Object>} */
    let currentEvents = [];

    for await (const e of log.iter()) {
        const t = /** @type {any} */ (e).type;
        const ts = _toDate(/** @type {any} */ (e).timestamp);
        const commitHash = /** @type {any} */ (e).commitHash || "";
        if (t === "taskStart") {
            currentEvents = [];
            currentTaskName = /** @type {any} */ (e).taskName ?? null;
            if (currentTaskName === "__chapter__") {
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
            // alongside the conversation.
            const fe = /** @type {any} */ (e);
            if (fe.fileSource === "user") {
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
                // Chapter task succeeded — close the open chaptering row.
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
        } else if (t === "chapter") {
            // Standalone ChapterEvent (yielded by `iter()` in place
            // of folded events). Render as a chaptering row with a
            // single chapter entry.
            //
            // TODO: chapter flattening. The py heredoc's `_do_flatten`
            // recursively expands ChapterEvents back into their
            // original events so the user can drill in and see what
            // was folded; we currently surface only that chaptering
            // happened. Mirror the py walk here once chaptering UX
            // parity matters for TS sessions.
            const ce = /** @type {any} */ (e);
            messages.push({
                role: "chaptering",
                timestamp: ts,
                commit_hash: commitHash,
                chapters: [{ name: ce.name, message: ce.message, events: [] }],
            });
        }
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
    // TODO(kvgit-ts): bulk read still goes through `versioned.getMany`
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
