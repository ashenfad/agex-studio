/**
 * `PyKernelAdapter` — `KernelAdapter` implementation for the Pyodide
 * (agex-py) kernel.
 *
 * Thin delegation layer over the existing studio surface in
 * `agent.js`, `sessions.js`, `pyodide.js`. The adapter's role is
 * shape-translation, not new logic:
 *
 *   - Adds branch-explicit semantics — every method takes `branch`
 *     and the adapter ensures kvgit's `current_branch` matches
 *     before dispatching the underlying call. The studio's existing
 *     functions assume "the active branch" (== `_state.current_branch`);
 *     the adapter makes that assumption local rather than implicit.
 *   - Encapsulates the two-wave Pyodide init (history-ready vs.
 *     send-ready) behind a single async `init`, with stage milestones
 *     surfaced via `opts.onStage` so the shell can keep its
 *     progressive-render flow.
 *   - Reshapes a few signatures to match the typedef (Uint8Array
 *     instead of base64 for VFS reads/writes; `fresh: bool` for
 *     test_app rather than a pre-fetched seed; `BundlePayload`'s
 *     `{ bytes, manifest }` shape; etc.).
 *
 * Existing functions in `agent.js` / `sessions.js` are still exported
 * directly for now — call sites migrate to the adapter incrementally.
 * Once migration is complete (later in Phase 4), the existing exports
 * can be removed and the adapter becomes the only entry point.
 */

import {
    initAgentBasics,
    initAgentRich,
    listFiles as agentListFiles,
    readFile as agentReadFile,
    uploadFiles as agentUploadFiles,
    deleteFiles as agentDeleteFiles,
    sendMessage as agentSendMessage,
    runQuery as agentRunQuery,
    runChaptering as agentRunChaptering,
    estimateLogTokens as agentEstimateLogTokens,
    getTokenHistory as agentGetTokenHistory,
} from "./agent.js";
import {
    loadHistory,
    getCurrentCommit,
    undoToCommit,
    getBundleStats,
    exportBundle,
    importBundle,
    getSessionDebugInfo,
} from "./sessions.js";
import { runPython, startWorker, startWave3, pyodideStore } from "./pyodide.js";

/**
 * @typedef {import('./kernel-adapter.js').KernelAdapter} KernelAdapter
 * @typedef {import('./kernel-adapter.js').KernelSettings} KernelSettings
 * @typedef {import('./kernel-adapter.js').InitOptions} InitOptions
 * @typedef {import('./kernel-adapter.js').BranchMeta} BranchMeta
 * @typedef {import('./kernel-adapter.js').CreateBranchOptions} CreateBranchOptions
 * @typedef {import('./kernel-adapter.js').SendMessageOptions} SendMessageOptions
 * @typedef {import('./kernel-adapter.js').ExportBundleOptions} ExportBundleOptions
 * @typedef {import('./kernel-adapter.js').BundlePayload} BundlePayload
 */

const STAGE_ORDER = ["idle", "loading", "history-ready", "send-ready"];

/** Resolve once `pyodideStore` reaches `target` (or higher). */
function _waitForStage(target) {
    const targetIdx = STAGE_ORDER.indexOf(target);
    return new Promise((resolve, reject) => {
        let unsub = null;
        let settled = false;
        const stop = () => {
            settled = true;
            if (unsub) unsub();
        };
        unsub = pyodideStore.subscribe((s) => {
            if (settled) return;
            if (s.stage === "error") {
                stop();
                reject(new Error(s.error || "pyodide stage error"));
                return;
            }
            if (STAGE_ORDER.indexOf(s.stage) >= targetIdx) {
                stop();
                resolve();
            }
        });
    });
}

/** Escape a branch name for safe interpolation into a Python heredoc.
 *  Branch names from session creation are uuid-style, so this is
 *  defense-in-depth — but external bundles can land arbitrary strings
 *  on import, and we want the kvgit reads/writes to fail loudly rather
 *  than silently target the wrong branch on a malformed name. */
function _esc(branch) {
    return String(branch || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function _b64encode(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}

function _b64decode(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/**
 * Construct a `KernelAdapter` instance bound to the agex-py / Pyodide
 * kernel. The studio runs at most one Pyodide worker, so this is
 * effectively a singleton — but the factory shape matches what the Ts
 * adapter will expose, and keeps each adapter instance's state local.
 *
 * @returns {KernelAdapter}
 */
export function createPyAdapter() {
    let initialized = false;
    /** @type {string | null} */
    let activeBranch = null;
    /** @type {Promise<void> | null} */
    let initInFlight = null;

    /** Switch kvgit's current branch to `branch` if not already there.
     *  Caches the last switch to avoid redundant Python round-trips. */
    async function _ensureBranch(branch) {
        if (activeBranch === branch) return;
        await runPython(`
_state = _agent.state("default")
if _state.current_branch != "${_esc(branch)}":
    _state.switch_branch("${_esc(branch)}")
        `);
        activeBranch = branch;
    }

    return {
        kernel: "py",

        // --- Lifecycle ---------------------------------------------------

        async init(/** @type {KernelSettings} */ settings, /** @type {InitOptions} */ opts = {}) {
            if (initialized) {
                // Re-init for settings change. Today's two-wave flow
                // doesn't support clean re-init (clear_agent_registry +
                // rebuild from scratch is non-trivial), so this is a
                // no-op for now. Settings updates require a page
                // reload until we wire this up properly.
                return;
            }
            if (initInFlight) return initInFlight;
            initInFlight = (async () => {
                startWorker();
                await _waitForStage("history-ready");
                await initAgentBasics(settings);
                opts.onStage?.("history-ready");
                startWave3();
                await _waitForStage("send-ready");
                await initAgentRich(settings);
                opts.onStage?.("send-ready");
                initialized = true;
            })();
            try {
                await initInFlight;
            } finally {
                initInFlight = null;
            }
        },

        async dispose() {
            // No-op for now. Pyodide worker teardown isn't currently
            // wired up; the studio relies on tab close. When lazy
            // re-init lands (Phase 4 thread 3), this becomes
            // meaningful.
        },

        // --- Branch operations -------------------------------------------

        async listBranches() {
            const json = await runPython(`
import json as _json
_state = _agent.state("default")
_branches = [b for b in _state.list_branches() if b.startswith("chat-")]
_json.dumps(_branches)
            `);
            return JSON.parse(json);
        },

        async createBranch(name, /** @type {CreateBranchOptions} */ opts = {}) {
            // Two modes:
            //   - opts.from set:  fork from the named branch's HEAD.
            //     We temp-switch to it, then create_branch (which
            //     forks current), so the new branch inherits HEAD.
            //   - opts.from unset: fresh branch off initial_commit.
            //
            // Matches existing forkSession's pattern. Either way, the
            // new branch becomes active when we return.
            const fromBranch = opts.from || null;
            await runPython(`
from datetime import datetime as _dt, timezone as _tz
_state = _agent.state("default")
${
    fromBranch
        ? `_state.switch_branch("${_esc(fromBranch)}")
_state.create_branch("${_esc(name)}")`
        : `_state.create_branch("${_esc(name)}", at=_state.versioned.initial_commit)`
}
_state.switch_branch("${_esc(name)}")
_state["__session_updated__"] = _dt.now(_tz.utc).isoformat()
_state["__session_kernel__"] = "py"
_state.commit()
            `);
            activeBranch = name;
        },

        async deleteBranch(name) {
            await runPython(`
_state = _agent.state("default")
_target = "${_esc(name)}"
if _state.current_branch == _target:
    _other = [b for b in _state.list_branches() if b.startswith("chat-") and b != _target]
    if _other:
        _other.sort(key=lambda b: _state.peek("__session_updated__", branch=b) or "", reverse=True)
        _state.switch_branch(_other[0])
    else:
        # Last chat branch — adapter doesn't fabricate a replacement
        # here; the shell decides what to render after deletion.
        # Switch back to whatever non-chat branch exists (kvgit always
        # has at least the default/main branch).
        for _b in _state.list_branches():
            if _b != _target:
                _state.switch_branch(_b)
                break
_state.delete_branch(_target)
            `);
            // Invalidate cached active-branch — kvgit's switch happened
            // server-side, our cached value may now be stale.
            activeBranch = null;
        },

        async readBranchMeta(name) {
            const json = await runPython(`
import json as _json
_state = _agent.state("default")
_b = "${_esc(name)}"
_json.dumps({
    "title": _state.peek("__session_title__", branch=_b) or "New Chat",
    "name": _state.peek("__session_name__", branch=_b) or "",
    "description": _state.peek("__session_description__", branch=_b) or "",
    "updated": _state.peek("__session_updated__", branch=_b) or "",
})
            `);
            return JSON.parse(json);
        },

        async writeBranchMeta(name, patch) {
            // Build the SET lines from the patch.  Quote escaping mirrors
            // sessions.js's setSessionMeta — JSON.stringify produces a
            // valid Python string literal for any unicode content.
            const setLines = [];
            if (patch.title !== undefined) {
                setLines.push(`_state["__session_title__"] = ${JSON.stringify(patch.title)}`);
            }
            if (patch.name !== undefined) {
                setLines.push(`_state["__session_name__"] = ${JSON.stringify(patch.name)}`);
            }
            if (patch.description !== undefined) {
                setLines.push(`_state["__session_description__"] = ${JSON.stringify(patch.description)}`);
            }
            if (patch.updated !== undefined) {
                setLines.push(`_state["__session_updated__"] = ${JSON.stringify(patch.updated)}`);
            } else {
                // Default: bump updated alongside any other write so
                // session-list ordering reflects the edit.
                setLines.push(
                    `from datetime import datetime as _dt, timezone as _tz`,
                );
                setLines.push(
                    `_state["__session_updated__"] = _dt.now(_tz.utc).isoformat()`,
                );
            }
            await runPython(`
_state = _agent.state("default")
_branch = "${_esc(name)}"
_cur = _state.current_branch
_switched = False
if _branch != _cur:
    _state.switch_branch(_branch)
    _switched = True
try:
    ${setLines.join("\n    ")}
    _state.commit()
finally:
    if _switched:
        _state.switch_branch(_cur)
            `);
            // Active branch unchanged from caller's POV.
        },

        // --- Messaging ---------------------------------------------------

        async sendMessage(branch, message, /** @type {SendMessageOptions} */ opts = {}) {
            await _ensureBranch(branch);
            // signal + onEvent are not yet plumbed through the existing
            // sendMessage in agent.js; honor onToken for now and leave
            // the others as TODO (full plumbing lands when the chat
            // shell migrates to the adapter).
            return agentSendMessage(message, opts.onToken);
        },

        async runChaptering(branch) {
            await _ensureBranch(branch);
            await agentRunChaptering();
        },

        // --- State / commits --------------------------------------------

        async getCurrentCommit(branch) {
            await _ensureBranch(branch);
            return getCurrentCommit();
        },

        async undoToCommit(branch, hash) {
            await _ensureBranch(branch);
            await undoToCommit(hash);
        },

        // --- VFS ---------------------------------------------------------

        async listFiles(branch) {
            await _ensureBranch(branch);
            return agentListFiles();
        },

        async readFile(branch, path) {
            await _ensureBranch(branch);
            // Existing readFile returns the decoded UTF-8 string; the
            // adapter contract is bytes. Re-encode to bytes here. Lossy
            // for binary files — once call-site migration lands, the
            // existing readFile will be replaced with one that returns
            // raw bytes natively (using fs.read(path) directly).
            const text = await agentReadFile(path);
            return new TextEncoder().encode(text);
        },

        async writeFiles(branch, files) {
            await _ensureBranch(branch);
            // Existing uploadFiles takes Array<{name, data: base64}>.
            const payload = Object.entries(files).map(([name, bytes]) => ({
                name,
                data: _b64encode(bytes),
            }));
            await agentUploadFiles(payload);
        },

        async deleteFiles(branch, paths) {
            await _ensureBranch(branch);
            await agentDeleteFiles(paths);
        },

        // --- Bundle payloads --------------------------------------------

        async exportBundlePayload(branch, /** @type {ExportBundleOptions} */ opts = {}) {
            // exportBundle is branch-parameterized at the kvgit level —
            // doesn't need _ensureBranch, but harmless if called.
            const { bytes, manifest } = await exportBundle(branch, opts.onProgress);
            return { bytes, manifest };
        },

        async importBundlePayload(payload) {
            const { branch, manifest } = await importBundle(payload);
            // The existing importBundle switches kvgit to the new
            // branch; mirror that in our cached active-branch.
            activeBranch = branch;
            return { branch, manifest };
        },

        async getBundleStats(branch) {
            // getBundleStats walks the kvgit subgraph for `branch`
            // directly — branch-parameterized, no _ensureBranch needed.
            return getBundleStats(branch);
        },

        // --- History rendering ------------------------------------------

        async loadHistory(branch) {
            await _ensureBranch(branch);
            return loadHistory();
        },

        // --- Query bridge -----------------------------------------------

        async runQuery(branch, code, resultVars) {
            await _ensureBranch(branch);
            return agentRunQuery(code, resultVars);
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
            // Existing getSessionDebugInfo handles its own switch+restore
            // dance internally, so it works on any branch.
            return getSessionDebugInfo(branch);
        },
    };
}
