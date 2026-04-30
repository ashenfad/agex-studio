"""Token streaming wrapper for sendMessage's chat task.

``run_chat_task`` runs the chat task with on_event / on_token wired up:

- on_event translates ActionEvent / OutputEvent / ChapterEvent into
  UI-shaped dicts and appends them to the events log.  After each
  ActionEvent it posts a ``turn_complete`` token so the UI accumulator
  knows when to commit streaming fragments into a coherent action card.

- on_token translates the agex retool's polymorphic token vocabulary
  (text / signature / tool_start / emission) into the dispatch shape
  the Svelte UI accumulator consumes.  ``emission_index`` is preserved
  on every synthesized token so the UI can pair streaming fragments
  with their final emission, even when tokens arrive interleaved
  across emissions (the OpenAI Chat Completions tool_calls case).

The ``post_token`` bridge and per-call ``run_id`` come from
``__main__`` — worker.js installs them as pyodide globals before any
runPython call.

Cancellation comes via two paths.  ``TaskCancelled`` is the agex-loop
path (clean).  ``asyncio.CancelledError`` is what you get when the
runtime cancels the worker task out from under agex — we record a
``CancelledEvent`` manually so the persisted log reflects the cancel
even though agex's loop never saw it.
"""

import asyncio
import sys

from agex import TaskCancelled, TaskClarify, TaskFail
from agex.agent.events import (
    ActionEvent,
    CancelledEvent,
    ChapterEvent,
    OutputEvent,
)
from agex.agent.emissions import (
    FileEditEmission,
    FileWriteEmission,
    TextEmission,
    ThinkingEmission,
)
from agex.state.log import add_event_to_log

from event_serialization import (
    _serialize_chapter_events,
    _serialize_output_parts,
    _split_output_events,
    _synthesize_action,
)


def _make_event_handler(events_log, post_token, run_id, agent):
    """Build the on_event callback that serializes events into the log."""

    def on_event(event):
        if isinstance(event, ActionEvent):
            events_log.append(_synthesize_action(event))
            # Deterministic turn-boundary signal for the live UI.
            # Tokens within one turn carry monotonically increasing
            # emission_index values but can still arrive interleaved
            # across emissions (esp. OpenAI Chat Completions
            # tool_calls).  The UI groups streaming tokens by
            # emission_index; this marker tells it "that was
            # everything for this turn, commit the blocks."
            post_token(run_id, {
                "type": "turn_complete",
                "content": "",
                "start": False,
                "done": True,
            })
        elif isinstance(event, OutputEvent):
            events_log.extend(_split_output_events(_serialize_output_parts(event)))
        elif isinstance(event, ChapterEvent):
            state = agent.state("default")
            events_log.append({
                "type": "chapter",
                "name": event.name,
                "message": event.message,
                "events": _serialize_chapter_events(
                    event.resolve_events(state), state
                ),
            })

    return on_event


def _make_token_handler(post_token, run_id):
    """Build the on_token callback that translates agex's token
    vocabulary into the UI's dispatch shape."""

    def on_token(token):
        ttype = token.type
        # Map the retool's richer token vocabulary back to what the
        # UI consumes.  Plain assistant text is surfaced as a report
        # stream; invisible markers (signature / tool_start) are
        # dropped; the streaming file-arg deltas (file_path /
        # file_search / file_content) pass through so the UI can
        # render file writes live instead of popping them in
        # fully-formed at the end.
        if ttype == "text":
            ttype = "report"
        elif ttype in ("signature", "tool_start"):
            return

        # Prebuilt "emission" tokens carry a fully built Emission
        # object (file write/edit, standalone thinking, standalone
        # text).  Route file emissions into the existing file_action
        # envelope; route text and thinking emissions as synthetic
        # report / thinking token bursts so the UI accumulator picks
        # them up.  Every synthetic token carries the original
        # emission_index so the UI can pair a final file_action to
        # whichever streaming file_path/file_content fragments
        # preceded it.
        eidx = getattr(token, "emission_index", 0)
        if ttype == "emission":
            em = getattr(token, "emission", None)
            if isinstance(em, FileWriteEmission):
                post_token(run_id, {
                    "type": "file_action",
                    "content": "",
                    "start": False,
                    "done": True,
                    "emission_index": eidx,
                    "action": {
                        "kind": "file",
                        "path": em.path,
                        "content": em.content,
                        "mode": em.mode,
                    },
                })
                return
            if isinstance(em, FileEditEmission):
                post_token(run_id, {
                    "type": "file_action",
                    "content": "",
                    "start": False,
                    "done": True,
                    "emission_index": eidx,
                    "action": {
                        "kind": "edit",
                        "path": em.path,
                        "search": em.search,
                        "content": em.content,
                        "operation": "replace",
                    },
                })
                return
            if isinstance(em, TextEmission):
                text = em.text or ""
                if text:
                    post_token(run_id, {"type": "report", "content": "", "start": True, "done": False, "emission_index": eidx})
                    post_token(run_id, {"type": "report", "content": text, "start": False, "done": False, "emission_index": eidx})
                    post_token(run_id, {"type": "report", "content": "", "start": False, "done": True, "emission_index": eidx})
                return
            if isinstance(em, ThinkingEmission):
                text = (em.text or "").strip()
                if text and not em.redacted:
                    post_token(run_id, {"type": "thinking", "content": text, "start": True, "done": False, "emission_index": eidx})
                    post_token(run_id, {"type": "thinking", "content": "", "start": False, "done": True, "emission_index": eidx})
                elif em.redacted:
                    post_token(run_id, {"type": "thinking", "content": "[redacted thinking]", "start": True, "done": False, "emission_index": eidx})
                    post_token(run_id, {"type": "thinking", "content": "", "start": False, "done": True, "emission_index": eidx})
                return
            # Unknown emission payload — drop it rather than mis-render.
            return

        post_token(run_id, {
            "type": ttype,
            "content": token.content,
            "start": getattr(token, "start", False),
            "done": token.done,
            "emission_index": getattr(token, "emission_index", 0),
        })

    return on_token


def _serialize_result(result):
    """Format the task's return value for the UI.

    Anything with ``normalize()`` and ``parts`` (the studio's Response
    dataclass) becomes a structured response; everything else
    stringifies.  Duck-typed instead of imported to avoid coupling
    this module to the basics heredoc where Response lives.
    """
    if hasattr(result, "normalize") and hasattr(result, "parts"):
        return {"type": "response", "parts": result.normalize()}
    return {"type": "text", "content": str(result) if result is not None else ""}


async def run_chat_task(task, agent, message):
    """Run the chat task with streaming on_event / on_token callbacks.

    Args:
        task:    The agex-decorated chat task (e.g. the one defined by
                 the @_agent.task decorator at the end of rich init).
        agent:   The chat agent — used for state(...) lookups when
                 serializing chapter events and recording a manual
                 CancelledEvent on asyncio cancellation.
        message: The user's message string.

    Returns:
        Dict ``{"result": serialized, "events": [...]}`` ready for
        json.dumps.

    Catches TaskFail / TaskClarify / TaskCancelled and surfaces their
    message as the result.  asyncio.CancelledError bypasses agex's
    loop, so we record a CancelledEvent and commit state manually
    before falling through.
    """
    # post_token + run_id come from __main__ (worker.js installs the
    # bridge before runPython).  _agex_running_task lives on __main__
    # too — that's where the worker's cancel-message handler reads
    # from.
    main = sys.modules["__main__"]
    post_token = main._post_token
    run_id = main._run_id

    events_log = []
    on_event = _make_event_handler(events_log, post_token, run_id, agent)
    on_token = _make_token_handler(post_token, run_id)

    main._agex_running_task = asyncio.current_task()
    try:
        result = await task(message, on_event=on_event, on_token=on_token)
    except TaskCancelled:
        result = None
        events_log.append({"type": "cancelled"})
    except asyncio.CancelledError:
        result = None
        events_log.append({"type": "cancelled"})
        # asyncio cancel bypasses agex's loop — record a
        # CancelledEvent and commit manually so the persisted log
        # reflects the cancel.
        try:
            state = agent.state("default")
            add_event_to_log(
                state,
                CancelledEvent(
                    agent_name=agent.name,
                    task_name="chat",
                    iterations_completed=0,
                ),
            )
            state.commit()
        except Exception:
            pass
    except TaskFail as tf:
        result = tf.message
    except TaskClarify as tc:
        result = tc.message
    finally:
        main._agex_running_task = None

    return {
        "result": _serialize_result(result),
        "events": events_log,
    }
