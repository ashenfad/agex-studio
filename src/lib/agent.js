/**
 * Agent bridge — sets up and calls an agex agent via the Pyodide worker.
 */

import {
  runPython,
  runPythonStreaming,
  setQueryHandler,
  setLiveIframe,
} from "./pyodide.js";

/**
 * Derive the settings-related Python literals once so basics + rich can
 * share them. Returns the pieces that get interpolated into the Python
 * template strings below.
 *
 * @param {{ apiKey: string, model: string, provider?: string, baseUrl?: string, chapteringTrigger?: number, toolUseWireFormat?: boolean }} settings
 */
function _settingsConstants(settings) {
  const userTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const providerName =
    settings.provider === "anthropic" ? "pyfetch_anthropic" : "pyfetch_openai";
  const baseUrlLine = settings.baseUrl
    ? `    base_url="${settings.baseUrl}",\n`
    : "";
  // OpenRouter-specific headers — only meaningful for pyfetch_openai.
  const openrouterLines =
    settings.provider === "anthropic"
      ? ""
      : `    app_url="https://agex.studio",\n    app_title="Agex Studio",\n`;
  // Optional: print raw SSE text deltas to the browser console.
  // Enable with: localStorage.setItem("agex-debug-raw-stream", "1")
  const debugRawLines =
    localStorage.getItem("agex-debug-raw-stream") === "1"
      ? `import agex.llm.${providerName} as _pfmod\n_pfmod.DEBUG_RAW_STREAM = True\n`
      : "";
  // LLM client class — instantiated directly so we can pass fetch_adapter
  // without going through connect_llm's config-resolution machinery, and
  // the JS bridge can inject auth on the main thread.
  const llmClass =
    settings.provider === "anthropic" ? "PyfetchAnthropic" : "PyfetchOpenAI";
  // Wire-format selection.  The retool shipped with ``native_thinking=True``
  // as the client default, so the "on" branch (recommended, reasoning
  // models) just lets the client default apply — no kwarg needed.  The
  // "off" branch is an explicit opt-out for users on non-reasoning
  // models (old Claude, non-GPT-5 OpenAI, OpenRouter routes without
  // reasoning support) — pass ``ToolUseWireFormat(native_thinking=False)``
  // so the primer + schema include the narration-in-schema path.
  const wireFormatImport = settings.toolUseWireFormat
    ? ""
    : "from agex.llm.formats import ToolUseWireFormat\n";
  const wireFormatLine = settings.toolUseWireFormat
    ? ""
    : "    wire_format=ToolUseWireFormat(native_thinking=False),\n";
  // Reasoning effort → kwarg on the LLM client constructor.  Only
  // meaningful when native reasoning is enabled; otherwise neither
  // client injects its reasoning/thinking request kwarg.
  //
  // Dispatch by underlying provider rather than by our transport.
  // OpenRouter's unified ``reasoning`` config accepts EITHER
  // ``effort`` OR ``max_tokens`` but not both, and its effort→budget
  // conversion silently disables reasoning on the Anthropic route.
  // We pick the provider-native shape instead:
  //   - Anthropic direct (PyfetchAnthropic): thinking={type, budget_tokens}
  //   - OpenRouter → Anthropic / Google backend: reasoning={enabled, max_tokens}
  //   - OpenRouter → OpenAI (o-series / GPT-5) backend: reasoning={enabled, effort}
  const effort = settings.reasoningEffort ?? "medium";
  const budget = { low: 1024, medium: 2048, high: 4096 }[effort] ?? 2048;
  let reasoningKwargLine = "";
  if (settings.toolUseWireFormat) {
    if (settings.provider === "anthropic") {
      reasoningKwargLine = `    thinking={"type": "enabled", "budget_tokens": ${budget}},\n`;
    } else {
      const modelPrefix = (settings.model || "").toLowerCase().split("/")[0];
      const takesBudget = modelPrefix === "anthropic" || modelPrefix === "google";
      reasoningKwargLine = takesBudget
        ? `    reasoning={"enabled": True, "max_tokens": ${budget}},\n`
        : `    reasoning={"enabled": True, "effort": "${effort}"},\n`;
    }
  }
  return {
    userTz,
    baseUrlLine,
    openrouterLines,
    debugRawLines,
    llmClass,
    wireFormatImport,
    wireFormatLine,
    reasoningKwargLine,
  };
}

/**
 * Wave-2 init: enough Python state for the host to read history and
 * stand the agent up, but no module/skill/task registration. Pairs with
 * ``initAgentRich`` which finishes the wiring once Wave 3 is installed.
 *
 * @param {{ apiKey: string, model: string }} settings
 */
export async function initAgentBasics(settings) {
  const {
    baseUrlLine,
    openrouterLines,
    debugRawLines,
    llmClass,
    wireFormatImport,
    wireFormatLine,
    reasoningKwargLine,
  } = _settingsConstants(settings);
  await runPython(`
from dataclasses import dataclass
import pandas as pd
import plotly.graph_objects as go
from agex import Agent, connect_state, connect_fs, clear_agent_registry

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

${debugRawLines}
# Module installer: fetches a .py from the dev/static server and
# writes it to site-packages so it can be imported by name.  Used for
# the LLM bridge (must happen before the LLM client is constructed),
# host-side helpers (app_storage, bundle), and extracted Python
# modules (event_serialization, ...) that previously lived inline as
# heredocs.
from pyodide.http import open_url as _open_url
import importlib as _importlib
_site_dir = _importlib.import_module("site").getsitepackages()[0]

def _install_module(name, url):
    with open(f"{_site_dir}/{name}.py", "w") as f:
        f.write(_open_url(url).read())
    return _importlib.import_module(name)

_install_module("bridge_llm", "/bridge_llm.py")

from bridge_llm import JsBridgeAdapter as _JsBridgeAdapter
from agex.llm.pyfetch_openai import PyfetchOpenAI
from agex.llm.pyfetch_anthropic import PyfetchAnthropic
${wireFormatImport}
# api_key left empty; adapter injects Authorization on the main thread.
_llm = ${llmClass}(
    model="${settings.model}",
    api_key="",
${baseUrlLine}${openrouterLines}${wireFormatLine}${reasoningKwargLine}    fetch_adapter=_JsBridgeAdapter(),
)

_agent = Agent(
    name="chat",
    primer="You are a helpful assistant.",
    llm=_llm,
    max_iterations=30,
    state=connect_state(type="versioned", storage="indexeddb"),
    fs=connect_fs(type="virtual"),
    chaptering_trigger=${settings.chapteringTrigger},
)

# Register VFS-aware IO modules NOW so they're baked into the first
# system_message.  Without this, the sandbox bridge's per-action
# auto-register would be what adds them, but the bridge call runs
# *after* _build_system_message has already been evaluated for the
# first task — so task 1's system message wouldn't include io/os/
# json/etc. descriptions, but task 2's would, causing a prompt-cache
# miss at the task boundary.  register_io is idempotent.
from agex.helpers.stdlib import register_io as _register_io
_register_io(_agent)
del _register_io

# -- Install host-side helper modules onto the Python path --
# Done in basics because sessions.js (which runs at history-ready)
# imports both app_storage and bundle. bundle imports app_storage at
# module load, so order matters.
_install_module("app_storage", "/app_storage.py")
_install_module("bundle", "/bundle.py")

# -- Event helpers used by sessions.js loadHistory + sendMessage --
# Loaded in basics so the host can render existing chat history while
# Wave 3 is still installing in the background.  The module also
# re-exports the agex event/emission types it needs internally;
# sessions.js and sendMessage's heredoc reference some of them
# directly, so import the names back into pyodide globals here.
_install_module("event_serialization", "/python/event_serialization.py")
from event_serialization import (
    _serialize_output_parts,
    _output_text,
    _split_output_events,
    _serialize_emission,
    _serialize_file_actions,
    _synthesize_action,
    _serialize_chapter_events,
)
from agex.agent.events import (
    ActionEvent as _ActionEvent,
    OutputEvent as _OutputEvent,
    ChapterEvent as _ChapterEvent,
)
from agex.agent.emissions import (
    FileWriteEmission as _FileWriteEmission,
    FileEditEmission as _FileEditEmission,
    TextEmission as _TextEmission,
    ThinkingEmission as _ThinkingEmission,
)

    `);
}

/**
 * Wave-3 init: registers framework helpers + agent modules, installs
 * static skills and helper functions, defines the chat task.
 * Required before ``sendMessage`` can run.
 *
 * @param {{ apiKey: string, model: string }} settings
 */
export async function initAgentRich(settings) {
  const { userTz } = _settingsConstants(settings);
  await runPython(`
_agent.cls(Response)

# -- Library + skill registrations --
# Definitions live in public/python/agent_modules.py.  register_all()
# runs the agex helper bundles, registers third-party libraries
# (pandas/numpy/scipy/sklearn/matplotlib/etc.) low-viz, attaches
# calgebra's bundled SKILL.md, and pulls the static skill markdown
# files served from public/skills/.
_install_module("agent_modules", "/python/agent_modules.py")
import agent_modules as _agent_modules
_agent_modules.register_all(_agent)
del _agent_modules

# -- Studio-app helpers (search, test_app, live_app, render_pdf, ...) --
# Definitions live in public/python/agent_helpers.py.  The register()
# helper wires them onto _agent with the same visibility levels the
# heredoc used; the user's IANA timezone is supplied here from JS.
_install_module("agent_helpers", "/python/agent_helpers.py")
import agent_helpers as _agent_helpers
_agent_helpers.register(_agent, _llm, "${userTz}")
del _agent_helpers

_TASK_PRIMER = """Answer the user's message.

You are running inside Agex Studio, a browser-based AI assistant powered by
Pyodide (Python in WebAssembly). All code runs client-side in the user's
browser — there is no server. All state and data (files, sessions, settings)
live in the browser's IndexedDB and localStorage.

The UI has:
- **Chat panel**: where this conversation happens
- **File drawer** (left): shows your VFS to the user, including any files
  imported from Google Drive (which land under \`/downloads/\`)
- **Settings drawer** (right): API key, model selection, Google account connection
- **Sessions**: each session is an independent conversation with its own files
  and history. Users can create and switch sessions from the session drawer.
- **Preview pane**: displays interactive apps built with the app skill

**Workspace visibility**: the file drawer makes your VFS browsable to
the user. Files you write under \`helpers/\`, \`app/\`, etc. are visible
to them. Nothing syncs to the user's local machine and there's no
remote (git stays local) — but treat the VFS as a shared workspace
the user can read, not a private scratch space.

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

Plotly image export via fig.to_image() / fig.write_image() is unavailable
(kaleido isn't packaged for Pyodide). To show charts, return go.Figure in
a Response; to inspect them yourself, await view_image(fig). To save a
chart to a file, use matplotlib — fig.savefig("path.png") works directly.

PDF files: use render_pdf(path_or_bytes, pages=[0,1], scale=2) to render pages
to PIL Images. Use pdf_page_count(path_or_bytes) to get page count. Use
await view_image(img) to inspect rendered pages. pypdf is available for
text extraction and metadata.
Authoring documents: fpdf2 for PDFs (FPDF().add_page() / .cell() / .output()),
python-pptx for slide decks (Presentation().slides.add_slide(...) / .save()),
openpyxl for .xlsx (pd.read_excel() handles reading; pd.DataFrame.to_excel()
or openpyxl directly for writing).
scipy and scikit-learn are available for statistics, optimization, and machine learning.

Calendars: whenever the user asks about calendars, scheduling, events,
or .ics files, read the calgebra skill first (if you haven't already) —
its API has non-obvious signatures you must not guess at:
  cat /skills/calgebra/SKILL.md
local_timezone() is a registered global — call it directly, do not import.
Always use at_tz(local_timezone()) for timeline slicing.

Google Drive: files the user imports via the file drawer land under
/downloads/ as normal VFS files (txt for Docs, xlsx for Sheets, pdf for
Slides). When working with these files, read the drive skill first:
  cat /skills/drive/SKILL.md

You are already in an async context — use await directly on async functions.
Do not use asyncio.run() — it will fail (you are already in an event loop).
Use asyncio.gather() to run multiple async calls in parallel:
  results = await asyncio.gather(search("topic A"), search("topic B"))
  print(results)
Single search:
  results = await search("your query")
  print(results)

Interactive Apps: when the user wants dashboards, data explorers, filter
widgets, or any interactive UI, read the interactive-app skill first:
  cat /skills/interactive-app/SKILL.md
It covers Preact+HTM, Plotly, the query() bridge for calling Python from
the app, and common patterns. Write app/index.html and the preview panel
appears automatically. After writing or editing app files, call
await test_app() to verify — results are auto-displayed (errors, logs,
read values) on your next turn.
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
    `);

  // Wire up query handler for headless app testing
  setQueryHandler(runQuery);
}

/**
 * Convenience wrapper: runs basics then rich. Useful for tests and
 * any caller that just wants "fully ready"; production startup goes
 * through ChatShell which calls each phase as the worker reaches the
 * matching stage.
 *
 * @param {{ apiKey: string, model: string }} settings
 */
export async function initAgent(settings) {
  await initAgentBasics(settings);
  await initAgentRich(settings);
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
  const json = await runPython(`
import json as _json
_fs = _agent.fs()
_content = _fs.read(${JSON.stringify(path)})
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
  const result = await runPython(`
_fs = _agent.fs()
len(_fs.read(${JSON.stringify(path)}))
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
_uploads = _json.loads(${JSON.stringify(filesJson)})
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
_paths = _json.loads(${JSON.stringify(pathsJson)})
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
  const json = await runPython(`
import json as _json, base64 as _b64
_fs = _agent.fs()
_content = _fs.read(${JSON.stringify(path)})
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

// Serialize runQuery calls so a runaway app iframe (infinite render loop,
// bad useEffect) can't flood the pyodide worker and starve foreground
// operations like createSession / sendMessage. At most one query runs at
// a time; the backlog is capped as defense-in-depth behind AppPreview's
// rate-based freeze detection.
const RUN_QUERY_MAX_BACKLOG = 16;
let _runQueryChain = Promise.resolve();
let _runQueryBacklog = 0;
let _queriesEnabled = true;

/**
 * Disable the query bridge. Any query already in flight on the worker
 * still finishes, but queued queries short-circuit without posting new
 * runPython calls, so the worker drains fast and foreground operations
 * regain their slot. Called by AppPreview when it detects a flood.
 */
export function disableQueries() {
  _queriesEnabled = false;
}

/**
 * Re-enable the query bridge. Called by AppPreview when the user reloads
 * the preview (e.g. after the agent fixes its app).
 */
export function enableQueries() {
  _queriesEnabled = true;
}

/**
 * Run Python code in the agent's sandbox and return requested variables.
 * If resultVars is null, returns all serializable namespace variables.
 *
 * Serialized: queries execute one at a time in the order received.
 *
 * @param {string} code - Python code to execute
 * @param {string[] | null} resultVars - Variable names to return, or null for all
 * @returns {Promise<Record<string, any>>}
 */
export function runQuery(code, resultVars) {
  if (!_queriesEnabled) {
    return Promise.reject(new Error("query bridge disabled (preview paused)"));
  }
  if (_runQueryBacklog >= RUN_QUERY_MAX_BACKLOG) {
    return Promise.reject(
      new Error(
        `query backlog full (${RUN_QUERY_MAX_BACKLOG}) — app is flooding the bridge`,
      ),
    );
  }
  _runQueryBacklog++;
  const result = _runQueryChain.then(() => {
    // Re-check on dequeue: if the preview was frozen while we waited in
    // the chain, drop this query without posting to the worker.
    if (!_queriesEnabled) {
      throw new Error("query bridge disabled (preview paused)");
    }
    return _runQueryImpl(code, resultVars);
  });
  // Keep the chain alive even if this call rejects, so the next waiter runs.
  _runQueryChain = result.catch(() => {}).finally(() => {
    _runQueryBacklog--;
  });
  return result;
}

async function _runQueryImpl(code, resultVars) {
  const resultArg = resultVars ? JSON.stringify(resultVars) : "None";

  const json = await runPython(`
import json as _json
from agex.eval.bridge import aexecute_sandboxed as _aexecute_sandboxed
from agex.cache import PREFIX as _CACHE_PREFIX
from agex.state.live import Live as _Live

_query_code = ${JSON.stringify(code)}
_query_result_vars = ${resultArg}

# Queries run against a scratch Live state so prints / view_image
# events emitted by the query don't pollute the chat agent's event
# log.  The query Live is seeded with the chat agent's cache slice
# (keys under the __cache__/ prefix), so app code calling query()
# can read whatever the agent has explicitly cached (e.g.
# cache["df"] = df) while writes from the query stay turn-local and
# are discarded when the Live goes out of scope.  The agent's VFS
# is shared via fs=_agent.fs() below, so helpers / scratch files
# survive the round-trip.
_chat_state = _agent.state("default")
_query_state = _Live()
for _k in _chat_state.keys():
    if _k.startswith(_CACHE_PREFIX):
        try:
            _query_state[_k] = _chat_state[_k]
        except Exception:
            pass

_query_error = None
_query_namespace = None

try:
    # aexecute_sandboxed returns the post-exec namespace dict.  Under
    # the stateless contract (agex >= 0.12.0) variables defined inside
    # the query don't get synced back to _query_state — they live in
    # the namespace and disappear when _query_namespace falls out of
    # scope.  This is exactly what we want for queries: pluck named
    # results out of the namespace, no leakage back into chat.
    _query_namespace = await _aexecute_sandboxed(
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

# Collect result variables from the post-exec namespace.
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

_ns = _query_namespace or {}
_query_result = {}
if _query_result_vars is not None:
    for _name in _query_result_vars:
        if _name in _ns:
            _query_result[_name] = _serialize(_ns[_name])
else:
    for _name in _ns:
        if _name.startswith("_") or _name.startswith("__"):
            continue
        try:
            _query_result[_name] = _serialize(_ns[_name])
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
  const json = await runPythonStreaming(
    `
import json as _json

_events_log = []

def _on_event(event):
    if isinstance(event, _ActionEvent):
        _events_log.append(_synthesize_action(event))
        # Deterministic turn-boundary signal for the live UI.  Tokens
        # within one turn carry monotonically increasing emission_index
        # values but can still arrive interleaved across emissions
        # (esp. OpenAI Chat Completions tool_calls).  The UI groups
        # streaming tokens by emission_index; this marker tells it
        # "that was everything for this turn, commit the blocks".
        _post_token(_run_id, {
            "type": "turn_complete",
            "content": "",
            "start": False,
            "done": True,
        })
    elif isinstance(event, _OutputEvent):
        _events_log.extend(_split_output_events(_serialize_output_parts(event)))
    elif isinstance(event, _ChapterEvent):
        _state = _agent.state("default")
        _events_log.append({
            "type": "chapter",
            "name": event.name,
            "message": event.message,
            "events": _serialize_chapter_events(event.resolve_events(_state), _state),
        })

def _on_token(token):
    _ttype = token.type
    # Map the retool's richer token vocabulary back to what the UI
    # consumes.  Plain assistant text is surfaced as a report stream;
    # invisible markers (signature / tool_start) are dropped; the
    # streaming file-arg deltas (file_path / file_search /
    # file_content) pass through so the UI can render file writes
    # live instead of popping them in fully-formed at the end.
    if _ttype == "text":
        _ttype = "report"
    elif _ttype in ("signature", "tool_start"):
        return

    # Prebuilt "emission" tokens carry a fully built Emission object
    # (file write/edit, standalone thinking, standalone text).  Route
    # file emissions into the existing file_action envelope; route
    # text and thinking emissions as synthetic report / thinking
    # token bursts so the UI accumulator picks them up.  Every
    # synthetic token carries the original emission_index so the UI
    # can pair a final file_action to whichever streaming
    # file_path/file_content fragments preceded it.
    _eidx = getattr(token, "emission_index", 0)
    if _ttype == "emission":
        _em = getattr(token, "emission", None)
        if isinstance(_em, _FileWriteEmission):
            _post_token(_run_id, {
                "type": "file_action",
                "content": "",
                "start": False,
                "done": True,
                "emission_index": _eidx,
                "action": {
                    "kind": "file",
                    "path": _em.path,
                    "content": _em.content,
                    "mode": _em.mode,
                },
            })
            return
        if isinstance(_em, _FileEditEmission):
            _post_token(_run_id, {
                "type": "file_action",
                "content": "",
                "start": False,
                "done": True,
                "emission_index": _eidx,
                "action": {
                    "kind": "edit",
                    "path": _em.path,
                    "search": _em.search,
                    "content": _em.content,
                    "operation": "replace",
                },
            })
            return
        if isinstance(_em, _TextEmission):
            _text = _em.text or ""
            if _text:
                _post_token(_run_id, {"type": "report", "content": "", "start": True, "done": False, "emission_index": _eidx})
                _post_token(_run_id, {"type": "report", "content": _text, "start": False, "done": False, "emission_index": _eidx})
                _post_token(_run_id, {"type": "report", "content": "", "start": False, "done": True, "emission_index": _eidx})
            return
        if isinstance(_em, _ThinkingEmission):
            _text = (_em.text or "").strip()
            if _text and not _em.redacted:
                _post_token(_run_id, {"type": "thinking", "content": _text, "start": True, "done": False, "emission_index": _eidx})
                _post_token(_run_id, {"type": "thinking", "content": "", "start": False, "done": True, "emission_index": _eidx})
            elif _em.redacted:
                _post_token(_run_id, {"type": "thinking", "content": "[redacted thinking]", "start": True, "done": False, "emission_index": _eidx})
                _post_token(_run_id, {"type": "thinking", "content": "", "start": False, "done": True, "emission_index": _eidx})
            return
        # Unknown emission payload — drop it rather than mis-render.
        return

    _post_token(_run_id, {
        "type": _ttype,
        "content": token.content,
        "start": getattr(token, "start", False),
        "done": token.done,
        "emission_index": getattr(token, "emission_index", 0),
    })

from agex import TaskFail, TaskClarify, TaskCancelled
import asyncio as _asyncio

# Store the running task so the cancel handler can interrupt it
_agex_running_task = _asyncio.current_task()

try:
    _result = await chat(${JSON.stringify(message)}, on_event=_on_event, on_token=_on_token)
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
    `,
    onToken,
  );

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
