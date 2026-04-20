/**
 * Session management — branch-based chat sessions via agex versioned state.
 *
 * Each session maps to a kvgit branch. Session metadata (title, updated
 * timestamp) is stored as special keys in the branch's state.
 */

import { runPython } from "./pyodide.js";

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
    })
if _current not in [s["branch"] for s in _sessions]:
    _sessions.append({
        "branch": _current,
        "title": "New Chat",
        "name": "",
        "description": "",
        "updated": _state.peek("__session_updated__", branch=_current) or "",
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

/** Delete a session. Switches to another if deleting current. */
export async function deleteSession(branch) {
    const escaped = branch.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const json = await runPython(`
import json as _json
import uuid as _uuid
from datetime import datetime as _dt, timezone as _tz

_state = _agent.state("default")

# Find another branch to switch to before deleting
_branches = [b for b in _state.list_branches() if b.startswith("chat-") and b != "${escaped}"]
if _branches:
    _branches.sort(
        key=lambda b: _state.peek("__session_updated__", branch=b) or "",
        reverse=True,
    )
    _current = _branches[0]
    _state.switch_branch(_current)
else:
    _current = f"chat-{_uuid.uuid4().hex[:8]}"
    _state.create_branch(_current, at=_state.versioned.initial_commit)
    _state.switch_branch(_current)
    _state["__session_updated__"] = _dt.now(_tz.utc).isoformat()
    _state.commit()
_state.delete_branch("${escaped}")
_json.dumps(_current)
    `);

    const newCurrent = JSON.parse(json);
    localStorage.setItem(CURRENT_BRANCH_KEY, newCurrent);
    await refreshSessionList(newCurrent);
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
        _report_text = getattr(_evt, "report", "") or ""
        _current_events.append({
            "type": "action",
            "title": _evt.title or "",
            "thinking": _evt.thinking or "",
            "report": _report_text,
            "code": _evt.code,
            "terminal": _evt.terminal,
            "file_actions": _serialize_file_actions(_evt.file_actions),
            "input_tokens": _evt.input_tokens,
            "output_tokens": _evt.output_tokens,
        })
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

    // Group into "units": a user message + its following agent response
    const units = [];
    let current = null;
    for (const msg of all) {
        if (msg.role === 'user') {
            if (current) units.push(current);
            current = [msg];
        } else {
            if (current) {
                current.push(msg);
                units.push(current);
                current = null;
            } else {
                units.push([msg]);
            }
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

_state = _agent.state("default")
_cur = _state.current_branch
_old_title = _state.peek("__session_title__", branch=_cur) or "New Chat"
_new = f"chat-{_uuid.uuid4().hex[:8]}"
_state.create_branch(_new)
_state.switch_branch(_new)

_state["__session_title__"] = _old_title + " (fork)"
_state["__session_updated__"] = _dt.now(_tz.utc).isoformat()
_state.commit()
_json.dumps(_new)
    `);

    const branch = JSON.parse(json);
    localStorage.setItem(CURRENT_BRANCH_KEY, branch);
    await refreshSessionList(branch);
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
