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
    fileSize as agentFileSize,
    downloadFile as agentDownloadFile,
    uploadFiles as agentUploadFiles,
    deleteFiles as agentDeleteFiles,
    readAppFiles as agentReadAppFiles,
    sendMessage as agentSendMessage,
    runQuery as agentRunQuery,
    runChaptering as agentRunChaptering,
    estimateLogTokens as agentEstimateLogTokens,
    getTokenHistory as agentGetTokenHistory,
} from "./agent.js";
import {
    runPython,
    runPythonStreaming,
    startWorker,
    startWave3,
    pyodideStore,
} from "./pyodide.js";

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

/** Resolve once `pyodideStore` reaches `target` (or higher).
 *
 *  Svelte stores invoke the subscriber synchronously on `subscribe(...)`.
 *  If the store is already past `target`, the subscriber sets `settled`
 *  and tries to call `unsub()` — but `unsub` hasn't been assigned yet
 *  at that point, so the subscription would leak. The post-subscribe
 *  fixup line catches that case: when the synchronous fire already
 *  resolved, we call the now-defined `unsub` from the outer scope. */
function _waitForStage(target) {
    const targetIdx = STAGE_ORDER.indexOf(target);
    return new Promise((resolve, reject) => {
        let unsub = null;
        let settled = false;
        unsub = pyodideStore.subscribe((s) => {
            if (settled) return;
            if (s.stage === "error") {
                settled = true;
                if (unsub) unsub();
                reject(new Error(s.error || "pyodide stage error"));
                return;
            }
            if (STAGE_ORDER.indexOf(s.stage) >= targetIdx) {
                settled = true;
                if (unsub) unsub();
                resolve();
            }
        });
        // Subscriber may have settled synchronously above (store
        // already at or past target). `unsub` was null at that
        // moment; call it now that we have the real reference.
        if (settled && unsub) unsub();
    });
}

/** Escape a branch name for safe interpolation into a Python heredoc.
 *  Branch names from session creation are uuid-style, so this is
 *  defense-in-depth — but external bundles can land arbitrary strings
 *  on import, and we want the kvgit reads/writes to fail loudly rather
 *  than silently target the wrong branch on a malformed name.
 *
 *  Escapes backslashes, double quotes, and newlines — a literal
 *  newline in a branch name would terminate the Python string literal
 *  inside the heredoc and produce a SyntaxError in the worker.
 *  (sessions.js uses a similar two-replace pattern; once Phase 5
 *  surfaces a real cross-kernel escaper need, consolidate.) */
function _esc(branch) {
    return String(branch || "")
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n");
}

function _b64encode(bytes) {
    // Chunked apply: `String.fromCharCode(...arr)` blows the call
    // stack on multi-MB Uint8Arrays, and byte-at-a-time concat is
    // O(n²). 8192 is a typical safe chunk size that keeps both
    // failure modes off the table for files up to ~hundreds of MB.
    const CHUNK = 8192;
    let bin = "";
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(
            null,
            bytes.subarray(i, i + CHUNK),
        );
    }
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
                // Await the callback — lets the shell load history /
                // sessions / files before we kick Wave 3, matching the
                // existing serialized flow that keeps Wave-3's heavy
                // package install from competing with shell-side reads.
                await opts.onStage?.("history-ready");
                startWave3();
                await _waitForStage("send-ready");
                await initAgentRich(settings);
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

        async listBranchesWithMeta() {
            const json = await runPython(`
import json as _json
_state = _agent.state("default")
_out = []
for _b in _state.list_branches():
    if not _b.startswith("chat-"):
        continue
    _out.append({
        "branch": _b,
        "title": _state.peek("__session_title__", branch=_b) or "New Chat",
        "name": _state.peek("__session_name__", branch=_b) or "",
        "description": _state.peek("__session_description__", branch=_b) or "",
        "updated": _state.peek("__session_updated__", branch=_b) or "",
        "external": bool(_state.peek("__session_external__", branch=_b)),
    })
_json.dumps(_out)
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
    "external": bool(_state.peek("__session_external__", branch=_b)),
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
            if (patch.external !== undefined) {
                // Python wants `True` / `False`; JSON.stringify(true)
                // produces lowercase `true` which raises NameError.
                setLines.push(
                    `_state["__session_external__"] = ${patch.external ? "True" : "False"}`,
                );
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
            const json = await runPython(`
import json as _json
_state = _agent.state("default")
_json.dumps(_state.current_commit)
            `);
            return JSON.parse(json);
        },

        async undoToCommit(branch, hash) {
            await _ensureBranch(branch);
            await runPython(`
_state = _agent.state("default")
_state.reset_to("${_esc(hash)}")
            `);
        },

        // --- VFS ---------------------------------------------------------

        async listFiles(branch) {
            await _ensureBranch(branch);
            return agentListFiles();
        },

        async readFile(branch, path) {
            await _ensureBranch(branch);
            // Use the base64 transport so binary files round-trip
            // intact. The agent.js text-decoded `readFile` is lossy
            // for non-UTF-8 content; `downloadFile` returns base64 of
            // the raw bytes which we decode back to a Uint8Array.
            const b64 = await agentDownloadFile(path);
            return _b64decode(b64);
        },

        async fileSize(branch, path) {
            await _ensureBranch(branch);
            return agentFileSize(path);
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

        async readAppFiles(branch) {
            await _ensureBranch(branch);
            return agentReadAppFiles();
        },

        async readAppBinaries(_branch) {
            // Py-kernel binary-asset support isn't wired through the
            // pyodide bridge yet; live preview still works for
            // text-only apps. Returning an empty map keeps the
            // KernelAdapter contract honored without changing
            // existing py-kernel behavior.
            return {};
        },

        async wipeAgentMemory(_branch) {
            // Py-kernel doesn't currently expose a wipe path through
            // the pyodide bridge. Fresh-chat forks against py
            // sessions will inherit the full memory state — the
            // ForkModal hides the option for py sessions to avoid
            // a silent no-op. Throw here so a stray caller fails
            // loudly rather than silently degrading.
            throw new Error(
                "wipeAgentMemory not implemented for the py kernel — " +
                    "fresh-chat fork is TS-only for now.",
            );
        },

        // --- Bundle payloads --------------------------------------------

        async exportBundlePayload(branch, /** @type {ExportBundleOptions} */ opts = {}) {
            const onProgress = opts.onProgress;
            const code = `
import json as _json, base64 as _b64
import bundle as _bundle
_state = _agent.state("default")
_v = _state.versioned
_branch = ${JSON.stringify(branch)}
_name = _state.peek("__session_name__", branch=_branch) or ""
_desc = _state.peek("__session_description__", branch=_branch) or ""
_title = _state.peek("__session_title__", branch=_branch) or ""
_kernel = _state.peek("__session_kernel__", branch=_branch) or "py"
_display = _name or _title

def _progress(phase, done, total):
    _post_token(_run_id, {"phase": phase, "done": done, "total": total})

_data = _bundle.export_bundle(_v, _branch, name=_display, description=_desc, kernel=_kernel, progress=_progress)
_manifest = _bundle.inspect_bundle(_data)
_json.dumps({"b64": _b64.b64encode(_data).decode(), "manifest": _manifest})
            `;
            const json = await runPythonStreaming(code, (token) => {
                if (onProgress && token && typeof token.phase === "string") {
                    onProgress(token);
                }
            });
            const obj = JSON.parse(json);
            const bytes = _b64decode(obj.b64);
            return { bytes, manifest: obj.manifest };
        },

        async importBundlePayload(payload) {
            const b64 = _b64encode(payload);
            const json = await runPython(`
import json as _json, base64 as _b64
import bundle as _bundle
_state = _agent.state("default")
_v = _state.versioned
_data = _b64.b64decode(${JSON.stringify(b64)})
_branch, _manifest = _bundle.import_bundle(_v, _data)
_state.switch_branch(_branch)
_json.dumps({"branch": _branch, "manifest": _manifest})
            `);
            const result = JSON.parse(json);
            activeBranch = result.branch;
            return { branch: result.branch, manifest: result.manifest };
        },

        async getBundleStats(branch) {
            const json = await runPython(`
import json as _json
import bundle as _bundle
_state = _agent.state("default")
_v = _state.versioned
_branch = ${JSON.stringify(branch)}
_stats = _bundle.bundle_stats(_v, _branch)
_stats["name"] = _state.peek("__session_name__", branch=_branch) or ""
_stats["description"] = _state.peek("__session_description__", branch=_branch) or ""
_stats["title"] = _state.peek("__session_title__", branch=_branch) or ""
_stats["kernel"] = _state.peek("__session_kernel__", branch=_branch) or "py"
_json.dumps(_stats)
            `);
            return JSON.parse(json);
        },

        /** Snapshot-shaped publishing is a ts-kernel capability; null
         *  tells the publish flow to skip the shape-options stage. */
        async profilePublishSizes(_branch) {
            return null;
        },

        /** Compact-copy forks are ts-only too — the fork modal
         *  disables the option for py sessions before this could be
         *  reached. */
        async snapshotToBranch(_sourceBranch, _destBranch, _opts = {}) {
            throw new Error("compact copy is not supported for py sessions");
        },

        // --- History rendering ------------------------------------------

        async loadHistory(branch) {
            await _ensureBranch(branch);
            const json = await runPython(`
import json as _json
from agex import events as _get_events
from agex.agent.events import (
    TaskStartEvent as _TaskStart,
    SuccessEvent as _SuccessEvent,
    FailEvent as _FailEvent,
    FileEvent as _FileEvent,
    CancelledEvent as _CancelledEvent,
)
# Helper functions (_output_text, _serialize_output_parts, _split_output_events,
# _serialize_chapter_events) and event types (_ActionEvent, _OutputEvent,
# _ChapterEvent) are defined in initAgent

_state = _agent.state("default")
_all = _get_events(_state)
_pre = [e for e in _all if e.source != "setup"]

# Flatten chapters: expand ChapterEvents into their original events,
# collecting chapter metadata for the chaptering bands.
_flat = []
_chapter_meta = []

def _do_flatten(evts, collect=True):
    for _e in evts:
        if isinstance(_e, _ChapterEvent):
            if collect:
                _chapter_meta.append({
                    "name": _e.name,
                    "message": _e.message,
                    "events": _serialize_chapter_events(_e.resolve_events(_state), _state),
                })
            _do_flatten(_e.resolve_events(_state), collect=False)
        else:
            _flat.append(_e)

_do_flatten(_pre)

_messages = []
_current_events = []
_current_task = None

for _evt in _flat:
    if isinstance(_evt, _TaskStart):
        _current_events = []
        _current_task = _evt.task_name
        if _evt.task_name == "__chapter__":
            _messages.append({
                "role": "chaptering",
                "timestamp": _evt.timestamp.isoformat(),
                "commit_hash": getattr(_evt, "commit_hash", None) or "",
                "chapters": [],
            })
        else:
            _messages.append({
                "role": "user",
                "content": _evt.inputs.get("message", str(_evt.inputs)),
                "timestamp": _evt.timestamp.isoformat(),
                "commit_hash": getattr(_evt, "commit_hash", None) or "",
            })
    elif isinstance(_evt, _ActionEvent):
        _action_dict = _synthesize_action(_evt)
        _report_text = _action_dict.get("report", "") or ""
        _current_events.append(_action_dict)
        if _report_text:
            _messages.append({
                "role": "agent",
                "content": _report_text,
                "isReport": True,
                "timestamp": _evt.timestamp.isoformat(),
            })
    elif isinstance(_evt, _OutputEvent):
        _current_events.extend(_split_output_events(_serialize_output_parts(_evt)))
    elif isinstance(_evt, _FileEvent) and _evt.file_source == "user":
        _parts = []
        _upload_items = []
        if _evt.added:
            _upload_items.extend(f"\`{f}\`" for f in sorted(_evt.added))
        if _evt.modified:
            _upload_items.extend(f"\`{f}\`" for f in sorted(_evt.modified))
        if _upload_items:
            if len(_upload_items) == 1:
                _parts.append(f"**Uploaded:** {_upload_items[0]}")
            else:
                _list = "\\n".join(f"- {i}" for i in _upload_items)
                _parts.append(f"**Uploaded {len(_upload_items)} files:**\\n{_list}")
        if _evt.removed:
            _del_items = [f"\`{f}\`" for f in sorted(_evt.removed)]
            if len(_del_items) == 1:
                _parts.append(f"**Deleted:** {_del_items[0]}")
            else:
                _list = "\\n".join(f"- {i}" for i in _del_items)
                _parts.append(f"**Deleted {len(_del_items)} files:**\\n{_list}")
        _content = "  \\n".join(_parts) if _parts else "**File change**"
        _messages.append({
            "role": "user",
            "content": _content,
            "timestamp": _evt.timestamp.isoformat(),
            "commit_hash": getattr(_evt, "commit_hash", None) or "",
            "isMarkdown": True,
        })
    elif isinstance(_evt, _SuccessEvent):
        if _current_task == "__chapter__":
            _n = 0
            if isinstance(_evt.result, list):
                _n = sum(1 for _ch in _evt.result if hasattr(_ch, 'name'))
            _take = min(_n, len(_chapter_meta))
            if _take > 0:
                for _bm in reversed(_messages):
                    if _bm["role"] == "chaptering":
                        _bm["chapters"] = list(_chapter_meta[:_take])
                        break
                _chapter_meta = _chapter_meta[_take:]
            _current_events = []
            _current_task = None
        else:
            _r = _evt.result
            if hasattr(_r, "normalize") and hasattr(_r, "parts"):
                _result_data = {"type": "response", "parts": _r.normalize()}
            else:
                _result_data = {"type": "text", "content": str(_r) if _r is not None else ""}
            _messages.append({
                "role": "agent",
                "content": _result_data,
                "events": list(_current_events),
                "timestamp": _evt.timestamp.isoformat(),
            })
            _current_events = []
            _current_task = None
    elif isinstance(_evt, _CancelledEvent):
        _messages.append({
            "role": "agent",
            "content": {"type": "text", "content": ""},
            "events": list(_current_events),
            "timestamp": _evt.timestamp.isoformat(),
            "cancelled": True,
        })
        _current_events = []
        _current_task = None
    elif isinstance(_evt, _FailEvent):
        _err_msg = str(_evt.error) if hasattr(_evt, "error") else "Task failed"
        _messages.append({
            "role": "agent",
            "content": {"type": "text", "content": f"Error: {_err_msg}"},
            "events": list(_current_events),
            "timestamp": _evt.timestamp.isoformat(),
        })
        _current_events = []
        _current_task = None

# Flush any orphan events (no TaskStart preceded them)
if _current_events and _current_task is None:
    from datetime import datetime as _dt
    _messages.append({
        "role": "agent",
        "content": {"type": "text", "content": ""},
        "events": list(_current_events),
        "timestamp": _dt.now().isoformat(),
    })

_json.dumps(_messages)
            `);
            const raw = JSON.parse(json);
            return raw.map((m) => ({
                ...m,
                timestamp: new Date(m.timestamp),
            }));
        },

        // --- Query / cache bridges --------------------------------------

        async runQuery(branch, code, resultVars) {
            await _ensureBranch(branch);
            return agentRunQuery(code, resultVars);
        },

        async getCacheValue(_branch, _key) {
            // Mirror to the TS adapter's `runQuery` stub — symmetric
            // "each kernel has one bridge wired, one stub" until we
            // close the gap on the other side. py apps use `runQuery`
            // for app↔agent data passing today; if `getCacheValue` ergonomics
            // become useful here too, wire via agex.cache.Cache.
            throw new Error(
                "getCacheValue not yet implemented for the Py kernel — " +
                    "use runQuery for app↔agent data passing on this kernel.",
            );
        },

        async spawn(_branch, _spec, _signal) {
            // `spawn` is a TS-kernel feature for now (agex-ts's native
            // spawn). The Py kernel has no equivalent host entry yet.
            throw new Error(
                "spawn is not available on the Py kernel — " +
                    "sub-tasks are a TypeScript-kernel feature.",
            );
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
            const json = await runPython(`
import json as _json

_state = _agent.state("default")
_v = _state.versioned

# Temporarily switch to the target branch to read its state
_prev = _v.current_branch
_v.switch_branch("${_esc(branch)}")

_commits = list(_v.history())
_all_keys = list(_v.keys())
_user_keys = sorted(k for k in _all_keys if not k.startswith("__"))

# Measure storage: sum raw byte sizes of all values at HEAD
_values = _v.get_many(*_all_keys) if _all_keys else {}
_total_bytes = sum(len(v) for v in _values.values())

# Per-key sizes for the top consumers
_key_sizes = {}
for _k, _val in _values.items():
    _key_sizes[_k] = len(_val)
_top_keys = sorted(_key_sizes.items(), key=lambda x: -x[1])[:10]

_result = _json.dumps({
    "branch": "${_esc(branch)}",
    "commit": _v.current_commit[:12] if _v.current_commit else None,
    "commits": len(_commits),
    "keys_total": len(_all_keys),
    "keys": _user_keys,
    "bytes": _total_bytes,
    "top_keys": [{"key": k, "bytes": s} for k, s in _top_keys],
})

# Switch back
_v.switch_branch(_prev)
_result
            `);
            return JSON.parse(json);
        },
    };
}
