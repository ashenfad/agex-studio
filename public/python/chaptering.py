"""Manual chaptering controls + token usage helpers.

Wraps agex chaptering / token-counting APIs in shapes the studio UI
calls directly.  ``run_chaptering`` is invoked by a debug control to
force a chaptering pass on demand; ``estimate_total_tokens`` and
``token_history`` feed the SessionDrawer's context-growth metrics.
"""

from agex import events as agex_events
from agex.agent.chapter import (
    CHAPTER_TASK,
    Chapter,
    build_numbered_task_index,
    prepare_tasks_for_chaptering,
)
from agex.agent.events import (
    ActionEvent,
    ChapterEvent,
    TaskStartEvent,
)
from agex.render.token_count import estimate_log_tokens
from agex.state.log import (
    get_events_from_log,
    replace_events_with_chapters,
)


async def run_chaptering(agent):
    """Force a chaptering pass with the threshold temporarily zeroed.

    Returns ``"ok"`` if any chapters were produced and committed, or
    ``"no_chapters"`` if the chaptering task didn't return anything
    actionable.
    """
    state = agent.state("default")
    result = "no_chapters"

    orig_trigger = agent.chaptering_trigger
    agent.chaptering_trigger = 0
    try:
        all_events = get_events_from_log(state)
        tasks, task_ranges = prepare_tasks_for_chaptering(all_events)
        index_text = build_numbered_task_index(tasks)

        chapters = await agent._chapter_task(event_index=index_text)
        if chapters:
            ch_ranges = []
            for ch in chapters:
                if not isinstance(ch, Chapter):
                    continue
                if ch.start < 1 or ch.end < ch.start:
                    continue
                if ch.start > len(task_ranges) or ch.end > len(task_ranges):
                    continue
                ls = task_ranges[ch.start - 1][0]
                le = task_ranges[ch.end - 1][1]
                ce = ChapterEvent(
                    agent_name=agent.name,
                    name=ch.name,
                    message=ch.message,
                )
                ch_ranges.append((ls, le, ce))

            if ch_ranges:
                replace_events_with_chapters(state, ch_ranges)
                state.commit()
                result = "ok"
    finally:
        agent.chaptering_trigger = orig_trigger

    return result


def estimate_total_tokens(agent):
    """Estimate current context token usage (system prompt + event log)."""
    state = agent.state("default")
    return estimate_log_tokens(agent, state)["total"]


def token_history(agent):
    """Per-turn input_tokens for charting context growth.

    Flattens chapter events back into their original ActionEvents so
    the chart stays dense after compression.  Setup events are
    excluded.  When the most recent task was the chaptering task
    itself, append a current estimate so the chart includes the
    post-compression baseline.
    """
    state = agent.state("default")
    all_events = agex_events(state)

    def flatten(events):
        for e in events:
            if isinstance(e, ChapterEvent):
                yield from flatten(e.resolve_events(state))
            else:
                yield e

    tokens = [
        e.input_tokens
        for e in flatten(all_events)
        if isinstance(e, ActionEvent)
        and e.input_tokens is not None
        and e.source != "setup"
    ]

    last_task = None
    for e in all_events:
        if isinstance(e, TaskStartEvent):
            last_task = e.task_name

    if last_task == CHAPTER_TASK:
        tokens.append(estimate_log_tokens(agent, state)["total"])

    return tokens
