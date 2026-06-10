/**
 * `TsKernelAdapter` — `KernelAdapter` implementation for the agex-ts
 * (Web Worker) kernel.
 *
 * Mirrors `py-kernel-adapter.js`'s shape: a thin delegation layer over
 * a studio-side helper module (`ts-agent.js`). The adapter's role is
 * shape-translation, not new logic — every method just forwards its
 * `branch` to the matching branch-explicit `ts-agent` helper, which
 * resolves that branch's agent from the per-session pool (Phase 2 —
 * concurrent sessions; no shared "current branch" to synchronize).
 *
 * `runQuery` is the one stubbed method — the agent↔app data bridge is a
 * Pyodide-kernel affordance with no TS-kernel equivalent yet.
 */

import {
    initAgent,
    _resetForTesting,
    runChaptering as agentRunChaptering,
    getSharedVersioned as agentGetSharedVersioned,
    disposeAll as agentDisposeAll,
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
    spawnFromApp as agentSpawnFromApp,
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
    serializeSpawnActionEvent,
    summarizeSpawnValue,
    spawnValueText,
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
 * @typedef {import('@agex-ts/kvgit').VersionedKV} VersionedKV
 */

const RUN_QUERY_NOT_YET =
    "runQuery not yet implemented for the TS kernel — needs " +
    "RuntimeAdapter.execute namespace-capture support.";

// Future direction (note, not a TODO):
// `runQuery` was a Pyodide-era affordance — apps in the live iframe
// could call back into agent-space to read evaluated values. agex-ts
// doesn't need the round-trip: there's no cross-language bridging
// (the runtime is JS, the app is JS), so the natural successor is a
// `getCacheValue(branch, key)` adapter method that reads cached state
// values directly. Plumb that in instead of porting `runQuery` once
// an app actually needs it; until then this stub stays.

/** Debug-print gate. Flip on at runtime with
 *  `localStorage.debugAgent = '1'` then reload. Prints flow through
 *  the host main-thread console (not the worker). Cheap when off —
 *  just a single localStorage read per emission. */
function _dbg(...args) {
    try {
        if (
            typeof localStorage !== "undefined" &&
            localStorage.getItem("debugAgent") === "1"
        ) {
            // eslint-disable-next-line no-console
            console.log("[ts-adapter]", ...args);
        }
    } catch {
        // localStorage can throw in sandboxed contexts — ignore.
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
                await agentDisposeAll();
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
            _dbg("sendMessage start", {
                branch,
                messageLen: typeof message === "string" ? message.length : -1,
            });
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
            /** @type {string | null} */
            let currentTaskName = null;
            let chapterCount = 0;
            // Per-clone live-chip state for this turn, keyed by the
            // clone's `spawnIndex`. Tracks start time + step count so an
            // `end` token can report duration/steps. Live-only — cleared
            // with the turn.
            /** @type {Map<string, { startMs: number, steps: number }>} */
            const spawnChips = new Map();

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
                result = await agentChatMessage(branch, message, {
                    signal: opts.signal,
                    onToken: async (chunk) => {
                        await sendTokens(translator.translate(chunk));
                    },
                    onEvent: async (e) => {
                        // Translate the event into the shell's canonical
                        // shape *before* user-facing forwarding so callers
                        // that inspect events (e.g. for cancelled-detection)
                        // see the same shape py emits.
                        const et = /** @type {any} */ (e)?.type;
                        // Spawn-clone events ride this same stream (agex-ts
                        // forwards a clone's events to the parent task's
                        // onEvent), distinguished by a structured
                        // `spawnIndex` (the clone's 0-based index per
                        // spawning task; agex-ts >= 0.3.1). They are NOT chat
                        // narrative — never render them as parent
                        // actions/output. Instead demux by the index into a
                        // live "running → done" chip token whose `events`
                        // payload carries the clone's translated
                        // actions/outputs for the chip's drill-down view.
                        // Live tokens are not pushed to `events` — on reload
                        // the chips reconstruct from the terminal event's
                        // captured `spawnEvents` instead (captureSpawnEvents
                        // is on; see loadHistory → serializeSpawnChips).
                        const spawnIndex = /** @type {any} */ (e)?.spawnIndex;
                        if (typeof spawnIndex === "number") {
                            if (userOnToken) {
                                const id = String(spawnIndex);
                                const ev = /** @type {any} */ (e);
                                if (et === "taskStart") {
                                    spawnChips.set(id, { startMs: Date.now(), steps: 0 });
                                    await userOnToken({
                                        type: "spawn",
                                        phase: "start",
                                        id,
                                        inputsSummary: summarizeSpawnValue(ev.inputs),
                                        inputs: spawnValueText(ev.inputs),
                                    });
                                } else if (et === "action") {
                                    const c = spawnChips.get(id);
                                    if (c) c.steps += 1;
                                    const action = serializeSpawnActionEvent(ev);
                                    await userOnToken({
                                        type: "spawn",
                                        phase: "progress",
                                        id,
                                        steps: c ? c.steps : 1,
                                        ...(action.emissions.length
                                            ? { events: [action] }
                                            : {}),
                                    });
                                } else if (et === "output") {
                                    // Clone stdout/errors — drill-down detail
                                    // only, no step bump (steps count actions).
                                    const parts = serializeOutputParts(ev);
                                    await userOnToken({
                                        type: "spawn",
                                        phase: "progress",
                                        id,
                                        events: splitOutputEvents(parts),
                                    });
                                } else if (
                                    et === "success" ||
                                    et === "fail" ||
                                    et === "cancelled"
                                ) {
                                    const c = spawnChips.get(id);
                                    spawnChips.delete(id);
                                    await userOnToken({
                                        type: "spawn",
                                        phase: "end",
                                        id,
                                        status: et === "success" ? "success" : et,
                                        steps: c ? c.steps : undefined,
                                        durationMs: c ? Date.now() - c.startMs : undefined,
                                        resultSummary:
                                            et === "success"
                                                ? summarizeSpawnValue(ev.result)
                                                : undefined,
                                        result:
                                            et === "success"
                                                ? spawnValueText(ev.result)
                                                : undefined,
                                        error: et === "fail" ? ev.message : undefined,
                                    });
                                }
                            }
                            return;
                        }
                        if (et === "taskStart") {
                            currentTaskName =
                                /** @type {any} */ (e).taskName ?? null;
                            if (currentTaskName === "__chapter__") {
                                chapterCount += 1;
                                _dbg("chapter task START", {
                                    nth: chapterCount,
                                });
                            } else {
                                _dbg("task START", { taskName: currentTaskName });
                            }
                        } else if (et === "action") {
                            const a = /** @type {any} */ (e);
                            _dbg("action", {
                                taskName: currentTaskName,
                                emissionCount: a.emissions?.length ?? null,
                                inputTokens: a.inputTokens ?? a.input_tokens ?? null,
                                outputTokens: a.outputTokens ?? a.output_tokens ?? null,
                            });
                            // Pure-narration turns synthesize to an
                            // emission-less action (text bodies become the
                            // report bubble, not an activity section). Skip
                            // the empty shell so the committed message
                            // doesn't carry a contentless activity card —
                            // matches the loadHistory reload path.
                            const action = synthesizeAction(e);
                            if (action.emissions.length) events.push(action);
                            // ActionEvent finished — flush the streaming
                            // turn so any subsequent ActionEvent starts
                            // fresh in the shell's snapshot accumulator.
                            await sendTokens(translator.turnComplete());
                        } else if (et === "output") {
                            const parts = serializeOutputParts(e);
                            _dbg("output", {
                                taskName: currentTaskName,
                                partCount: parts.length,
                            });
                            for (const out of splitOutputEvents(parts)) {
                                events.push(out);
                            }
                        } else if (et === "success") {
                            _dbg("task SUCCESS", {
                                taskName: currentTaskName,
                            });
                            currentTaskName = null;
                        } else if (et === "fail") {
                            _dbg("task FAIL", {
                                taskName: currentTaskName,
                                message: /** @type {any} */ (e).message,
                            });
                            currentTaskName = null;
                        } else if (et === "cancelled") {
                            _dbg("cancelled", { taskName: currentTaskName });
                            events.push({ type: "cancelled" });
                            currentTaskName = null;
                        } else if (et === "chapter") {
                            chapterCount += 1;
                            const ce = /** @type {any} */ (e);
                            _dbg("standalone CHAPTER event", {
                                nth: chapterCount,
                                name: ce.name,
                                messagePreview:
                                    typeof ce.message === "string"
                                        ? ce.message.slice(0, 80)
                                        : null,
                            });
                        } else if (et) {
                            _dbg("event", { type: et });
                        }
                        // Forward the *raw* agex-ts event to the user
                        // callback — the typed shape is the documented
                        // surface for callers who want low-level access.
                        if (userOnEvent) await userOnEvent(e);
                    },
                });
            } finally {
                await agentCommitSession(branch);
                _dbg("sendMessage done", {
                    branch,
                    eventCount: events.length,
                    chapterCount,
                });
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
            _dbg("runChaptering start (manual)", { branch });
            try {
                await agentRunChaptering(branch);
            } finally {
                // agex-ts doesn't auto-commit anywhere; its
                // `runChaptering` writes the ChapterEvent + new index
                // into the kvgit Staged buffer but leaves the flush to
                // the embedder. Without this commit, post-reload reads
                // see the pre-chaptering state — the band renders fine
                // *in-memory* (Staged still holds the writes) but the
                // next session load loses it. Matches the
                // `sendMessage` pattern that defends against the same
                // bug on the chat path.
                await agentCommitSession(branch);
                _dbg("runChaptering done (manual)", { branch });
            }
        },

        // --- State / commits --------------------------------------------

        async getCurrentCommit(branch) {
            return agentGetCurrentCommit(branch);
        },

        async undoToCommit(branch, hash) {
            await agentUndoToCommit(branch, hash);
        },

        // --- VFS ---------------------------------------------------------

        async listFiles(branch) {
            return agentListFiles(branch);
        },

        async readFile(branch, path) {
            return agentReadFile(branch, path);
        },

        async fileSize(branch, path) {
            return agentFileSize(branch, path);
        },

        async writeFiles(branch, files) {
            await agentWriteFiles(branch, files);
        },

        async deleteFiles(branch, paths) {
            await agentDeleteFiles(branch, paths);
        },

        async readAppFiles(branch) {
            return agentReadAppFiles(branch);
        },

        async readAppBinaries(branch) {
            return agentReadAppBinaries(branch);
        },

        async wipeAgentMemory(branch) {
            await agentWipeAgentMemory(branch);
        },

        // --- Bundle payloads --------------------------------------------
        //
        // Bundle ops read/write a branch's commit subgraph directly on the
        // shared `VersionedKV`, independent of the per-session agent pool.

        async exportBundlePayload(branch, /** @type {ExportBundleOptions} */ opts = {}) {
            const versioned = await agentGetSharedVersioned();
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
            const versioned = await agentGetSharedVersioned();
            const result = await bundleImport(versioned, payload);
            return result;
        },

        async getBundleStats(branch) {
            const versioned = await agentGetSharedVersioned();
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
            return agentLoadHistory(branch);
        },

        // --- Query / cache bridges --------------------------------------

        async runQuery(_branch, _code, _resultVars) {
            throw new Error(RUN_QUERY_NOT_YET);
        },

        async getCacheValue(branch, key) {
            return agentGetCacheValue(branch, key);
        },

        async spawn(branch, spec, signal) {
            return agentSpawnFromApp(branch, spec, { signal });
        },

        // --- Token telemetry --------------------------------------------

        async estimateLogTokens(branch) {
            return agentEstimateLogTokens(branch);
        },

        async getTokenHistory(branch) {
            return agentGetTokenHistory(branch);
        },

        // --- Debug -------------------------------------------------------

        async getSessionDebugInfo(branch) {
            return agentGetSessionDebugInfo(branch);
        },
    };
}
