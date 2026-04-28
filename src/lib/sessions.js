/**
 * Session management — branch-based chat sessions via agex versioned state.
 *
 * Each session maps to a kvgit branch. Session metadata (title, updated
 * timestamp) is stored as special keys in the branch's state.
 */

import { runPython, runPythonStreaming } from "./pyodide.js";

const CURRENT_BRANCH_KEY = "agex-current-branch";

/** @type {((s: SessionState) => void)[]} */
let subscribers = [];

/**
 * @typedef {Object} Session
 * @property {string} branch
 * @property {string} title
 * @property {string} updated - ISO 8601 timestamp
 */

/**
 * @typedef {Object} SessionState
 * @property {string} currentBranch
 * @property {Session[]} sessions
 */

/** @type {SessionState} */
let state = {
    currentBranch: "",
    sessions: [],
};

function notify() {
    for (const fn of subscribers) fn(state);
}

function update(/** @type {Partial<SessionState>} */ patch) {
    state = { ...state, ...patch };
    notify();
}

export const sessionStore = {
    subscribe(fn) {
        subscribers.push(fn);
        fn(state);
        return () => {
            subscribers = subscribers.filter((s) => s !== fn);
        };
    },
};

/** Initialize session system — call after agent init. Creates first session if needed. */
export async function initSessions() {
    const saved = localStorage.getItem(CURRENT_BRANCH_KEY);

    const json = await runPython(`
import json as _json
import uuid as _uuid
from datetime import datetime as _dt, timezone as _tz
import app_storage as _app_storage

_state = _agent.state("default")
_branches = _state.list_branches()
_saved_branch = "${saved || ""}"

# Find or create a chat branch
if _saved_branch and _saved_branch in _branches:
    _current = _saved_branch
    _state.switch_branch(_current)
elif any(b.startswith("chat-") for b in _branches):
    _current = sorted(
        [b for b in _branches if b.startswith("chat-")],
        key=lambda b: _state.peek("__session_updated__", branch=b) or "",
        reverse=True,
    )[0]
    _state.switch_branch(_current)
else:
    _current = f"chat-{_uuid.uuid4().hex[:8]}"
    _state.create_branch(_current, at=_state.versioned.initial_commit)
    _state.switch_branch(_current)
    _state["__session_updated__"] = _dt.now(_tz.utc).isoformat()
    _state.commit()

# Build session list
_sessions = []
for _b in _branches:
    if not _b.startswith("chat-"):
        continue
    _sessions.append({
        "branch": _b,
        "title": _state.peek("__session_title__", branch=_b) or "New Chat",
        "name": _state.peek("__session_name__", branch=_b) or "",
        "description": _state.peek("__session_description__", branch=_b) or "",
        "updated": _state.peek("__session_updated__", branch=_b) or "",
        "app_storage_bytes": _app_storage.size(_state.versioned, _b),
    })
if _current not in [s["branch"] for s in _sessions]:
    _sessions.append({
        "branch": _current,
        "title": "New Chat",
        "name": "",
        "description": "",
        "updated": _state.peek("__session_updated__", branch=_current) or "",
        "app_storage_bytes": _app_storage.size(_state.versioned, _current),
    })

_sessions.sort(key=lambda s: s["updated"], reverse=True)
_json.dumps({"current": _current, "sessions": _sessions})
    `);

    const data = JSON.parse(json);
    localStorage.setItem(CURRENT_BRANCH_KEY, data.current);
    update({ currentBranch: data.current, sessions: data.sessions });
}

/** Create a new chat session and switch to it. */
export async function createSession() {
    const json = await runPython(`
import json as _json
import uuid as _uuid
from datetime import datetime as _dt, timezone as _tz

_state = _agent.state("default")
_new = f"chat-{_uuid.uuid4().hex[:8]}"
_state.create_branch(_new, at=_state.versioned.initial_commit)
_state.switch_branch(_new)
_state["__session_updated__"] = _dt.now(_tz.utc).isoformat()
_state.commit()
_json.dumps(_new)
    `);

    const branch = JSON.parse(json);
    localStorage.setItem(CURRENT_BRANCH_KEY, branch);
    await refreshSessionList(branch);
}

/** Switch to an existing session. */
export async function switchSession(branch) {
    const escaped = branch.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    await runPython(`
_state = _agent.state("default")
_state.switch_branch("${escaped}")
    `);

    localStorage.setItem(CURRENT_BRANCH_KEY, branch);
    await refreshSessionList(branch);
}

/** Delete a session. Switches to another only if deleting the current one.
 *
 * Does the delete + branch-switch (if needed) + list-rebuild in a single
 * runPython call.  Splitting these across two calls (as we used to)
 * raced with kvgit's deferred IndexedDB writes — the second call's
 * ``list_branches()`` could see the pre-delete state and the drawer
 * would render with the deleted item still present until the user
 * clicked elsewhere.
 */
export async function deleteSession(branch) {
    const escaped = branch.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const json = await runPython(`
import json as _json
import uuid as _uuid
from datetime import datetime as _dt, timezone as _tz
import app_storage as _app_storage

_state = _agent.state("default")
_target = "${escaped}"

# Only switch branches when deleting the active one — otherwise the
# user expects to stay where they are.
if _state.current_branch == _target:
    _other = [b for b in _state.list_branches() if b.startswith("chat-") and b != _target]
    if _other:
        _other.sort(
            key=lambda b: _state.peek("__session_updated__", branch=b) or "",
            reverse=True,
        )
        _new_current = _other[0]
        _state.switch_branch(_new_current)
    else:
        # Last session — create a fresh blank one to land on.
        _new_current = f"chat-{_uuid.uuid4().hex[:8]}"
        _state.create_branch(_new_current, at=_state.versioned.initial_commit)
        _state.switch_branch(_new_current)
        _state["__session_updated__"] = _dt.now(_tz.utc).isoformat()
        _state.commit()
else:
    _new_current = _state.current_branch

_state.delete_branch(_target)
_app_storage.delete(_state.versioned, _target)

# Rebuild the post-delete session list in this same Python call so
# the JS-side store update is atomic with the delete.
_sessions = []
for _b in _state.list_branches():
    if not _b.startswith("chat-"):
        continue
    _sessions.append({
        "branch": _b,
        "title": _state.peek("__session_title__", branch=_b) or "New Chat",
        "name": _state.peek("__session_name__", branch=_b) or "",
        "description": _state.peek("__session_description__", branch=_b) or "",
        "updated": _state.peek("__session_updated__", branch=_b) or "",
        "app_storage_bytes": _app_storage.size(_state.versioned, _b),
    })
_sessions.sort(key=lambda s: s["updated"], reverse=True)
_json.dumps({"current": _new_current, "sessions": _sessions})
    `);

    const result = JSON.parse(json);
    localStorage.setItem(CURRENT_BRANCH_KEY, result.current);
    update({ currentBranch: result.current, sessions: result.sessions });
}

/** Load chat history from the current session's events. */
export async function loadHistory() {
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
# _serialize_file_actions, _serialize_chapter_events) and event types
# (_ActionEvent, _OutputEvent, _ChapterEvent) are defined in initAgent

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
}

const CHUNK_SIZE = 8;

/**
 * Load history as a chunk manager for lazy rendering.
 * Returns { messages, hasMore, loadMore() }.
 */
export async function loadHistoryChunked() {
    const all = await loadHistory();

    // Group into "units": a user message + everything that follows it
    // until the next user message. A single task often produces several
    // agent messages (intermediate reports + the final success), and
    // they all belong to the same conversational turn. Closing a unit
    // on the first agent message (as we did before) turned a multi-
    // report task into N units and could push the user prompt off the
    // visible chunk window.
    const units = [];
    let current = null;
    for (const msg of all) {
        if (msg.role === 'user') {
            if (current) units.push(current);
            current = [msg];
        } else if (current) {
            current.push(msg);
        } else {
            // Trailing or orphan agent message with no preceding user —
            // treat as its own unit so it still renders.
            units.push([msg]);
        }
    }
    if (current) units.push(current);

    let loadedIndex = Math.max(0, units.length - CHUNK_SIZE);

    function getVisible() {
        return units.slice(loadedIndex).flat();
    }

    return {
        get messages() { return getVisible(); },
        get hasMore() { return loadedIndex > 0; },
        loadMore() {
            const prev = loadedIndex;
            loadedIndex = Math.max(0, loadedIndex - CHUNK_SIZE);
            return loadedIndex < prev;  // true if more were loaded
        },
    };
}

/** Refresh the session list from state. */
async function refreshSessionList(currentBranch) {
    const json = await runPython(`
import json as _json
import app_storage as _app_storage

_state = _agent.state("default")
_branches = _state.list_branches()
_sessions = []
for _b in _branches:
    if not _b.startswith("chat-"):
        continue
    _sessions.append({
        "branch": _b,
        "title": _state.peek("__session_title__", branch=_b) or "New Chat",
        "name": _state.peek("__session_name__", branch=_b) or "",
        "description": _state.peek("__session_description__", branch=_b) or "",
        "updated": _state.peek("__session_updated__", branch=_b) or "",
        "app_storage_bytes": _app_storage.size(_state.versioned, _b),
    })
_sessions.sort(key=lambda s: s["updated"], reverse=True)
_json.dumps(_sessions)
    `);

    update({
        currentBranch: currentBranch,
        sessions: JSON.parse(json),
    });
}

/** Get the current commit hash before a turn starts. */
export async function getCurrentCommit() {
    const json = await runPython(`
import json as _json
_state = _agent.state("default")
_json.dumps(_state.current_commit)
    `);
    return JSON.parse(json);
}

/** Undo the last turn by resetting state to a prior commit. */
export async function undoToCommit(commitHash) {
    const escaped = commitHash.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    await runPython(`
_state = _agent.state("default")
_state.reset_to("${escaped}")
    `);
    await refreshSessionList(state.currentBranch);
}

/** Fork the current session into a new branch from current HEAD. */
export async function forkSession() {
    const json = await runPython(`
import json as _json
import uuid as _uuid
from datetime import datetime as _dt, timezone as _tz
import app_storage as _app_storage

_state = _agent.state("default")
_cur = _state.current_branch
_old_title = _state.peek("__session_title__", branch=_cur) or "New Chat"
_new = f"chat-{_uuid.uuid4().hex[:8]}"
_state.create_branch(_new)
_state.switch_branch(_new)

# Snapshot-copy app storage so each branch mutates its own copy.
_app_storage.copy(_state.versioned, _cur, _new)

_state["__session_title__"] = _old_title + " (fork)"
_state["__session_updated__"] = _dt.now(_tz.utc).isoformat()
_state.commit()
_json.dumps(_new)
    `);

    const branch = JSON.parse(json);
    localStorage.setItem(CURRENT_BRANCH_KEY, branch);
    await refreshSessionList(branch);
}

/**
 * Read the full app-storage dict for a branch. Used as the seed dict
 * inlined into the iframe when the app boots.
 *
 * @param {string} branch
 * @returns {Promise<Record<string,string>>}
 */
export async function getAppStorage(branch) {
    const json = await runPython(`
import json as _json
import app_storage as _app_storage
_state = _agent.state("default")
_json.dumps(_app_storage.read(_state.versioned, ${JSON.stringify(branch)}))
    `);
    return JSON.parse(json);
}

/**
 * Persist a flat {str: str} dict to the branch's app_storage. Writes
 * directly to the raw kvgit store; does not advance HEAD or commit.
 *
 * @param {string} branch
 * @param {Record<string,string>} data
 */
export async function flushAppStorage(branch, data) {
    const payload = JSON.stringify(data || {});
    // Stash into a Python string and decode inside, so arbitrarily
    // large payloads don't need to be re-escaped into the source.
    const json = await runPython(`
import json as _json
import app_storage as _app_storage
_state = _agent.state("default")
_raw = ${JSON.stringify(payload)}
_app_storage.write(_state.versioned, ${JSON.stringify(branch)}, _json.loads(_raw))
_json.dumps(_app_storage.size(_state.versioned, ${JSON.stringify(branch)}))
    `);
    const newSize = JSON.parse(json);
    // Patch just this branch's size in the local store so the drawer
    // badge updates live without a full session-list rebuild per flush.
    update({
        sessions: state.sessions.map((s) =>
            s.branch === branch ? { ...s, app_storage_bytes: newSize } : s,
        ),
    });
}

/**
 * Clear the non-versioned app-storage blob for a branch. Does not
 * create a commit. The next iframe boot for this branch seeds an
 * empty storage dict.
 *
 * @param {string} branch
 */
export async function resetAppStorage(branch) {
    await runPython(`
import app_storage as _app_storage
_state = _agent.state("default")
_app_storage.delete(_state.versioned, ${JSON.stringify(branch)})
    `);
    await refreshSessionList(state.currentBranch);
}

/**
 * Serialized byte size of a branch's app storage. Zero if unset.
 *
 * @param {string} branch
 * @returns {Promise<number>}
 */
export async function getAppStorageSize(branch) {
    const json = await runPython(`
import json as _json
import app_storage as _app_storage
_state = _agent.state("default")
_json.dumps(_app_storage.size(_state.versioned, ${JSON.stringify(branch)}))
    `);
    return JSON.parse(json);
}

/**
 * Cheap preview of what a bundle export would contain — walks the
 * reachable subgraph but skips the zip/base64 step. Fast enough to run
 * when the export modal opens.
 *
 * @param {string} branch
 * @returns {Promise<{ branch: string, head: string, commits: number, nodes: number, blobs: number, name: string, description: string, title: string }>}
 */
export async function getBundleStats(branch) {
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
_json.dumps(_stats)
    `);
    return JSON.parse(json);
}

/**
 * Export a session branch as a self-contained bundle (ZIP bytes).
 * Walks the full reachable subgraph from the branch HEAD. Optionally
 * streams progress via ``onProgress({ phase, done, total })`` as the
 * Python side walks, packs, and finalizes the archive.
 *
 * @param {string} branch
 * @param {(p: { phase: string, done: number, total: number }) => void} [onProgress]
 * @returns {Promise<{ bytes: Uint8Array, manifest: object }>}
 */
export async function exportBundle(branch, onProgress) {
    const code = `
import json as _json, base64 as _b64
import bundle as _bundle
_state = _agent.state("default")
_v = _state.versioned
_branch = ${JSON.stringify(branch)}
_name = _state.peek("__session_name__", branch=_branch) or ""
_desc = _state.peek("__session_description__", branch=_branch) or ""
_title = _state.peek("__session_title__", branch=_branch) or ""
_display = _name or _title

def _progress(phase, done, total):
    _post_token(_run_id, {"phase": phase, "done": done, "total": total})

_data = _bundle.export_bundle(_v, _branch, name=_display, description=_desc, progress=_progress)
_manifest = _bundle.inspect_bundle(_data)
_json.dumps({"b64": _b64.b64encode(_data).decode(), "manifest": _manifest})
    `;
    const json = await runPythonStreaming(code, (token) => {
        if (onProgress && token && typeof token.phase === "string") {
            onProgress(token);
        }
    });
    const obj = JSON.parse(json);
    const bin = atob(obj.b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, manifest: obj.manifest };
}

/**
 * Import a bundle (ZIP bytes) as a new session. Creates a fresh branch;
 * the underlying commits/nodes/blobs are content-addressed, so repeated
 * imports are idempotent at the store layer.
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<{ branch: string, manifest: object }>}
 */
export async function importBundle(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const b64 = btoa(bin);
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
    localStorage.setItem(CURRENT_BRANCH_KEY, result.branch);
    await refreshSessionList(result.branch);
    return result;
}

/**
 * Inspect a bundle's manifest without importing it. Useful for preview
 * UI before the user commits to adding the session.
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<object>}
 */
export async function inspectBundle(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const b64 = btoa(bin);
    const json = await runPython(`
import json as _json, base64 as _b64
import bundle as _bundle
_data = _b64.b64decode(${JSON.stringify(b64)})
_json.dumps(_bundle.inspect_bundle(_data))
    `);
    return JSON.parse(json);
}

// ---------------------------------------------------------------------------
// Drive picks — previously tracked references to live-mount Drive files.
// The /drive/ live mount has been replaced by on-demand imports into the
// real VFS at /downloads/, so there's no picks state to persist anymore.
// Functions removed; any legacy kvgit `__drive_picks__` entries are
// harmless dead data.
// ---------------------------------------------------------------------------

/** Update session title and timestamp after a turn. Call with the last action title. */
export async function persistSessionMeta(title) {
    const escaped = (title || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    await runPython(`
from datetime import datetime as _dt, timezone as _tz

_state = _agent.state("default")
_title = "${escaped}"
if _title:
    _state["__session_title__"] = _title
_state["__session_updated__"] = _dt.now(_tz.utc).isoformat()
_state.commit()
    `);

    await refreshSessionList(state.currentBranch);
}

/**
 * Set the user-curated name + description for a session branch.
 * Both fields are optional and independent of the agent-generated
 * __session_title__ (which continues to track the last action title).
 * Display logic prefers `name` over `title` when set.
 *
 * @param {string} branch - branch name (session id)
 * @param {string} name
 * @param {string} description
 */
export async function setSessionMeta(branch, name, description) {
    await runPython(`
from datetime import datetime as _dt, timezone as _tz

_state = _agent.state("default")
_branch = ${JSON.stringify(branch)}
_name = ${JSON.stringify(name || "")}
_desc = ${JSON.stringify(description || "")}

# Edits target the specified branch — temporarily switch if it's not current
_cur = _state.current_branch
_switched = False
if _branch != _cur:
    _state.switch_branch(_branch)
    _switched = True

try:
    _state["__session_name__"] = _name
    _state["__session_description__"] = _desc
    _state["__session_updated__"] = _dt.now(_tz.utc).isoformat()
    _state.commit()
finally:
    if _switched:
        _state.switch_branch(_cur)
    `);

    await refreshSessionList(state.currentBranch);
}

/**
 * Get debug info for a session branch: commit count, keyset size, HEAD hash.
 * @param {string} branch - branch name to inspect
 * @returns {Promise<{ branch: string, commit: string, commits: number, keys_total: number, keys: string[] }>}
 */
export async function getSessionDebugInfo(branch) {
    const escaped = branch.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const json = await runPython(`
import json as _json

_state = _agent.state("default")
_v = _state.versioned

# Temporarily switch to the target branch to read its state
_prev = _v.current_branch
_v.switch_branch("${escaped}")

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
    "branch": "${escaped}",
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
}
