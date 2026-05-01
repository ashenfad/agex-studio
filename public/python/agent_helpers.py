"""Studio-app helper functions registered on the chat agent.

Previously defined inline in ``initAgentRich``'s heredoc.  The single
public entry point ``register(agent, llm, user_tz)`` wires the
following onto ``agent`` with the same visibility levels the heredoc
used:

- ``local_timezone``       (high) — user's IANA tz, supplied by JS
- ``search``               (high) — web search via the LLM adapter
- ``test_app``             (low)  — headless preview iframe testing
- ``live_app``             (low)  — interact with the user's preview
- ``render_pdf``           (high) — PDF pages → PIL Images
- ``pdf_page_count``       (high) — PDF page count

JS bridges (``_js_test_app``, ``_js_live_app``, ``_js_render_pdf``,
``_js_pdf_page_count``) are set onto ``__main__``'s globals by
``worker.js``; we look them up at register time and bind them in
closures so individual calls don't pay the lookup cost.
"""

import base64
import io
import json
import re
import sys


def _clean_app_message(msg):
    """Strip data: URLs from stack traces to make them readable."""
    return re.sub(r"data:text/javascript;charset=utf-8,[^\s)]+", "<app>", msg)


def _format_eval_value(raw):
    """Render an eval result for the auto-display channel.

    The iframe bridge always JSON-encodes eval results (even primitives)
    so we have a uniform shape: a string of valid JSON, or None when
    the eval'd expression evaluated to null/undefined.

    Parse, then route through reprobate for budget-bounded rendering —
    keeps an agent that eval'd `document.querySelectorAll('*')` from
    dumping tens of KB into the next turn's prompt while preserving
    structure for normal-sized results.
    """
    if raw is None:
        return "null"
    if not isinstance(raw, str):
        # Defense: shouldn't happen with the JSON-encoding bridge,
        # but if a primitive slips through, repr it directly.
        return repr(raw)
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        # Non-JSON string slipped through (very unlikely) — show
        # as-is, capped at a sensible length.
        return raw if len(raw) <= 2048 else raw[:2048] + "…"
    # Primitives: print bare so `1 + 1` shows as `2`, not `(int) 2`.
    if isinstance(parsed, (int, float, bool)) or parsed is None:
        return json.dumps(parsed)  # canonical: 'null', 'true', '42'
    if isinstance(parsed, str):
        return json.dumps(parsed)  # quoted, escaped
    # Containers (list, dict, nested) — budget-bounded repr.
    try:
        from reprobate import render
        return render(parsed, budget=2048)
    except ImportError:
        # Fallback if reprobate unavailable — truncate at length.
        s = json.dumps(parsed)
        return s if len(s) <= 2048 else s[:2048] + "…"


async def _display_app_results(results, label):
    """Auto-display app test/interaction results.

    Screenshot side effect: raw base64 is emitted via the
    ``__AGEX_IMAGE__:`` marker so agex converts it to an
    ``ImageAction`` on the way back in.  The CALLER is responsible
    for stripping the ``data`` field from the returned dict before
    handing the list to the agent — if it survives into the event
    log it inflates the next prompt by ~1MB per screenshot.
    """
    for r in results:
        if r.get("type") == "log":
            print(f"[{r.get('level', 'log')}] {_clean_app_message(r.get('message', ''))}")
        elif r.get("type") == "read":
            val = r.get("value")
            if val is None:
                print(f"[read {r.get('selector', '')}] (not found)")
            else:
                print(f"[read {r.get('selector', '')}] {val}")
        elif r.get("type") == "eval":
            if "error" in r:
                print(f"[eval error] {_clean_app_message(r['error'])}")
            else:
                print(f"[eval] {_format_eval_value(r.get('value'))}")
        elif r.get("type") == "screenshot":
            print(f"__AGEX_IMAGE__:{r['data']}")
    if not results:
        print(f"[{label}] clean")


def _strip_screenshot_payload(results):
    """Return a copy of the results list with screenshot base64 removed.

    The screenshot has already been delivered to the agent as an
    ``ImageAction`` via the ``__AGEX_IMAGE__:`` marker, so the raw
    data is redundant in the return value.  Leaving it inline would
    blow up the next turn's prompt (a single PNG screenshot is
    commonly 200k–1M chars).  Replace ``data`` with a short marker so
    the caller can still see that a screenshot happened and iterate
    over results without surprises.
    """
    stripped = []
    for r in results:
        if r.get("type") == "screenshot" and "data" in r:
            copy = dict(r)
            copy["data"] = "<shown via view_image>"
            stripped.append(copy)
        else:
            stripped.append(r)
    return stripped


def register(agent, llm, user_tz):
    """Wire the studio-app helpers onto ``agent``.

    ``llm`` supplies the adapter + base_url that ``search`` reuses
    (so a user pointing at a custom OpenAI-compatible endpoint routes
    search the same way).  ``user_tz`` is the browser's resolved
    IANA timezone, returned verbatim by ``local_timezone``.
    """

    # JS bridges installed by worker.js.  Resolved once at register
    # time; closures hold the references for the lifetime of the
    # agent.
    _main = sys.modules["__main__"]
    _js_test_app = getattr(_main, "_js_test_app")
    _js_live_app = getattr(_main, "_js_live_app")
    _js_render_pdf = getattr(_main, "_js_render_pdf")
    _js_pdf_page_count = getattr(_main, "_js_pdf_page_count")

    def local_timezone() -> str:
        """Returns the user's local IANA timezone (e.g. 'America/Los_Angeles').
        Use with calgebra: at = at_tz(local_timezone())
        """
        return user_tz

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
        # OpenRouter key stays in main-thread localStorage and never
        # enters Python scope.  Use the LLM's configured base_url so
        # a user pointing at a different OpenAI-compatible endpoint
        # (local LLM, corporate gateway, etc.) routes search calls
        # to the same place.
        model = "perplexity/sonar-pro-search" if deep else "perplexity/sonar"
        body = {
            "model": model,
            "messages": [
                {
                    "role": "system",
                    "content": "Answer the user's question using web search. Be thorough and include source URLs.",
                },
                {"role": "user", "content": query},
            ],
        }
        try:
            data = await llm._adapter.fetch_json(
                f"{llm._base_url}/chat/completions",
                headers={"Content-Type": "application/json"},
                body=body,
            )
        except Exception as e:
            raise RuntimeError(f"Search failed: {e}")
        return data["choices"][0]["message"]["content"]

    async def test_app(
        actions: list[dict] | None = None, fresh: bool = False
    ) -> list[dict]:
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
            fresh: When True, skip seeding the iframe's localStorage from
                the persisted session.  Useful when iterating on init /
                first-load behavior — without this, every test_app call
                inherits the previous run's saved state (Game Over
                boards, mid-flow form values, etc.) which can mask
                bugs in fresh-load paths.

        Returns:
            List of result dicts (also auto-displayed via print).
        """
        fs = agent.fs()
        app_files = {}
        try:
            all_paths = fs.list("app/", recursive=True)
            for p in all_paths:
                full = "app/" + p
                if fs.isfile(full):
                    app_files[full] = fs.read(full).decode("utf-8", errors="replace")
        except Exception:
            pass
        if not app_files:
            r = [{"type": "log", "level": "error", "message": "No app files found in app/ directory"}]
            await _display_app_results(r, "test_app")
            return r
        actions_json = json.dumps(actions) if actions else None
        # Seed the iframe's localStorage shim with whatever is persisted
        # for this session so tests see the real user state.  Read-only
        # on the test path — writes during test_app are discarded so
        # speculative tests don't clobber the user's live save.
        # ``fresh=True`` skips the seed entirely (empty {} instead).
        if fresh:
            seed_json = "{}"
        else:
            import app_storage

            state_for_seed = agent.state("default")
            seed_json = json.dumps(
                app_storage.read(state_for_seed.versioned, state_for_seed.current_branch)
            )
        results_json = await _js_test_app(
            json.dumps(app_files), actions_json, seed_json
        )
        results = json.loads(results_json)
        await _display_app_results(results, "test_app")
        return _strip_screenshot_payload(results)

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
        actions_json = json.dumps(actions) if actions else None
        results_json = await _js_live_app(actions_json)
        results = json.loads(results_json)
        await _display_app_results(results, "live_app")
        return _strip_screenshot_payload(results)

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
        from PIL import Image as PILImage

        if isinstance(data, str):
            fs = agent.fs()
            data = fs.read(data)

        pdf_b64 = base64.b64encode(data).decode("ascii")
        pages_json = json.dumps(pages) if pages is not None else None
        results_json = await _js_render_pdf(pdf_b64, pages_json, scale)
        results = json.loads(results_json)

        images = []
        for b64_png in results:
            if b64_png is None:
                images.append(None)
            else:
                images.append(PILImage.open(io.BytesIO(base64.b64decode(b64_png))))
        return images

    async def pdf_page_count(data) -> int:
        """Get the number of pages in a PDF.

        Args:
            data: PDF file path (str) or raw bytes.

        Returns:
            Number of pages.
        """
        if isinstance(data, str):
            fs = agent.fs()
            data = fs.read(data)

        pdf_b64 = base64.b64encode(data).decode("ascii")
        return json.loads(await _js_pdf_page_count(pdf_b64))

    agent.fn(local_timezone, visibility="high")
    agent.fn(search, visibility="high")
    agent.fn(test_app, visibility="low")
    agent.fn(live_app, visibility="low")
    agent.fn(render_pdf, visibility="high")
    agent.fn(pdf_page_count, visibility="high")
