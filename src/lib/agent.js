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
# Install the JS-bridge LLM adapter: routes LLM HTTP calls through the
# main thread so the API key lives in localStorage (never in Python scope).
# Must happen before the LLM client is constructed.
from pyodide.http import open_url as _open_url_llm
import importlib as _importlib_llm, site as _site_llm
_site_dir_llm = _site_llm.getsitepackages()[0]
with open(f"{_site_dir_llm}/bridge_llm.py", "w") as _f:
    _f.write(_open_url_llm("/bridge_llm.py").read())
_importlib_llm.import_module("bridge_llm")
del _open_url_llm, _importlib_llm, _site_llm, _site_dir_llm

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
from pyodide.http import open_url as _open_url_basics
import importlib as _importlib_basics
_site_dir_basics = _importlib_basics.import_module("site").getsitepackages()[0]

def _install_url_module_basics(name, url):
    with open(f"{_site_dir_basics}/{name}.py", "w") as f:
        f.write(_open_url_basics(url).read())
    return _importlib_basics.import_module(name)

_install_url_module_basics("app_storage", "/app_storage.py")
_install_url_module_basics("bundle", "/bundle.py")
del _install_url_module_basics, _open_url_basics, _importlib_basics, _site_dir_basics

# -- Event helpers used by sessions.js loadHistory --
# Defined in basics so the host can render existing chat history while
# Wave 3 is still installing in the background.
from agex.agent.events import ActionEvent as _ActionEvent, OutputEvent as _OutputEvent, ChapterEvent as _ChapterEvent
from agex.agent.events import TaskStartEvent as _TaskStart, SuccessEvent as _SuccessEvent
from agex.agent.emissions import (
    FileWriteEmission as _FileWriteEmission,
    FileEditEmission as _FileEditEmission,
    PythonEmission as _PythonEmission,
    TerminalEmission as _TerminalEmission,
    TextEmission as _TextEmission,
    ThinkingEmission as _ThinkingEmission,
)
from agex.eval.objects import PrintAction as _PrintAction, ImageAction as _ImageAction

_ERROR_KEYWORDS = ("\u{1F4A5}",)

def _serialize_output_parts(event):
    import base64 as _b64
    parts = []
    for part in event.parts:
        if isinstance(part, _PrintAction):
            content = " ".join(str(item) for item in part)
            if not any(kw in content for kw in _ERROR_KEYWORDS):
                parts.append({"type": "text", "content": content})
            else:
                _NL = chr(10)
                lines = content.split(_NL)
                chunk = []
                chunk_is_err = False
                for line in lines:
                    line_is_err = any(kw in line for kw in _ERROR_KEYWORDS)
                    if chunk and line_is_err != chunk_is_err:
                        parts.append({"type": "error" if chunk_is_err else "text", "content": _NL.join(chunk)})
                        chunk = []
                    chunk_is_err = line_is_err
                    chunk.append(line)
                if chunk:
                    parts.append({"type": "error" if chunk_is_err else "text", "content": _NL.join(chunk)})
        elif isinstance(part, _ImageAction):
            _png = getattr(part, "_png_bytes", None)
            if _png is None and hasattr(part, 'png_bytes'):
                try:
                    _png = part.png_bytes()
                except Exception as _e:
                    print(f"--- Warning: failed to encode image: {_e} ---")
            if _png is not None:
                parts.append({"type": "image", "data": _b64.b64encode(_png).decode("ascii")})
            elif isinstance(part.image, str):
                parts.append({"type": "image", "data": part.image})
            else:
                parts.append({"type": "text", "content": str(part.image)})
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

def _split_output_events(all_parts):
    """Split serialized parts into separate output and error event dicts."""
    _NL = chr(10)
    out_parts = [p for p in all_parts if p.get("type") != "error"]
    err_parts = [p for p in all_parts if p.get("type") == "error"]
    result = []
    if out_parts:
        result.append({
            "type": "output",
            "message": _NL.join(p.get("content", "") for p in out_parts),
            "parts": out_parts,
        })
    if err_parts:
        result.append({
            "type": "error",
            "message": _NL.join(p.get("content", "") for p in err_parts),
            "parts": err_parts,
        })
    if not result:
        result.append({"type": "output", "message": "", "parts": all_parts})
    return result

def _serialize_emission(em, idx):
    """Per-emission dict the UI can render as its own block.  Covers
    all six emission types from the agex retool.  idx is the position
    within the turn; the UI uses it as a key and, once agex ever
    surfaces event indexes through serialization, it can combine
    with event_idx to pair PrintAction observations to their
    producing emission."""
    if isinstance(em, _PythonEmission):
        return {
            "kind": "python",
            "idx": idx,
            "code": em.code or "",
            "title": em.title or "",
            "thinking": em.thinking or "",
        }
    if isinstance(em, _TerminalEmission):
        return {
            "kind": "terminal",
            "idx": idx,
            "commands": em.commands or "",
            "title": em.title or "",
            "thinking": em.thinking or "",
        }
    if isinstance(em, _FileWriteEmission):
        return {
            "kind": "file_write",
            "idx": idx,
            "path": em.path,
            "content": em.content,
            "mode": em.mode,
        }
    if isinstance(em, _FileEditEmission):
        return {
            "kind": "file_edit",
            "idx": idx,
            "path": em.path,
            "search": em.search,
            "content": em.content,
            "match_all": em.match_all,
        }
    if isinstance(em, _TextEmission):
        return {"kind": "text", "idx": idx, "text": em.text or ""}
    if isinstance(em, _ThinkingEmission):
        return {
            "kind": "thinking",
            "idx": idx,
            "text": em.text or "",
            "redacted": em.redacted,
        }
    return None

def _serialize_file_actions(emissions):
    """Legacy flat-fields shape: pick out FileWrite / FileEdit
    emissions and return the old {kind, path, ...} dicts the existing
    UI consumes.  Kept alongside the emissions-list serialization so
    pre-Wave-2 render paths keep working."""
    result = []
    for a in emissions:
        if isinstance(a, _FileWriteEmission):
            result.append({
                "kind": "file",
                "path": a.path,
                "content": a.content,
                "mode": a.mode,
            })
        elif isinstance(a, _FileEditEmission):
            result.append({
                "kind": "edit",
                "path": a.path,
                "search": a.search,
                "content": a.content,
                "operation": "replace",
            })
    return result

def _synthesize_action(evt):
    """Serialize an ActionEvent for the UI.  Ships both the new
    emission-list shape ("emissions", preferred by the post-Wave-2
    renderer) AND the flat-fields shape (title / thinking / report /
    code / terminal / file_actions) so older components keep
    rendering while the UI migrates.  Multi-emission turns get their
    python / terminal / thinking / text fields concatenated in the
    flat view so nothing disappears when a single-block card has to
    represent several emissions."""
    _titles = []
    _thinking_bits = []
    _report_bits = []
    _code_bits = []
    _term_bits = []
    _emissions_dicts = []
    for _idx, _em in enumerate(evt.emissions):
        _ed = _serialize_emission(_em, _idx)
        if _ed is not None:
            _emissions_dicts.append(_ed)
        if isinstance(_em, _PythonEmission):
            if _em.title:
                _titles.append(_em.title)
            if _em.thinking:
                _thinking_bits.append(_em.thinking)
            if _em.code:
                _code_bits.append(_em.code)
        elif isinstance(_em, _TerminalEmission):
            if _em.title:
                _titles.append(_em.title)
            if _em.thinking:
                _thinking_bits.append(_em.thinking)
            if _em.commands:
                _term_bits.append(_em.commands)
        elif isinstance(_em, _ThinkingEmission):
            if _em.text and not _em.redacted:
                _thinking_bits.append(_em.text)
        elif isinstance(_em, _TextEmission):
            if _em.text:
                _report_bits.append(_em.text)
    _NL2 = chr(10) + chr(10)
    return {
        "type": "action",
        "title": _titles[0] if _titles else "",
        "thinking": _NL2.join(_thinking_bits),
        "report": _NL2.join(_report_bits),
        "code": _NL2.join(_code_bits) or None,
        "terminal": _NL2.join(_term_bits) or None,
        "file_actions": _serialize_file_actions(evt.emissions),
        "emissions": _emissions_dicts,
        "input_tokens": evt.input_tokens,
        "output_tokens": evt.output_tokens,
    }

def _serialize_chapter_events(events_list, state=None):
    """Recursively serialize events nested inside a ChapterEvent."""
    result = []
    _cur_task = None
    _unassigned = []
    for evt in events_list:
        if isinstance(evt, _ActionEvent):
            result.append(_synthesize_action(evt))
        elif isinstance(evt, _OutputEvent):
            result.extend(_split_output_events(_serialize_output_parts(evt)))
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
from agex.helpers import register_pandas, register_numpy, register_plotly, register_stdlib

_agent.cls(Response)

register_stdlib(_agent)
register_pandas(_agent)
register_numpy(_agent)
register_plotly(_agent)

from agex.git_cli import register_git
register_git(_agent)

# Override stdlib's restricted random with full access
import random as _random
_agent.module(_random, visibility="low")

import pypdf as _pypdf
_agent.module(_pypdf, visibility="low", recursive=True)

import openpyxl as _openpyxl
_agent.module(_openpyxl, visibility="low", recursive=True)

import scipy as _scipy
_agent.module(_scipy, visibility="low", recursive=True)

import sklearn as _sklearn
_agent.module(_sklearn, visibility="low", recursive=True)

import skimage as _skimage
_agent.module(_skimage, visibility="low", recursive=True)

# matplotlib is registered low-viz so the primer doesn't enumerate
# its API surface (huge), but agents can still import it (or
# pyplot) when they reach for it.  Force the non-interactive Agg
# backend before any pyplot import — Pyodide has no GUI display
# and the default backend selection would fail trying to find one.
import matplotlib as _matplotlib
_matplotlib.use("Agg")
_agent.module(_matplotlib, visibility="low", recursive=True)

# Document authoring: python-pptx for slide decks, fpdf2 for PDFs.
# Both registered low-viz — primer mentions the capability,
# detailed APIs left for the agent to explore via dir() / help.
import pptx as _pptx
_agent.module(_pptx, visibility="low", recursive=True)
import fpdf as _fpdf
_agent.module(_fpdf, visibility="low", recursive=True)

# -- Register calgebra with network access for Google Calendar API --
import calgebra as _calgebra
_agent.module(_calgebra, visibility="low", recursive=True, network_access=True)

try:
    import PIL as _PIL
    _agent.module(_PIL, visibility="low", recursive=True)
except ImportError:
    pass

import asyncio as _asyncio
# Low-viz: the task primer already documents how to use
# asyncio.gather / sleep / wait / as_completed, so we don't need to
# spend primer tokens redescribing their signatures here.  Registration
# still lets the sandbox import and call them.
_agent.module(
    _asyncio,
    include=["gather", "sleep", "wait", "as_completed"],
    visibility="low",
)

# -- Register skills from installed packages --
try:
    import pathlib as _pathlib
    _calgebra_pkg = _pathlib.Path(__import__("calgebra").__file__).parent
    _agent.skill(_calgebra_pkg / "skills" / "calgebra" / "SKILL.md")
    del _calgebra_pkg, _pathlib
except Exception as _e:
    print(f"[skills] failed to register: {_e}")

# -- Load static .py modules onto the Python path --
# (app_storage and bundle were installed in basics so sessions.js can
# use them while Wave 3 is still installing.)
from pyodide.http import open_url as _open_url
import importlib as _importlib
_site_dir = _importlib.import_module("site").getsitepackages()[0]

# -- Register skills from static files --
for _skill_path in [
    "/skills/interactive-app.md",
    "/skills/drive.md",
    "/skills/calgebra.md",
    # "/skills/gcal.md",    # disabled — Google Calendar scope removed
    # "/skills/sheets.md",  # disabled — scopes removed
    # "/skills/docs.md",    # disabled — scopes removed
]:
    _agent.skill(_open_url(_skill_path).read().encode("utf-8"))

del _open_url, _skill_path, _site_dir, _importlib

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
    # Route through the same JS bridge the chat LLM uses, so the
    # OpenRouter key stays in main-thread localStorage and never enters
    # Python scope. _llm._adapter is the JsBridgeAdapter set up above.
    _model = "perplexity/sonar-pro-search" if deep else "perplexity/sonar"
    _body = {
        "model": _model,
        "messages": [
            {"role": "system", "content": "Answer the user's question using web search. Be thorough and include source URLs."},
            {"role": "user", "content": query},
        ],
    }
    try:
        # Use the LLM's configured base_url so a user pointing at a
        # different OpenAI-compatible endpoint (local LLM, corporate
        # gateway, etc.) routes search calls to the same place.
        _data = await _llm._adapter.fetch_json(
            f"{_llm._base_url}/chat/completions",
            headers={"Content-Type": "application/json"},
            body=_body,
        )
    except Exception as _e:
        raise RuntimeError(f"Search failed: {_e}")
    return _data["choices"][0]["message"]["content"]

_agent.fn(search, visibility="high")

def _clean_app_message(msg):
    """Strip data: URLs from stack traces to make them readable."""
    import re
    return re.sub(r'data:text/javascript;charset=utf-8,[^\s)]+', '<app>', msg)

async def _display_app_results(_results, _label):
    """Auto-display app test/interaction results.

    Screenshot side effect: raw base64 is emitted via the
    __AGEX_IMAGE__: marker so agex converts it to an ImageAction on
    the way back in.  The CALLER is responsible for stripping the
    'data' field from the returned dict before handing the list to
    the agent — if it survives into the event log it inflates the
    next prompt by ~1MB per screenshot.
    """
    for _r in _results:
        if _r.get("type") == "log":
            print(f"[{_r.get('level', 'log')}] {_clean_app_message(_r.get('message', ''))}")
        elif _r.get("type") == "read":
            _val = _r.get("value")
            if _val is None:
                print(f"[read {_r.get('selector', '')}] (not found)")
            else:
                print(f"[read {_r.get('selector', '')}] {_val}")
        elif _r.get("type") == "eval":
            if "error" in _r:
                print(f"[eval error] {_clean_app_message(_r['error'])}")
            else:
                print(f"[eval] {_r.get('value', '')}")
        elif _r.get("type") == "screenshot":
            print(f"__AGEX_IMAGE__:{_r['data']}")
    if not _results:
        print(f"[{_label}] clean")

def _strip_screenshot_payload(_results):
    """Return a copy of the results list with screenshot base64 removed.

    The screenshot has already been delivered to the agent as an
    ImageAction via the __AGEX_IMAGE__: marker, so the raw data is
    redundant in the return value.  Leaving it inline would blow up
    the next turn's prompt (a single PNG screenshot is commonly
    200k–1M chars).  Replace 'data' with a short marker so the caller
    can still see that a screenshot happened and iterate over results
    without surprises.
    """
    _stripped = []
    for _r in _results:
        if _r.get("type") == "screenshot" and "data" in _r:
            _copy = dict(_r)
            _copy["data"] = "<shown via view_image>"
            _stripped.append(_copy)
        else:
            _stripped.append(_r)
    return _stripped

async def test_app(actions: list[dict] | None = None) -> list[dict]:
    """Test the current app by loading it in a hidden browser iframe.
    Reads files from app/, renders the HTML, waits for initialization
    (including any query() calls), and returns console messages.

    Results are auto-displayed — the print output lands in the next
    turn's observation so you can read it without extra calls.  You
    can also capture the return value if you need to branch on the
    results.

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
            - {"screenshot": True}          — capture a full screenshot (via view_image)
            - {"screenshot": "#selector"}   — screenshot a specific element
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
        await _display_app_results(_r, "test_app")
        return _r
    _actions_json = _json.dumps(actions) if actions else None
    # Seed the iframe's localStorage shim with whatever is persisted for
    # this session so tests see the real user state. Read-only on the
    # test path — writes during test_app are discarded so speculative
    # tests don't clobber the user's live save.
    import app_storage as _as_mod
    _state_for_seed = _agent.state("default")
    _seed_json = _json.dumps(_as_mod.read(_state_for_seed.versioned, _state_for_seed.current_branch))
    _results_json = await _js_test_app(_json.dumps(_app_files), _actions_json, _seed_json)
    _results = _json.loads(_results_json)
    await _display_app_results(_results, "test_app")
    return _strip_screenshot_payload(_results)

_agent.fn(test_app, visibility="low")

async def live_app(actions: list[dict] | None = None) -> list[dict]:
    """Interact with the live app preview that the user sees.

    Use this to read what the user has selected/entered in the app,
    inspect DOM state, or programmatically interact with the live UI.

    Results are auto-displayed — the print output lands in the next
    turn's observation so you can read it without extra calls.  You
    can also capture the return value if you need to branch on the
    results.

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
            - {"screenshot": True}          — capture a full screenshot (via view_image)
            - {"screenshot": "#selector"}   — screenshot a specific element

    Returns:
        List of result dicts (also auto-displayed via print).
    """
    import json as _json
    _actions_json = _json.dumps(actions) if actions else None
    _results_json = await _js_live_app(_actions_json)
    _results = _json.loads(_results_json)
    await _display_app_results(_results, "live_app")
    return _strip_screenshot_payload(_results)

_agent.fn(live_app, visibility="low")

async def render_pdf(data, pages: list[int] | None = None, scale: float = 2) -> list:
    """Render PDF pages to PIL Images.

    Args:
        data: PDF file path (str) or raw bytes.
        pages: 0-indexed page numbers to render. Defaults to all (max 20).
        scale: Resolution multiplier (default 2 for ~150 DPI).

    Returns:
        List of PIL.Image.Image objects (one per page).

    Example:
        images = await render_pdf("/path/to/file.pdf", pages=[0, 1])
        await view_image(images[0])  # inspect first page
    """
    import base64 as _b64
    import json as _json
    from PIL import Image as _PILImage
    import io as _io

    if isinstance(data, str):
        _fs = _agent.fs()
        data = _fs.read(data)

    _pdf_b64 = _b64.b64encode(data).decode("ascii")
    _pages_json = _json.dumps(pages) if pages is not None else None
    _results_json = await _js_render_pdf(_pdf_b64, _pages_json, scale)
    _results = _json.loads(_results_json)

    _images = []
    for _b64_png in _results:
        if _b64_png is None:
            _images.append(None)
        else:
            _images.append(_PILImage.open(_io.BytesIO(_b64.b64decode(_b64_png))))
    return _images

_agent.fn(render_pdf, visibility="high")

async def pdf_page_count(data) -> int:
    """Get the number of pages in a PDF.

    Args:
        data: PDF file path (str) or raw bytes.

    Returns:
        Number of pages.
    """
    import base64 as _b64
    import json as _json

    if isinstance(data, str):
        _fs = _agent.fs()
        data = _fs.read(data)

    _pdf_b64 = _b64.b64encode(data).decode("ascii")
    return _json.loads(await _js_pdf_page_count(_pdf_b64))

_agent.fn(pdf_page_count, visibility="high")

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
from agex.state.live import Live as _Live

_query_code = ${JSON.stringify(code)}
_query_result_vars = ${resultArg}

# Queries run against a scratch Live state seeded with the chat
# agent's user-visible variables. This lets the query read
# dataframes / configs the agent has built up, while discarding any
# writes (loop vars, transient bindings, explicit assignments) when
# the Live goes out of scope. Without this, the query bridge would
# persist its top-level locals into the chat agent's state and
# silently shadow builtins or clobber chat vars on the next turn.
_chat_state = _agent.state("default")
_query_state = _Live()
for _k in _chat_state.keys():
    if _k.startswith("_"):
        continue
    try:
        _query_state[_k] = _chat_state[_k]
    except Exception:
        pass

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
