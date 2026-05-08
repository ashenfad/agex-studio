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
    listBranches as agentListBranches,
    createBranch as agentCreateBranch,
    deleteBranch as agentDeleteBranch,
    readBranchMeta as agentReadBranchMeta,
    writeBranchMeta as agentWriteBranchMeta,
    getCurrentCommit as agentGetCurrentCommit,
    undoToCommit as agentUndoToCommit,
    listFiles as agentListFiles,
    readFile as agentReadFile,
    fileSize as agentFileSize,
    writeFiles as agentWriteFiles,
    deleteFilesHelper as agentDeleteFiles,
    readAppFiles as agentReadAppFiles,
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

const NOT_YET = "not yet implemented (Phase 5 PR 2 — chat task & skills)";

/** Switch kvgit's current branch to `branch`. The active-branch
 *  cache lives inside `ts-agent.js`; the underlying versioned ops
 *  re-read it on each call. The adapter delegates branch-switching
 *  through the helper module so a single chokepoint owns the
 *  caching. */
async function _ensureBranch(branch) {
    const agent = _getAgent();
    const state = await agent.state("default");
    const versioned = /** @type {any} */ (state).staged.versioned;
    if (versioned.currentBranch !== branch) {
        await versioned.switchBranch(branch);
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
            if (initialized) return;
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

        async sendMessage(_branch, _message, _opts) {
            throw new Error(NOT_YET);
        },

        async runChaptering(_branch) {
            throw new Error(NOT_YET);
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

        // --- Query bridge -----------------------------------------------

        async runQuery(_branch, _code, _resultVars) {
            throw new Error(NOT_YET);
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
