/**
 * `TsKernelAdapter` — `KernelAdapter` implementation for the agex-ts
 * (Web Worker) kernel.
 *
 * Mirrors `py-kernel-adapter.js`'s shape: a thin delegation layer over
 * a studio-side helper module (`ts-agent.js`). The adapter's role is
 * shape-translation, not new logic — branch-explicit signatures
 * around branch-implicit helpers, with `_ensureBranch` synchronizing
 * kvgit's current branch before each call.
 *
 * **Phase 5 PR 1 scope (this commit).** Adapter exists with every
 * typedef method present, real implementations for branch ops, VFS,
 * bundle, history scaffolding, telemetry, and debug. Methods that
 * depend on the chat task (`sendMessage`, `runChaptering`, `runQuery`)
 * throw `Error: not yet implemented (Phase 5 PR 2)`. Chat task,
 * skill set, LLM client, runtime adapter land in PR 2.
 */

import {
    initAgent,
    _getAgent,
    _resetForTesting,
    chatMessage as agentChatMessage,
    listBranches as agentListBranches,
    listBranchesWithMeta as agentListBranchesWithMeta,
    createBranch as agentCreateBranch,
    deleteBranch as agentDeleteBranch,
    readBranchMeta as agentReadBranchMeta,
    writeBranchMeta as agentWriteBranchMeta,
    getCurrentCommit as agentGetCurrentCommit,
    undoToCommit as agentUndoToCommit,
    commitSession as agentCommitSession,
    listFiles as agentListFiles,
    readFile as agentReadFile,
    fileSize as agentFileSize,
    writeFiles as agentWriteFiles,
    deleteFilesHelper as agentDeleteFiles,
    readAppFiles as agentReadAppFiles,
    readAppBinaries as agentReadAppBinaries,
    wipeAgentMemory as agentWipeAgentMemory,
    getCacheValue as agentGetCacheValue,
    loadHistory as agentLoadHistory,
    estimateLogTokens as agentEstimateLogTokens,
    getTokenHistory as agentGetTokenHistory,
    getSessionDebugInfo as agentGetSessionDebugInfo,
} from "./ts-agent.js";
import {
    exportBundle as bundleExport,
    importBundle as bundleImport,
    bundleStats as bundleGetStats,
} from "./ts-bundle.js";
import {
    synthesizeAction,
    serializeOutputParts,
    splitOutputEvents,
    makeLiveTokenTranslator,
} from "./ts-event-translator.js";
import { normalizeChatResponse } from "./ts-chat-response.js";

/**
 * @typedef {import('./kernel-adapter.js').KernelAdapter} KernelAdapter
 * @typedef {import('./kernel-adapter.js').KernelSettings} KernelSettings
 * @typedef {import('./kernel-adapter.js').InitOptions} InitOptions
 * @typedef {import('./kernel-adapter.js').BranchMeta} BranchMeta
 * @typedef {import('./kernel-adapter.js').CreateBranchOptions} CreateBranchOptions
 * @typedef {import('./kernel-adapter.js').SendMessageOptions} SendMessageOptions
 * @typedef {import('./kernel-adapter.js').ExportBundleOptions} ExportBundleOptions
 * @typedef {import('./kernel-adapter.js').BundlePayload} BundlePayload
 * @typedef {import('agex-ts').Agent} Agent
 * @typedef {import('kvgit-ts').VersionedKV} VersionedKV
 */

const RUN_QUERY_NOT_YET =
    "runQuery not yet implemented for the TS kernel — needs " +
    "RuntimeAdapter.execute namespace-capture support; tracked as " +
    "follow-up after Phase 5 PR 2c.";

// Future direction (note, not a TODO):
// `runQuery` was a Pyodide-era affordance — apps in the live iframe
// could call back into agent-space to read evaluated values. agex-ts
// doesn't need the round-trip: there's no cross-language bridging
// (the runtime is JS, the app is JS), so the natural successor is a
// `getCacheValue(branch, key)` adapter method that reads cached state
// values directly. Plumb that in instead of porting `runQuery` once
// an app actually needs it; until then this stub stays.

/** Switch kvgit's current branch to `branch`. Goes through Staged
 *  (not the underlying Versioned) so Staged's per-key read cache is
 *  invalidated on switch — direct `versioned.switchBranch` would
 *  leave Staged returning stale values from the prior branch. */
async function _ensureBranch(branch) {
    const agent = _getAgent();
    const state = await agent.state("default");
    const staged = /** @type {any} */ (state).staged;
    if (staged.currentBranch !== branch) {
        await staged.switchBranch(branch);
    }
}

/**
 * Construct a `KernelAdapter` instance bound to the agex-ts kernel.
 * The factory shape mirrors `createPyAdapter()` so the registry
 * doesn't have to branch on which kernel it's lazy-booting.
 *
 * @returns {KernelAdapter}
 */
export function createTsAdapter() {
    let initialized = false;
    /** @type {Promise<void> | null} */
    let initInFlight = null;

    return {
        kernel: "ts",

        // --- Lifecycle ---------------------------------------------------

        async init(/** @type {KernelSettings} */ settings, /** @type {InitOptions} */ opts = {}) {
            // Already booted — propagate settings to the live agent
            // (LLM client, chaptering trigger) via initAgent's hot-
            // swap path. No onStage replay; those fire only on first
            // boot.
            if (initialized) {
                await initAgent(settings);
                return;
            }
            if (initInFlight) return initInFlight;
            initInFlight = (async () => {
                await initAgent(settings);
                // No two-wave gap on TS — both stages fire back-to-back
                // at the end of init. Mirrors the typedef contract: TS
                // adapter has no Pyodide-style intermediate boot phase.
                await opts.onStage?.("history-ready");
                await opts.onStage?.("send-ready");
                initialized = true;
            })();
            try {
                await initInFlight;
            } finally {
                initInFlight = null;
            }
        },

        async dispose() {
            if (!initialized) return;
            try {
                await _getAgent().dispose();
            } catch (err) {
                console.warn("[agex] ts-adapter dispose failed:", err);
            }
            initialized = false;
            _resetForTesting();
        },

        // --- Branch operations -------------------------------------------

        async listBranches() {
            return agentListBranches();
        },

        async listBranchesWithMeta() {
            return agentListBranchesWithMeta();
        },

        async createBranch(name, /** @type {CreateBranchOptions} */ opts = {}) {
            await agentCreateBranch(name, opts);
        },

        async deleteBranch(name) {
            await agentDeleteBranch(name);
        },

        async readBranchMeta(name) {
            return agentReadBranchMeta(name);
        },

        async writeBranchMeta(name, patch) {
            await agentWriteBranchMeta(name, patch);
        },

        // --- Messaging ---------------------------------------------------

        async sendMessage(branch, message, opts = {}) {
            await _ensureBranch(branch);
            // Translate streamed agex-ts TokenChunks into the shell's
            // expected token shape on the way out, and accumulate
            // shell-shape events for the returned `{ result, events }`.
            // The shell renders both during streaming (via onToken) and
            // after completion (via the message's `events` array), and
            // both paths consume the py-flavored canonical shape.
            const userOnEvent = opts.onEvent;
            const userOnToken = opts.onToken;
            const translator = makeLiveTokenTranslator();
            const events = [];

            const sendTokens = async (tokens) => {
                if (!userOnToken) return;
                for (const t of tokens) await userOnToken(t);
            };

            // Always commit the session on the way out — success or
            // failure — so events that streamed into the Staged buffer
            // via `eventLog.add` survive a reload. agex-ts has no
            // auto-commit anywhere; on cancel especially, the partial
            // events would otherwise vanish (nothing later in the
            // session forces a flush). Commit landing twice in a row
            // is a no-op when the buffer is clean.
            let result;
            try {
                result = await agentChatMessage(message, {
                    signal: opts.signal,
                    onToken: async (chunk) => {
                        await sendTokens(translator.translate(chunk));
                    },
                    onEvent: async (e) => {
                        // Translate the event into the shell's canonical
                        // shape *before* user-facing forwarding so callers
                        // that inspect events (e.g. for cancelled-detection)
                        // see the same shape py emits.
                        if (e?.type === "action") {
                            events.push(synthesizeAction(e));
                            // ActionEvent finished — flush the streaming
                            // turn so any subsequent ActionEvent starts
                            // fresh in the shell's snapshot accumulator.
                            await sendTokens(translator.turnComplete());
                        } else if (e?.type === "output") {
                            const parts = serializeOutputParts(e);
                            for (const out of splitOutputEvents(parts)) {
                                events.push(out);
                            }
                        } else if (e?.type === "cancelled") {
                            events.push({ type: "cancelled" });
                        }
                        // Forward the *raw* agex-ts event to the user
                        // callback — the typed shape is the documented
                        // surface for callers who want low-level access.
                        if (userOnEvent) await userOnEvent(e);
                    },
                });
            } finally {
                await agentCommitSession();
            }
            // Normalize the agent's freeform return value into the
            // renderer's expected shape (text bubble or multi-part
            // response). Single chokepoint — both the live path
            // (ChatShell wraps `response.result` directly into
            // `msg.content`) and the historical path (loadHistory
            // calls the same normalizer) see the same shape.
            return { result: normalizeChatResponse(result), events };
        },

        async runChaptering(branch) {
            await _ensureBranch(branch);
            const agent = _getAgent();
            await agent.runChaptering("default");
        },

        // --- State / commits --------------------------------------------

        async getCurrentCommit(branch) {
            await _ensureBranch(branch);
            return agentGetCurrentCommit();
        },

        async undoToCommit(branch, hash) {
            await _ensureBranch(branch);
            await agentUndoToCommit(hash);
        },

        // --- VFS ---------------------------------------------------------

        async listFiles(branch) {
            await _ensureBranch(branch);
            return agentListFiles();
        },

        async readFile(branch, path) {
            await _ensureBranch(branch);
            return agentReadFile(path);
        },

        async fileSize(branch, path) {
            await _ensureBranch(branch);
            return agentFileSize(path);
        },

        async writeFiles(branch, files) {
            await _ensureBranch(branch);
            await agentWriteFiles(files);
        },

        async deleteFiles(branch, paths) {
            await _ensureBranch(branch);
            await agentDeleteFiles(paths);
        },

        async readAppFiles(branch) {
            await _ensureBranch(branch);
            return agentReadAppFiles();
        },

        async readAppBinaries(branch) {
            await _ensureBranch(branch);
            return agentReadAppBinaries();
        },

        async wipeAgentMemory(branch) {
            await agentWipeAgentMemory(branch);
        },

        // --- Bundle payloads --------------------------------------------

        async exportBundlePayload(branch, /** @type {ExportBundleOptions} */ opts = {}) {
            const agent = _getAgent();
            const state = await agent.state("default");
            const versioned = /** @type {any} */ (state).staged.versioned;
            const meta = await agentReadBranchMeta(branch);
            const { bytes, manifest } = await bundleExport(versioned, branch, {
                kernel: "ts",
                name: meta.name || meta.title,
                description: meta.description,
                progress: opts.onProgress,
            });
            return { bytes, manifest };
        },

        async importBundlePayload(payload) {
            const agent = _getAgent();
            const state = await agent.state("default");
            const versioned = /** @type {any} */ (state).staged.versioned;
            const result = await bundleImport(versioned, payload);
            return result;
        },

        async getBundleStats(branch) {
            const agent = _getAgent();
            const state = await agent.state("default");
            const versioned = /** @type {any} */ (state).staged.versioned;
            const stats = await bundleGetStats(versioned, branch);
            const meta = await agentReadBranchMeta(branch);
            // Match the Py adapter's combined shape: bundle-walk stats
            // augmented with branch metadata so the export modal can
            // render a complete preview without a separate readMeta
            // round-trip.
            return {
                ...stats,
                title: meta.title,
                name: meta.name,
                description: meta.description,
            };
        },

        // --- History rendering ------------------------------------------

        async loadHistory(branch) {
            await _ensureBranch(branch);
            // Stub for PR 1; PR 2 implements the full event-renderer.
            return agentLoadHistory();
        },

        // --- Query / cache bridges --------------------------------------

        async runQuery(_branch, _code, _resultVars) {
            throw new Error(RUN_QUERY_NOT_YET);
        },

        async getCacheValue(branch, key) {
            await _ensureBranch(branch);
            return agentGetCacheValue(key);
        },

        // --- Token telemetry --------------------------------------------

        async estimateLogTokens(branch) {
            await _ensureBranch(branch);
            return agentEstimateLogTokens();
        },

        async getTokenHistory(branch) {
            await _ensureBranch(branch);
            return agentGetTokenHistory();
        },

        // --- Debug -------------------------------------------------------

        async getSessionDebugInfo(branch) {
            return agentGetSessionDebugInfo(branch);
        },
    };
}
