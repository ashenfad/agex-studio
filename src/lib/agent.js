/**
 * Agent bridge — sets up and calls an agex agent via the Pyodide worker.
 */

import { runPython, runPythonStreaming, setQueryHandler, setLiveIframe } from "./pyodide.js";

/**
 * Initialize the agent with the given settings.
 * Must be called before sendMessage. Safe to call again to reconfigure.
 *
 * @param {{ apiKey: string, model: string }} settings
 */
export async function initAgent(settings) {
    const userTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    await runPython(`
from dataclasses import dataclass
import pandas as pd
import plotly.graph_objects as go
from agex import Agent, connect_llm, connect_state, connect_fs, clear_agent_registry
from agex.helpers import register_pandas, register_numpy, register_plotly, register_stdlib

clear_agent_registry()

@dataclass
class Response:
    """Multi-part response container.
    Parts can be: str (markdown), pd.DataFrame (table), go.Figure (chart).
    Example: Response(parts=["## Summary", df, fig])
    """
    parts: list

    def normalize(self):
        import json
        result = []
        for p in self.parts:
            if isinstance(p, str):
                result.append({"type": "text", "content": p})
            elif isinstance(p, pd.DataFrame):
                import numpy as np
                _df = p.reset_index() if not isinstance(p.index, pd.RangeIndex) else p
                # Smart rounding: per-column precision based on value magnitude
                for _col in _df.select_dtypes(include=["float"]).columns:
                    _vals = _df[_col].dropna()
                    if len(_vals) == 0:
                        continue
                    _mag = np.log10(np.maximum(np.abs(_vals), 1e-15)).median()
                    # 4 significant figures, capped at 6 decimal places
                    _decimals = max(0, min(6, int(4 - np.floor(_mag))))
                    _df[_col] = _df[_col].round(_decimals)
                _split = json.loads(_df.to_json(orient="split"))
                result.append({
                    "type": "dataframe",
                    "columns": _split["columns"],
                    "rows": _split["data"],
                })
            elif isinstance(p, go.Figure):
                result.append({
                    "type": "plotly",
                    "figure": json.loads(p.to_json()),
                })
            else:
                result.append({"type": "text", "content": str(p)})
        return result

_llm = connect_llm(
    provider="pyfetch_openai",
    model="${settings.model}",
    api_key="${settings.apiKey}",
)

_agent = Agent(
    name="chat",
    primer="You are a helpful assistant.",
    llm=_llm,
    state=connect_state(type="versioned", storage="indexeddb"),
    fs=connect_fs(type="virtual"),
    chaptering_trigger=${settings.chapteringTrigger},
)

_agent.cls(Response)
register_stdlib(_agent)
register_pandas(_agent)
register_numpy(_agent)
register_plotly(_agent)

import pypdf as _pypdf
_agent.module(_pypdf, visibility="low", recursive=True)

import openpyxl as _openpyxl
_agent.module(_openpyxl, visibility="low", recursive=True)

import scipy as _scipy
_agent.module(_scipy, visibility="low", recursive=True)

import sklearn as _sklearn
_agent.module(_sklearn, visibility="low", recursive=True)

# -- Register calgebra with network access for Google Calendar API --
import calgebra as _calgebra
_agent.module(_calgebra, visibility="low", recursive=True, network_access=True)

import asyncio as _asyncio
_agent.module(_asyncio, include=["gather", "sleep", "wait", "as_completed"])

# -- Register skills from installed packages --
try:
    import pathlib as _pathlib
    _calgebra_pkg = _pathlib.Path(__import__("calgebra").__file__).parent
    _agent.skill(_calgebra_pkg / "skills" / "calgebra" / "SKILL.md")
    _agent.skill(_calgebra_pkg / "skills" / "gcal" / "SKILL.md")
    del _calgebra_pkg, _pathlib
except Exception as _e:
    print(f"[skills] failed to register: {_e}")

# -- Register skills from static files --
from pyodide.http import open_url as _open_url

_app_skill_text = _open_url("/skills/interactive-app.md").read()
_agent.skill(_app_skill_text.encode("utf-8"))
del _app_skill_text

# -- Gmail module (loaded from static file, injected into sys.modules) --
import types as _types
import sys as _sys
_gmail_src = _open_url("/gmail.py").read()
_gmail_mod = _types.ModuleType("gmail")
_gmail_mod.__file__ = "/gmail.py"
exec(_gmail_src, _gmail_mod.__dict__)
_sys.modules["gmail"] = _gmail_mod
_agent.module(_gmail_mod, visibility="low", network_access=True)
del _gmail_src, _gmail_mod, _types, _sys

_gmail_skill_text = _open_url("/skills/gmail.md").read()
_agent.skill(_gmail_skill_text.encode("utf-8"))
del _gmail_skill_text

del _open_url

_OR_API_KEY = "${settings.apiKey}"

# Google access token — set/refreshed by the main thread via worker message.
try:
    _google_access_token
except NameError:
    _google_access_token = None

def google_token() -> str | None:
    """Returns the current Google OAuth access token, or None if not connected.
    Use with calgebra.gcal: Calendar(access_token=google_token())
    """
    return _google_access_token

_agent.fn(google_token, visibility="low")

def local_timezone() -> str:
    """Returns the user's local IANA timezone (e.g. 'America/Los_Angeles').
    Use with calgebra: at = at_tz(local_timezone())
    """
    return "${userTz}"

_agent.fn(local_timezone, visibility="high")

async def search(query: str, deep: bool = False) -> str:
    """Search the web and return a summary with sources.

    Args:
        query: The search query or question.
        deep: If True, use multi-step agentic search for complex research.

    Returns:
        A text summary with cited sources.

    For parallel searches, use asyncio.gather:
        results = await asyncio.gather(
            search("topic A"),
            search("topic B"),
            search("topic C"),
        )
    """
    import json as _json
    from pyodide.http import pyfetch as _pyfetch

    _model = "perplexity/sonar-pro-search" if deep else "perplexity/sonar"
    _body = _json.dumps({
        "model": _model,
        "messages": [
            {"role": "system", "content": "Answer the user's question using web search. Be thorough and include source URLs."},
            {"role": "user", "content": query},
        ],
    })
    _resp = await _pyfetch(
        "https://openrouter.ai/api/v1/chat/completions",
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {_OR_API_KEY}",
        },
        body=_body,
    )
    if _resp.status >= 400:
        try:
            _err = await _resp.json()
            _msg = _err.get("error", {}).get("message", str(_err))
        except Exception:
            _msg = f"HTTP {_resp.status}"
        raise RuntimeError(f"Search failed: {_msg}")
    _data = await _resp.json()
    return _data["choices"][0]["message"]["content"]

_agent.fn(search, visibility="high")

def _display_app_results(_results, _label):
    """Auto-display app test/interaction results."""
    for _r in _results:
        if _r.get("type") == "log":
            print(f"[{_r.get('level', 'log')}] {_r.get('message', '')}")
        elif _r.get("type") == "read":
            _val = _r.get("value")
            if _val is None:
                print(f"[read {_r.get('selector', '')}] (not found)")
            else:
                print(f"[read {_r.get('selector', '')}] {_val}")
        elif _r.get("type") == "eval":
            if "error" in _r:
                print(f"[eval error] {_r['error']}")
            else:
                print(f"[eval] {_r.get('value', '')}")
    if not _results:
        print(f"[{_label}] clean")

async def test_app(actions: list[dict] | None = None) -> list[dict]:
    """Test the current app by loading it in a hidden browser iframe.
    Reads files from app/, renders the HTML, waits for initialization
    (including any query() calls), and returns console messages.

    Results are auto-displayed — just await and call task_continue()
    to see the output. You can also capture the return value if you
    need to branch on the results.

    Args:
        actions: Optional list of UI interactions to perform after the
            app loads. Each action is a dict with one of:
            - {"click": "#selector"}        — click an element
            - {"type": "#selector", "value": "text"} — type into an input
            - {"select": "#selector", "value": "opt"} — select an option
            - {"wait": 500}                 — wait N milliseconds
            - {"read": "#selector"}         — read element text content
            - {"read": "#selector", "prop": "value"} — read a property
            - {"eval": "js expression"}     — evaluate JS, capture result
            The app is given time to settle (query() calls, re-renders)
            after each action before proceeding to the next.

    Returns:
        List of result dicts (also auto-displayed via print).
    """
    import json as _json
    _fs = _agent.fs()
    _app_files = {}
    try:
        _all = _fs.list("app/", recursive=True)
        for _p in _all:
            _full = "app/" + _p
            if _fs.isfile(_full):
                _app_files[_full] = _fs.read(_full).decode("utf-8", errors="replace")
    except Exception:
        pass
    if not _app_files:
        _r = [{"type": "log", "level": "error", "message": "No app files found in app/ directory"}]
        _display_app_results(_r, "test_app")
        return _r
    _actions_json = _json.dumps(actions) if actions else None
    _results_json = await _js_test_app(_json.dumps(_app_files), _actions_json)
    _results = _json.loads(_results_json)
    _display_app_results(_results, "test_app")
    return _results

_agent.fn(test_app, visibility="low")

async def live_app(actions: list[dict] | None = None) -> list[dict]:
    """Interact with the live app preview that the user sees.

    Use this to read what the user has selected/entered in the app,
    inspect DOM state, or programmatically interact with the live UI.

    Results are auto-displayed — just await and call task_continue()
    to see the output. You can also capture the return value if you
    need to branch on the results.

    IMPORTANT: The live preview shows the LAST COMMITTED app files —
    any file changes you make during this turn won't appear until after
    task_success(). Use test_app() to test uncommitted changes.

    Args:
        actions: List of interactions/queries. Each action is a dict:
            - {"click": "#selector"}        — click an element
            - {"type": "#selector", "value": "text"} — type into an input
            - {"select": "#selector", "value": "opt"} — select an option
            - {"wait": 500}                 — wait N milliseconds
            - {"read": "#selector"}         — read element text content
            - {"read": "#selector", "prop": "value"} — read a property
            - {"eval": "js expression"}     — evaluate JS, capture result

    Returns:
        List of result dicts (also auto-displayed via print).
    """
    import json as _json
    _actions_json = _json.dumps(actions) if actions else None
    _results_json = await _js_live_app(_actions_json)
    _results = _json.loads(_results_json)
    _display_app_results(_results, "live_app")
    return _results

_agent.fn(live_app, visibility="low")

_TASK_PRIMER = """Answer the user's message.

You can respond with a simple string or a rich Response with multiple parts:
- str: markdown text (supports mermaid diagrams via \`\`\`mermaid code blocks)
- pd.DataFrame: rendered as an interactive table
- go.Figure: rendered as a Plotly chart

Note: .show() and display() do not render anything for the user.
Only items included in a Response are displayed. Use task_success() with
a Response to show figures, tables, and text to the user.

To inspect an image yourself (e.g. a PIL Image, matplotlib Figure, or Plotly
Figure), call await view_image(img). This sends the image to your own vision —
it does NOT display it to the user.

pypdf is available for reading PDF files (e.g. extracting text, metadata, page count).
openpyxl is available — use pd.read_excel() to read .xlsx files.
scipy and scikit-learn are available for statistics, optimization, and machine learning.

Calendars: whenever the user asks about calendars, scheduling, events,
or .ics files, read the calgebra skill first (if you haven't already) —
its API has non-obvious signatures you must not guess at:
  cat /skills/calgebra/SKILL.md
calgebra handles both .ics files (file_to_timeline) and Google Calendar
(via the gcal module). For Google Calendar work, also read:
  cat /skills/gcal/SKILL.md
Then call google_token() to get the current OAuth token.
If it returns None, tell the user to connect Google in Settings.
local_timezone() and google_token() are registered globals — call them directly,
do not import them from any module. Use local_timezone() to get the user's
IANA timezone (e.g. "America/Los_Angeles") as the tz parameter for calgebra.

Gmail: whenever the user asks about email, inbox, messages, or needs to
send email, read the gmail skill first (if you haven't already):
  cat /skills/gmail/SKILL.md
Then call google_token() to get the current OAuth token.
If it returns None, tell the user to connect Google in Settings.

You are already in an async context — use await directly on async functions.
Do not use asyncio.run() — it will fail (you are already in an event loop).
Use asyncio.gather() to run multiple async calls in parallel:
  results = await asyncio.gather(search("topic A"), search("topic B"))
  task_continue(str(results))
Single search:
  results = await search("your query")
  task_continue(results)
Always call task_continue() after search() so you can read the results
before deciding your next step.

Interactive Apps: when the user wants dashboards, data explorers, filter
widgets, or any interactive UI, read the interactive-app skill first:
  cat /skills/interactive-app/SKILL.md
It covers Preact+HTM, Plotly, the query() bridge for calling Python from
the app, and common patterns. Write app/index.html and the preview panel
appears automatically. After writing or editing app files, call
await test_app() to verify — results are auto-displayed (errors, logs,
read values). Just call task_continue() after to see the output.
query() calls in the app work during testing.
Pass actions=[{"click": "#btn"}, {"read": "#output"}, ...] to simulate
user interactions and inspect DOM state. Capture the return value if you
need to branch on results: results = await test_app(actions=[...])
Use await live_app(actions=[...]) to interact with or read from the live
preview the user sees. Note: the live preview only reflects committed
files — changes you make during this turn won't appear until task_success().

Examples:
  task_success("Here is your answer.")
  task_success(Response(parts=["## Results", summary_df, chart_fig]))
"""

@_agent.task(primer=_TASK_PRIMER)
async def chat(message: str) -> str | Response:
    ...

# -- Shared helpers for event processing (used by sendMessage and loadHistory) --
from agex.agent.events import ActionEvent as _ActionEvent, OutputEvent as _OutputEvent, ChapterEvent as _ChapterEvent
from agex.agent.events import TaskStartEvent as _TaskStart, SuccessEvent as _SuccessEvent
from agex.agent.datatypes import FileAction as _FileAction, EditAction as _EditAction
from agex.eval.objects import PrintAction as _PrintAction, ImageAction as _ImageAction

_ERROR_KEYWORDS = ("💥",)

def _is_error_output(event):
    for part in event.parts:
        if isinstance(part, _PrintAction):
            content = " ".join(str(item) for item in part)
            if any(kw in content for kw in _ERROR_KEYWORDS):
                return True
    return False

def _serialize_output_parts(event):
    import base64 as _b64
    import io as _io
    parts = []
    for part in event.parts:
        if isinstance(part, _PrintAction):
            parts.append({"type": "text", "content": " ".join(str(item) for item in part)})
        elif isinstance(part, _ImageAction):
            img = part.image
            # Convert to base64 PNG if it's a PIL Image
            if hasattr(img, 'save'):
                buf = _io.BytesIO()
                img.save(buf, format='PNG')
                parts.append({"type": "image", "data": _b64.b64encode(buf.getvalue()).decode("ascii")})
            elif isinstance(img, str):
                # Already base64 or data URL
                parts.append({"type": "image", "data": img})
            else:
                parts.append({"type": "text", "content": str(img)})
        else:
            parts.append({"type": "text", "content": str(part)})
    return parts

def _output_text(event):
    lines = []
    for part in event.parts:
        if isinstance(part, _PrintAction):
            lines.append(" ".join(str(item) for item in part))
        else:
            lines.append(str(part))
    return "\\n".join(lines)

def _serialize_file_actions(actions):
    result = []
    for a in actions:
        if isinstance(a, _FileAction):
            result.append({"kind": "file", "path": a.path, "content": a.content, "mode": a.mode})
        elif isinstance(a, _EditAction):
            result.append({"kind": "edit", "path": a.path, "search": a.search, "content": a.content, "operation": a.operation})
    return result

def _serialize_chapter_events(events_list, state=None):
    """Recursively serialize events nested inside a ChapterEvent."""
    result = []
    _cur_task = None
    _unassigned = []
    for evt in events_list:
        if isinstance(evt, _ActionEvent):
            result.append({
                "type": "action",
                "title": evt.title or "",
                "thinking": evt.thinking or "",
                "code": evt.code,
                "terminal": evt.terminal,
                "file_actions": _serialize_file_actions(evt.file_actions),
                "input_tokens": evt.input_tokens,
                "output_tokens": evt.output_tokens,
            })
        elif isinstance(evt, _OutputEvent):
            _is_err = _is_error_output(evt)
            result.append({
                "type": "error" if _is_err else "output",
                "message": _output_text(evt),
                "parts": _serialize_output_parts(evt),
            })
        elif isinstance(evt, _ChapterEvent):
            _ch_item = {
                "type": "chapter",
                "name": evt.name,
                "message": evt.message,
                "events": _serialize_chapter_events(evt.resolve_events(state) if state else [], state),
            }
            result.append(_ch_item)
            _unassigned.append(_ch_item)
        elif isinstance(evt, _TaskStart):
            _cur_task = evt.task_name
            if evt.task_name == "__chapter__":
                result.append({"type": "chaptering", "chapters": []})
            else:
                result.append({
                    "type": "task_start",
                    "message": evt.inputs.get("message", str(evt.inputs)),
                })
        elif isinstance(evt, _SuccessEvent):
            if _cur_task == "__chapter__":
                _n = 0
                if isinstance(evt.result, list):
                    _n = sum(1 for _ch in evt.result if hasattr(_ch, 'name'))
                _take = min(_n, len(_unassigned))
                if _take > 0:
                    for _bm in reversed(result):
                        if _bm.get("type") == "chaptering":
                            _bm["chapters"] = [
                                {"name": _uc["name"], "message": _uc["message"], "events": _uc.get("events", [])}
                                for _uc in _unassigned[:_take]
                            ]
                            break
                    _unassigned = _unassigned[_take:]
                _cur_task = None
            else:
                r = evt.result
                if hasattr(r, "normalize") and hasattr(r, "parts"):
                    _rd = {"type": "response", "parts": r.normalize()}
                else:
                    _rd = {"type": "text", "content": str(r) if r is not None else ""}
                result.append({"type": "success", "result": _rd})
    return result
    `);

    // Wire up query handler for headless app testing
    setQueryHandler(runQuery);
}

/**
 * List files in the agent's virtual filesystem.
 * @returns {Promise<string[]>}
 */
export async function listFiles() {
    const json = await runPython(`
import json as _json
_list_result = "[]"
try:
    _fs = _agent.fs()
    _all = _fs.list(recursive=True)
    _files = [e for e in _all if _fs.isfile(e)]
    _files.sort()
    _list_result = _json.dumps(_files)
except Exception as _e:
    _list_result = _json.dumps([])
_list_result
    `);
    return JSON.parse(json);
}

/**
 * Read a file's content from the agent's virtual filesystem.
 * @param {string} path
 * @returns {Promise<string>}
 */
export async function readFile(path) {
    const escaped = path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const json = await runPython(`
import json as _json
_fs = _agent.fs()
_content = _fs.read("${escaped}")
_json.dumps(_content.decode("utf-8", errors="replace"))
    `);
    return JSON.parse(json);
}

/**
 * Get file size in bytes from the agent's virtual filesystem.
 * @param {string} path
 * @returns {Promise<number>}
 */
export async function fileSize(path) {
    const escaped = path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const result = await runPython(`
_fs = _agent.fs()
len(_fs.read("${escaped}"))
    `);
    return parseInt(result, 10);
}

/**
 * Upload files to the agent's virtual filesystem.
 * @param {Array<{name: string, data: string}>} files - name and base64-encoded content
 * @returns {Promise<void>}
 */
export async function uploadFiles(files) {
    const filesJson = JSON.stringify(files);
    await runPython(`
import json as _json, base64 as _b64
_fs = _agent.fs()
_uploads = _json.loads('''${filesJson.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}''')
_files_dict = {}
for _f in _uploads:
    _files_dict[_f["name"]] = _b64.b64decode(_f["data"])
_fs.write_many(_files_dict)
_state = _agent.state("default")
_state.commit()
    `);
}

/**
 * Delete files from the agent's virtual filesystem.
 * @param {string[]} paths
 * @returns {Promise<void>}
 */
export async function deleteFiles(paths) {
    const pathsJson = JSON.stringify(paths);
    await runPython(`
import json as _json
_fs = _agent.fs()
_paths = _json.loads('${pathsJson.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}')
_fs.remove_many(_paths)
_state = _agent.state("default")
_state.commit()
    `);
}

/**
 * Download a file from the agent's virtual filesystem as base64.
 * @param {string} path
 * @returns {Promise<string>} base64-encoded content
 */
export async function downloadFile(path) {
    const escaped = path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const json = await runPython(`
import json as _json, base64 as _b64
_fs = _agent.fs()
_content = _fs.read("${escaped}")
_json.dumps(_b64.b64encode(_content).decode("ascii"))
    `);
    return JSON.parse(json);
}

/**
 * Read all files under app/ from the agent's virtual filesystem.
 * @returns {Promise<Record<string, string>>} Map of path -> content
 */
export async function readAppFiles() {
    const json = await runPython(`
import json as _json
_fs = _agent.fs()
_app_files = {}
try:
    _all = _fs.list("app/", recursive=True)
    for _p in _all:
        _full = "app/" + _p
        if _fs.isfile(_full):
            _app_files[_full] = _fs.read(_full).decode("utf-8", errors="replace")
except Exception:
    pass
_json.dumps(_app_files)
    `);
    return JSON.parse(json);
}

/**
 * Run Python code in the agent's sandbox and return requested variables.
 * If resultVars is null, returns all serializable namespace variables.
 *
 * @param {string} code - Python code to execute
 * @param {string[] | null} resultVars - Variable names to return, or null for all
 * @returns {Promise<Record<string, any>>}
 */
export async function runQuery(code, resultVars) {
    const escapedCode = code
        .replace(/\\/g, "\\\\")
        .replace(/'/g, "\\'")
        .replace(/\n/g, "\\n");
    const resultArg = resultVars ? JSON.stringify(resultVars) : "None";

    const json = await runPython(`
import json as _json
from agex.eval.bridge import aexecute_sandboxed as _aexecute_sandboxed

_query_code = '${escapedCode}'
_query_result_vars = ${resultArg}

_query_state = _agent.state("default")
_query_error = None

try:
    await _aexecute_sandboxed(
        _query_code,
        _agent,
        _query_state,
        fs=_agent.fs(),
    )
except BaseException as _e:
    if isinstance(_e, (SystemExit, KeyboardInterrupt)):
        pass
    else:
        _query_error = str(_e)

if _query_error:
    raise RuntimeError(_query_error)

# Collect result variables from state
def _serialize(val):
    if isinstance(val, pd.DataFrame):
        import numpy as _np
        _df = val.reset_index() if not isinstance(val.index, pd.RangeIndex) else val
        for _col in _df.select_dtypes(include=["float"]).columns:
            _vals = _df[_col].dropna()
            if len(_vals) == 0:
                continue
            _mag = _np.log10(_np.maximum(_np.abs(_vals), 1e-15)).median()
            _decimals = max(0, min(6, int(4 - _np.floor(_mag))))
            _df[_col] = _df[_col].round(_decimals)
        _split = _json.loads(_df.to_json(orient="split"))
        return {"__type__": "dataframe", "columns": _split["columns"], "rows": _split["data"]}
    elif isinstance(val, go.Figure):
        return {"__type__": "plotly", "figure": _json.loads(val.to_json())}
    elif isinstance(val, dict):
        return {k: _serialize(v) for k, v in val.items()}
    elif isinstance(val, (list, tuple)):
        return [_serialize(v) for v in val]
    else:
        try:
            _json.dumps(val)
            return val
        except (TypeError, ValueError):
            return str(val)

_query_result = {}
if _query_result_vars is not None:
    for _name in _query_result_vars:
        if _name in _query_state:
            _query_result[_name] = _serialize(_query_state[_name])
else:
    for _name in _query_state.keys():
        if _name.startswith("_") or _name.startswith("__"):
            continue
        try:
            _query_result[_name] = _serialize(_query_state[_name])
        except Exception:
            pass

_json.dumps(_query_result)
    `);
    return JSON.parse(json);
}

/**
 * Send a message to the agent and return a structured response.
 * Streams tokens to onToken callback for live UI updates.
 *
 * @param {string} message
 * @param {(token: {type: string, content: string, start: boolean, done: boolean}) => void} [onToken]
 * @returns {Promise<{ result: string, events: Array }>}
 */
export async function sendMessage(message, onToken) {
    const escaped = message
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n");

    const json = await runPythonStreaming(`
import json as _json

_events_log = []

def _on_event(event):
    if isinstance(event, _ActionEvent):
        _events_log.append({
            "type": "action",
            "title": event.title or "",
            "thinking": event.thinking or "",
            "code": event.code,
            "terminal": event.terminal,
            "file_actions": _serialize_file_actions(event.file_actions),
            "input_tokens": event.input_tokens,
            "output_tokens": event.output_tokens,
        })
    elif isinstance(event, _OutputEvent):
        _is_err = _is_error_output(event)
        _events_log.append({
            "type": "error" if _is_err else "output",
            "message": _output_text(event),
            "parts": _serialize_output_parts(event),
        })
    elif isinstance(event, _ChapterEvent):
        _state = _agent.state("default")
        _events_log.append({
            "type": "chapter",
            "name": event.name,
            "message": event.message,
            "events": _serialize_chapter_events(event.resolve_events(_state), _state),
        })

def _on_token(token):
    _post_token(_run_id, {
        "type": token.type,
        "content": token.content,
        "start": getattr(token, "start", False),
        "done": token.done,
    })

from agex import TaskFail, TaskClarify, TaskCancelled
import asyncio as _asyncio

# Store the running task so the cancel handler can interrupt it
_agex_running_task = _asyncio.current_task()

try:
    _result = await chat("${escaped}", on_event=_on_event, on_token=_on_token)
except TaskCancelled:
    _result = None
    _events_log.append({"type": "cancelled"})
except _asyncio.CancelledError:
    _result = None
    _events_log.append({"type": "cancelled"})
    # asyncio cancel bypasses agex's loop — record CancelledEvent and commit manually
    try:
        _state = _agent.state("default")
        from agex.agent.events import CancelledEvent as _CE
        from agex.state.log import add_event_to_log as _add_log
        _add_log(_state, _CE(agent_name=_agent.name, task_name="chat", iterations_completed=0))
        _state.commit()
    except Exception:
        pass
except TaskFail as _tf:
    _result = _tf.message
except TaskClarify as _tc:
    _result = _tc.message
finally:
    _agex_running_task = None

def _serialize_result(r):
    if isinstance(r, Response):
        return {"type": "response", "parts": r.normalize()}
    else:
        return {"type": "text", "content": str(r) if r is not None else ""}

_json.dumps({"result": _serialize_result(_result), "events": _events_log})
    `, onToken);

    return JSON.parse(json);
}

/**
 * Manually trigger chaptering to compress conversation context.
 * @returns {Promise<{ result: string }>}
 */
export async function runChaptering() {
    const json = await runPython(`
import json as _json
from agex.state.log import get_events_from_log as _get_log_events, replace_events_with_chapters as _replace_chapters
from agex.agent.events import ErrorEvent as _ErrorEvent, ChapterEvent as _ChapterEvt
from agex.agent.chapter import (
    Chapter as _Chapter,
    build_numbered_task_index as _build_index,
    prepare_tasks_for_chaptering as _prepare_tasks,
)

_state = _agent.state("default")
_ch_result = "no_chapters"

# Temporarily force threshold to 0 so chaptering always triggers
_orig_trigger = _agent.chaptering_trigger
_agent.chaptering_trigger = 0

try:
    _all_events = _get_log_events(_state)
    _tasks, _task_ranges = _prepare_tasks(_all_events)
    _index_text = _build_index(_tasks)

    _chapters = await _agent._chapter_task(event_index=_index_text)

    if _chapters:
        _ch_ranges = []
        for _ch in _chapters:
            if not isinstance(_ch, _Chapter):
                continue
            if _ch.start < 1 or _ch.end < _ch.start:
                continue
            if _ch.start > len(_task_ranges) or _ch.end > len(_task_ranges):
                continue
            _ls = _task_ranges[_ch.start - 1][0]
            _le = _task_ranges[_ch.end - 1][1]
            _ce = _ChapterEvt(
                agent_name=_agent.name,
                name=_ch.name,
                message=_ch.message,
            )
            _ch_ranges.append((_ls, _le, _ce))

        if _ch_ranges:
            _replace_chapters(_state, _ch_ranges)
            _state.commit()
            _ch_result = "ok"
finally:
    _agent.chaptering_trigger = _orig_trigger

_json.dumps({"result": _ch_result})
    `);
    return JSON.parse(json);
}

/**
 * Estimate current context token usage (system prompt + event log).
 * @returns {Promise<number>} Estimated total tokens
 */
export async function estimateLogTokens() {
    const json = await runPython(`
import json as _json
from agex.render.token_count import estimate_log_tokens as _estimate

_state = _agent.state("default")
_result = _estimate(_agent, _state)
_json.dumps(_result["total"])
    `);
    return JSON.parse(json);
}

/**
 * Get input token counts from each ActionEvent for charting context growth.
 * @returns {Promise<number[]>} Array of input_tokens values in chronological order
 */
export async function getTokenHistory() {
    const json = await runPython(`
import json as _json
from agex import events as _get_events
from agex.agent.events import ActionEvent as _AE, ChapterEvent as _CE, TaskStartEvent as _TaskStart
from agex.agent.chapter import CHAPTER_TASK as _CHAPTER_TASK
from agex.render.token_count import estimate_log_tokens as _estimate

_state = _agent.state("default")
_all = _get_events(_state)

def _flatten(events):
    for e in events:
        if isinstance(e, _CE):
            yield from _flatten(e.resolve_events(_state))
        else:
            yield e

_tokens = [e.input_tokens for e in _flatten(_all) if isinstance(e, _AE) and e.input_tokens is not None and e.source != "setup"]

_last_task = None
for _e in _all:
    if isinstance(_e, _TaskStart):
        _last_task = _e.task_name

if _last_task == _CHAPTER_TASK:
    _tokens.append(_estimate(_agent, _state)["total"])

_json.dumps(_tokens)
    `);
    return JSON.parse(json);
}
