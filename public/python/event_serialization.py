"""Event serialization helpers shared by initAgent (live streaming) and
sessions.loadHistory (replay).

These functions translate agex's in-process event objects into the
plain-dict / JSON shape the Svelte UI consumes.  They live in a real
module (rather than a heredoc inside ``agent.js``) so they can be
linted, diffed, and eventually unit-tested as ordinary Python.

The names are imported back into pyodide globals by ``initAgentBasics``
(prefixed with ``_`` to match prior usage), so existing references in
``sessions.js`` and ``sendMessage``'s heredoc continue to resolve.
"""

import base64

from agex.agent.events import (
    ActionEvent as _ActionEvent,
    OutputEvent as _OutputEvent,
    ChapterEvent as _ChapterEvent,
    TaskStartEvent as _TaskStart,
    SuccessEvent as _SuccessEvent,
)
from agex.agent.emissions import (
    FileWriteEmission as _FileWriteEmission,
    FileEditEmission as _FileEditEmission,
    PythonEmission as _PythonEmission,
    TerminalEmission as _TerminalEmission,
    TextEmission as _TextEmission,
    ThinkingEmission as _ThinkingEmission,
)
from agex.eval.objects import (
    PrintAction as _PrintAction,
    ImageAction as _ImageAction,
)

# Markers that flag a print line as an error rather than normal output.
# Currently just the "💥" code-fence preamble emitted by agex on
# uncaught exceptions; kept as a tuple so additional markers can be
# folded in without touching the splitting logic.
_ERROR_KEYWORDS = ("\u{1F4A5}",)

_NL = chr(10)
_NL2 = _NL + _NL


def _serialize_output_parts(event):
    """Translate an OutputEvent's parts list into UI-friendly dicts.

    Splits ``PrintAction`` content on the error-keyword boundary so the
    UI can render the error region with a different style without
    losing the surrounding context.  ``ImageAction`` parts go through a
    PNG round-trip via base64.
    """
    parts = []
    for part in event.parts:
        if isinstance(part, _PrintAction):
            content = " ".join(str(item) for item in part)
            if not any(kw in content for kw in _ERROR_KEYWORDS):
                parts.append({"type": "text", "content": content})
            else:
                lines = content.split(_NL)
                chunk = []
                chunk_is_err = False
                for line in lines:
                    line_is_err = any(kw in line for kw in _ERROR_KEYWORDS)
                    if chunk and line_is_err != chunk_is_err:
                        parts.append(
                            {
                                "type": "error" if chunk_is_err else "text",
                                "content": _NL.join(chunk),
                            }
                        )
                        chunk = []
                    chunk_is_err = line_is_err
                    chunk.append(line)
                if chunk:
                    parts.append(
                        {
                            "type": "error" if chunk_is_err else "text",
                            "content": _NL.join(chunk),
                        }
                    )
        elif isinstance(part, _ImageAction):
            png = getattr(part, "_png_bytes", None)
            if png is None and hasattr(part, "png_bytes"):
                try:
                    png = part.png_bytes()
                except Exception as e:
                    print(f"--- Warning: failed to encode image: {e} ---")
            if png is not None:
                parts.append(
                    {"type": "image", "data": base64.b64encode(png).decode("ascii")}
                )
            elif isinstance(part.image, str):
                parts.append({"type": "image", "data": part.image})
            else:
                parts.append({"type": "text", "content": str(part.image)})
        else:
            parts.append({"type": "text", "content": str(part)})
    return parts


def _output_text(event):
    """Flatten an OutputEvent to a single text string (newline-joined).

    Used by callers that want a quick textual summary without the
    parts/error split.
    """
    lines = []
    for part in event.parts:
        if isinstance(part, _PrintAction):
            lines.append(" ".join(str(item) for item in part))
        else:
            lines.append(str(part))
    return "\n".join(lines)


def _split_output_events(all_parts):
    """Split serialized parts into separate output and error event dicts."""
    out_parts = [p for p in all_parts if p.get("type") != "error"]
    err_parts = [p for p in all_parts if p.get("type") == "error"]
    result = []
    if out_parts:
        result.append(
            {
                "type": "output",
                "message": _NL.join(p.get("content", "") for p in out_parts),
                "parts": out_parts,
            }
        )
    if err_parts:
        result.append(
            {
                "type": "error",
                "message": _NL.join(p.get("content", "") for p in err_parts),
                "parts": err_parts,
            }
        )
    if not result:
        result.append({"type": "output", "message": "", "parts": all_parts})
    return result


def _serialize_emission(em, idx):
    """Per-emission dict the UI can render as its own block.

    Covers all six emission types from the agex retool.  ``idx`` is the
    position within the turn; the UI uses it as a key and, once agex
    ever surfaces event indexes through serialization, it can combine
    with event_idx to pair PrintAction observations to their producing
    emission.
    """
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
    """Legacy flat-fields shape: pick out FileWrite / FileEdit emissions
    and return the old ``{kind, path, ...}`` dicts the existing UI
    consumes.  Kept alongside the emissions-list serialization so
    pre-Wave-2 render paths keep working.
    """
    result = []
    for a in emissions:
        if isinstance(a, _FileWriteEmission):
            result.append(
                {
                    "kind": "file",
                    "path": a.path,
                    "content": a.content,
                    "mode": a.mode,
                }
            )
        elif isinstance(a, _FileEditEmission):
            result.append(
                {
                    "kind": "edit",
                    "path": a.path,
                    "search": a.search,
                    "content": a.content,
                    "operation": "replace",
                }
            )
    return result


def _synthesize_action(evt):
    """Serialize an ActionEvent for the UI.

    Ships both the new emission-list shape (``emissions``, preferred by
    the post-Wave-2 renderer) AND the flat-fields shape (title /
    thinking / report / code / terminal / file_actions) so older
    components keep rendering while the UI migrates.  Multi-emission
    turns get their python / terminal / thinking / text fields
    concatenated in the flat view so nothing disappears when a
    single-block card has to represent several emissions.
    """
    titles = []
    thinking_bits = []
    report_bits = []
    code_bits = []
    term_bits = []
    emissions_dicts = []
    for idx, em in enumerate(evt.emissions):
        ed = _serialize_emission(em, idx)
        if ed is not None:
            emissions_dicts.append(ed)
        if isinstance(em, _PythonEmission):
            if em.title:
                titles.append(em.title)
            if em.thinking:
                thinking_bits.append(em.thinking)
            if em.code:
                code_bits.append(em.code)
        elif isinstance(em, _TerminalEmission):
            if em.title:
                titles.append(em.title)
            if em.thinking:
                thinking_bits.append(em.thinking)
            if em.commands:
                term_bits.append(em.commands)
        elif isinstance(em, _ThinkingEmission):
            if em.text and not em.redacted:
                thinking_bits.append(em.text)
        elif isinstance(em, _TextEmission):
            if em.text:
                report_bits.append(em.text)
    return {
        "type": "action",
        "title": titles[0] if titles else "",
        "thinking": _NL2.join(thinking_bits),
        "report": _NL2.join(report_bits),
        "code": _NL2.join(code_bits) or None,
        "terminal": _NL2.join(term_bits) or None,
        "file_actions": _serialize_file_actions(evt.emissions),
        "emissions": emissions_dicts,
        "input_tokens": evt.input_tokens,
        "output_tokens": evt.output_tokens,
    }


def _serialize_chapter_events(events_list, state=None):
    """Recursively serialize events nested inside a ChapterEvent."""
    result = []
    cur_task = None
    unassigned = []
    for evt in events_list:
        if isinstance(evt, _ActionEvent):
            result.append(_synthesize_action(evt))
        elif isinstance(evt, _OutputEvent):
            result.extend(_split_output_events(_serialize_output_parts(evt)))
        elif isinstance(evt, _ChapterEvent):
            ch_item = {
                "type": "chapter",
                "name": evt.name,
                "message": evt.message,
                "events": _serialize_chapter_events(
                    evt.resolve_events(state) if state else [], state
                ),
            }
            result.append(ch_item)
            unassigned.append(ch_item)
        elif isinstance(evt, _TaskStart):
            cur_task = evt.task_name
            if evt.task_name == "__chapter__":
                result.append({"type": "chaptering", "chapters": []})
            else:
                result.append(
                    {
                        "type": "task_start",
                        "message": evt.inputs.get("message", str(evt.inputs)),
                    }
                )
        elif isinstance(evt, _SuccessEvent):
            if cur_task == "__chapter__":
                n = 0
                if isinstance(evt.result, list):
                    n = sum(1 for ch in evt.result if hasattr(ch, "name"))
                take = min(n, len(unassigned))
                if take > 0:
                    for bm in reversed(result):
                        if bm.get("type") == "chaptering":
                            bm["chapters"] = [
                                {
                                    "name": uc["name"],
                                    "message": uc["message"],
                                    "events": uc.get("events", []),
                                }
                                for uc in unassigned[:take]
                            ]
                            break
                    unassigned = unassigned[take:]
                cur_task = None
            else:
                r = evt.result
                if hasattr(r, "normalize") and hasattr(r, "parts"):
                    rd = {"type": "response", "parts": r.normalize()}
                else:
                    rd = {
                        "type": "text",
                        "content": str(r) if r is not None else "",
                    }
                result.append({"type": "success", "result": rd})
    return result


