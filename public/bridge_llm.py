"""JS-bridge fetch adapter for agex's pyfetch LLM clients.

Routes LLM HTTP calls through a main-thread JS bridge so the API key can
live in ``localStorage`` (main-thread-only) instead of the Pyodide worker's
Python scope.

Wiring:
  - Worker registers ``_js_llm_fetch`` and ``_js_llm_stream`` as Python-
    callable globals (see worker.js).
  - Those JS functions postMessage to the main thread, which reads the
    key from localStorage, injects ``Authorization``, performs the
    actual fetch, and streams results back to the worker via postMessage.
  - This Python module calls those globals and translates the results
    into the ``FetchAdapter`` contract that agex's pyfetch clients expect.

End result: the OpenRouter/Anthropic API key never enters Python scope.
A malicious pickle deserialized in the worker has no credential to steal.
"""

import asyncio
import json
from typing import AsyncIterator

from agex.llm.adapter import FetchAdapter


class JsBridgeAdapter(FetchAdapter):
    """FetchAdapter that routes all LLM HTTP calls through a main-thread JS bridge.

    Expects two globals to be registered on the worker's Pyodide scope:
      - ``_js_llm_fetch(request_json: str) -> Promise<str>`` returning a
        JSON-serialized ``{ok, data}`` object for non-streaming requests.
      - ``_js_llm_stream(request_json: str, on_chunk, on_done, on_error)``
        for streaming requests. Fires the three callbacks during the
        stream lifetime; does not return a meaningful promise.
    """

    async def fetch_json(
        self,
        url: str,
        *,
        headers: dict[str, str],
        body: dict,
    ) -> dict:
        from js import _js_llm_fetch

        request_json = json.dumps(
            {
                "url": url,
                "method": "POST",
                "headers": headers,
                "body": json.dumps(body),
            }
        )
        result_json = await _js_llm_fetch(request_json)
        result = json.loads(result_json)
        if not result.get("ok"):
            status = result.get("status", 0)
            error_msg = result.get("error", f"HTTP {status}")
            raise RuntimeError(f"API error ({status}): {error_msg}")
        return result["data"]

    async def fetch_stream(
        self,
        url: str,
        *,
        headers: dict[str, str],
        body: dict,
    ) -> AsyncIterator[str]:
        from js import _js_llm_stream, _js_llm_stream_cancel
        from pyodide.ffi import create_proxy

        queue: asyncio.Queue = asyncio.Queue()

        def on_chunk(chunk: str) -> None:
            queue.put_nowait(("chunk", chunk))

        def on_done() -> None:
            queue.put_nowait(("done", None))

        def on_error(msg: str) -> None:
            queue.put_nowait(("error", msg))

        chunk_proxy = create_proxy(on_chunk)
        done_proxy = create_proxy(on_done)
        error_proxy = create_proxy(on_error)
        stream_id = None
        try:
            request_json = json.dumps(
                {
                    "url": url,
                    "method": "POST",
                    "headers": headers,
                    "body": json.dumps(body),
                }
            )
            # JS drives the stream and invokes our callbacks as chunks
            # arrive; the returned id lets us cancel the upstream fetch
            # when *we* decide we're done consuming — critical when the
            # caller breaks out of the generator early (e.g. agex's
            # XML tokenizer exits after </PYTHON>) while the LLM is
            # still emitting trailing keep-alive / [DONE] / usage
            # frames. Without this cancel, the main thread keeps
            # reading and posting chunks at a consumer that's
            # destroyed its callbacks, tripping PyProxy "already
            # destroyed" errors.
            stream_id = _js_llm_stream(
                request_json, chunk_proxy, done_proxy, error_proxy
            )

            while True:
                tag, value = await queue.get()
                if tag == "chunk":
                    yield value
                elif tag == "done":
                    return
                else:  # "error"
                    raise RuntimeError(value)
        finally:
            # Tell JS to abort the fetch FIRST so no more chunk messages
            # are produced; then it's safe to destroy the callback
            # proxies. Cancel is idempotent — no-op if JS already
            # completed/errored this stream.
            if stream_id is not None:
                try:
                    _js_llm_stream_cancel(stream_id)
                except Exception:
                    pass
            chunk_proxy.destroy()
            done_proxy.destroy()
            error_proxy.destroy()
