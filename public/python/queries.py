"""Sandboxed query execution for the app preview bridge.

Apps call ``query()`` from the iframe to read values out of the chat
agent's Python sandbox.  Each query runs against a scratch ``Live``
state seeded with the agent's cache slice — apps can read whatever
the agent has explicitly cached (e.g. ``cache["df"] = df``) but
writes from the query stay turn-local and never leak back into the
chat event log.

``run_query`` returns a JSON-serializable dict that the iframe
deserializes via the message-port bridge.
"""

import json

import numpy as np
import pandas as pd
import plotly.graph_objects as go

from agex.cache import PREFIX as _CACHE_PREFIX
from agex.eval.bridge import aexecute_sandboxed
from agex.state.live import Live


def _serialize(val):
    """Coerce a value to a JSON-encodable shape.

    DataFrames -> {__type__: dataframe, columns, rows} with smart
    per-column float rounding (4 sig figs, capped at 6 decimals).
    Plotly Figures -> {__type__: plotly, figure}.  Dicts / lists /
    tuples recurse.  Everything else falls back to either a
    json.dumps round-trip or str().
    """
    if isinstance(val, pd.DataFrame):
        df = val.reset_index() if not isinstance(val.index, pd.RangeIndex) else val
        for col in df.select_dtypes(include=["float"]).columns:
            vals = df[col].dropna()
            if len(vals) == 0:
                continue
            mag = np.log10(np.maximum(np.abs(vals), 1e-15)).median()
            decimals = max(0, min(6, int(4 - np.floor(mag))))
            df[col] = df[col].round(decimals)
        split = json.loads(df.to_json(orient="split"))
        return {
            "__type__": "dataframe",
            "columns": split["columns"],
            "rows": split["data"],
        }
    elif isinstance(val, go.Figure):
        return {"__type__": "plotly", "figure": json.loads(val.to_json())}
    elif isinstance(val, dict):
        return {k: _serialize(v) for k, v in val.items()}
    elif isinstance(val, (list, tuple)):
        return [_serialize(v) for v in val]
    else:
        try:
            json.dumps(val)
            return val
        except (TypeError, ValueError):
            return str(val)


async def run_query(agent, code, result_vars):
    """Execute a code snippet against a scratch Live state and return
    selected variables, serialized for JSON transport.

    Args:
        agent: The chat agent whose cache + VFS the query reads from.
        code:  Python source string to execute.
        result_vars: List of variable names to return, or ``None`` to
            return all non-private names from the post-exec namespace.

    Returns:
        Dict mapping variable name to its serialized value.

    Raises:
        RuntimeError: Re-raises any non-cancellation exception from the
            sandboxed code (with the original message).
    """
    chat_state = agent.state("default")
    query_state = Live()
    for k in chat_state.keys():
        if k.startswith(_CACHE_PREFIX):
            try:
                query_state[k] = chat_state[k]
            except Exception:
                pass

    namespace = None
    error = None
    try:
        # Under the stateless contract (agex >= 0.12.0) variables defined
        # inside the query don't get synced back to query_state — they
        # live in the namespace and disappear when it falls out of scope.
        # Exactly what we want: pluck named results out, no leakage.
        namespace = await aexecute_sandboxed(
            code,
            agent,
            query_state,
            fs=agent.fs(),
        )
    except BaseException as e:
        if isinstance(e, (SystemExit, KeyboardInterrupt)):
            pass
        else:
            error = str(e)

    if error:
        raise RuntimeError(error)

    ns = namespace or {}
    result = {}
    if result_vars is not None:
        for name in result_vars:
            if name in ns:
                result[name] = _serialize(ns[name])
    else:
        for name in ns:
            if name.startswith("_") or name.startswith("__"):
                continue
            try:
                result[name] = _serialize(ns[name])
            except Exception:
                pass
    return result
