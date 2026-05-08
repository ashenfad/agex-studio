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
 * Browser's resolved IANA timezone, or "UTC" if undetectable.
 */
function _userTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/**
 * Provider/transport-level wiring: which LLM client class to
 * instantiate, the base_url override, OpenRouter-specific headers,
 * and the optional debug-SSE toggle.
 *
 * The LLM client is instantiated directly (not via connect_llm) so we
 * can pass fetch_adapter without going through connect_llm's
 * config-resolution machinery — that's what lets the JS bridge inject
 * auth on the main thread.
 *
 * @param {{ provider?: string, baseUrl?: string }} settings
 */
function _llmConfig(settings) {
  const providerName =
    settings.provider === "anthropic" ? "pyfetch_anthropic" : "pyfetch_openai";
  const llmClass =
    settings.provider === "anthropic" ? "PyfetchAnthropic" : "PyfetchOpenAI";
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
  return { llmClass, baseUrlLine, openrouterLines, debugRawLines };
}

/**
 * Wire-format selection: whether to inject ``ToolUseWireFormat
 * (native_thinking=False)`` into the LLM client.
 *
 * The retool shipped with ``native_thinking=True`` as the client
 * default, so the "on" branch (recommended, reasoning models) just
 * lets the client default apply — no kwarg needed.  The "off" branch
 * is an explicit opt-out for users on non-reasoning models (old
 * Claude, non-GPT-5 OpenAI, OpenRouter routes without reasoning
 * support) — pass ``ToolUseWireFormat(native_thinking=False)`` so the
 * primer + schema include the narration-in-schema path.
 *
 * @param {{ toolUseWireFormat?: boolean }} settings
 */
function _wireFormatConfig(settings) {
  const wireFormatImport = settings.toolUseWireFormat
    ? ""
    : "from agex.llm.formats import ToolUseWireFormat\n";
  const wireFormatLine = settings.toolUseWireFormat
    ? ""
    : "    wire_format=ToolUseWireFormat(native_thinking=False),\n";
  return { wireFormatImport, wireFormatLine };
}

/**
 * Reasoning-effort kwarg on the LLM client constructor.
 *
 * Only meaningful when native reasoning is enabled
 * (``toolUseWireFormat=true``); otherwise neither client injects its
 * reasoning/thinking request kwarg and we return "".
 *
 * Dispatch by underlying provider rather than by our transport.
 * OpenRouter's unified ``reasoning`` config accepts EITHER ``effort``
 * OR ``max_tokens`` but not both, and its effort→budget conversion
 * silently disables reasoning on the Anthropic route.  We pick the
 * provider-native shape instead — DO NOT unify these without testing
 * end-to-end on each route:
 *
 *   - Anthropic direct (PyfetchAnthropic):     thinking={type, budget_tokens}
 *   - OpenRouter → Anthropic / Google backend: reasoning={enabled, max_tokens}
 *   - OpenRouter → OpenAI (o-series / GPT-5):  reasoning={enabled, effort}
 *
 * @param {{ provider?: string, model?: string, toolUseWireFormat?: boolean, reasoningEffort?: "low"|"medium"|"high" }} settings
 */
function _reasoningKwargLine(settings) {
  if (!settings.toolUseWireFormat) return "";
  const effort = settings.reasoningEffort ?? "medium";
  const budget = { low: 1024, medium: 2048, high: 4096 }[effort] ?? 2048;
  if (settings.provider === "anthropic") {
    return `    thinking={"type": "enabled", "budget_tokens": ${budget}},\n`;
  }
  const modelPrefix = (settings.model || "").toLowerCase().split("/")[0];
  const takesBudget = modelPrefix === "anthropic" || modelPrefix === "google";
  return takesBudget
    ? `    reasoning={"enabled": True, "max_tokens": ${budget}},\n`
    : `    reasoning={"enabled": True, "effort": "${effort}"},\n`;
}

/**
 * Compose the settings-derived literals that basics + rich splice
 * into their Python heredocs.  The matrix knowledge lives in the
 * focused helpers above; this is just glue.
 *
 * @param {{ apiKey: string, model: string, provider?: string, baseUrl?: string, chapteringTrigger?: number, toolUseWireFormat?: boolean, reasoningEffort?: "low"|"medium"|"high" }} settings
 */
function _settingsConstants(settings) {
  return {
    userTz: _userTimezone(),
    ..._llmConfig(settings),
    ..._wireFormatConfig(settings),
    reasoningKwargLine: _reasoningKwargLine(settings),
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
# host-side helpers (bundle), and extracted Python
# modules (event_serialization, ...) that previously lived inline as
# heredocs.
from pyodide.http import open_url as _open_url
import importlib as _importlib
_site_dir = _importlib.import_module("site").getsitepackages()[0]

def _install_module(name, url):
    # Append the app version as a cache-bust so deploys actually
    # invalidate previously-cached helper modules.  Without this,
    # browsers happily serve a stale /python/agent_modules.py even
    # though worker.js (which has its own ?v=) was refetched.
    bust = f"{url}?v=${__APP_VERSION__}"
    with open(f"{_site_dir}/{name}.py", "w") as f:
        f.write(_open_url(bust).read())
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
    # /persist is the OPFS mount set up in worker.js. agex's local
    # host appends "sessions/<session_id>" to the path automatically,
    # so each session gets its own diskcache subdirectory under
    # /persist/sessions/.
    state=connect_state(type="versioned", storage="disk", path="/persist"),
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
# imports bundle for export/import flows.  App-storage moved off the
# kernel substrate in Phase 4 — see src/lib/app-storage.js.
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
    _synthesize_action,
    _serialize_chapter_events,
)

# Sandboxed query exec + chaptering / token-history helpers.  Loaded
# in basics so estimateLogTokens / getTokenHistory work during Wave 2
# (history-ready) before rich finishes installing the libraries.
_install_module("queries", "/python/queries.py")
_install_module("chaptering", "/python/chaptering.py")

# Streaming wrapper used by sendMessage to wire on_event / on_token
# around the chat task.  Loaded in basics so it's ready by the time
# the first sendMessage fires.
_install_module("streaming", "/python/streaming.py")
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
# (pandas / numpy / plotly / pypdf / openpyxl / calgebra / etc.)
# low-viz, and pulls the static skill markdown files served from
# public/skills/.
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

# Chat task primer.  Lives in public/primers/chat_task.md so the
# markdown can be read and edited as plain text instead of a JS-
# escaped heredoc string.
_TASK_PRIMER = _open_url("/primers/chat_task.md").read()

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
import queries as _queries
_json.dumps(await _queries.run_query(_agent, ${JSON.stringify(code)}, ${resultArg}))
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
import streaming as _streaming
_json.dumps(await _streaming.run_chat_task(chat, _agent, ${JSON.stringify(message)}))
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
import chaptering as _chaptering
_json.dumps({"result": await _chaptering.run_chaptering(_agent)})
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
import chaptering as _chaptering
_json.dumps(_chaptering.estimate_total_tokens(_agent))
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
import chaptering as _chaptering
_json.dumps(_chaptering.token_history(_agent))
  `);
  return JSON.parse(json);
}
