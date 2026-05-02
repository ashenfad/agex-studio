"""Module + skill registrations for the chat agent.

Previously a long inline block in ``initAgentRich``'s heredoc.
``register_all(agent)`` runs the agex bundled-helper registrations,
registers the third-party Python libraries the studio ships with,
attaches calgebra's bundled SKILL.md, and pulls the static skill
markdown files served from public/skills/.

Each library is registered with visibility="low" so the agent's
primer doesn't enumerate its API surface — agents already know
pandas/numpy/etc. and can ``dir()``/``help()`` for specifics.
"""

from pyodide.http import open_url

from agex.helpers import (
    register_matplotlib,
    register_numpy,
    register_pandas,
    register_plotly,
    register_stdlib,
)
from agex.git_cli import register_git


# Static skill markdown files served from public/skills/.  Disabled
# entries are kept commented so the OAuth-scope history is visible at
# the registration site.
_STATIC_SKILLS = [
    "/skills/interactive-app.md",
    "/skills/drive.md",
    "/skills/calgebra.md",
    # "/skills/gcal.md",    # disabled — Google Calendar scope removed
    # "/skills/sheets.md",  # disabled — scopes removed
    # "/skills/docs.md",    # disabled — scopes removed
]


def _register_static_skills(agent):
    """Pull skill markdown files served from public/skills/."""
    for path in _STATIC_SKILLS:
        agent.skill(open_url(path).read().encode("utf-8"))


def _register_esbuild(agent):
    """Register the ``esbuild`` terminal command.

    Bundles agent app source files (JSX/TSX/JS/TS) into a single ES
    module via esbuild-wasm.  Bare imports stay external — the
    iframe's import map resolves them to esm.sh at runtime, so the
    bundle stays small even when the agent uses React component
    libraries.

    Visibility=low: agents already know the esbuild CLI from training;
    the skill markdown (see interactive-app skill) covers studio-
    specific usage.

    The handler bridges esbuild-wasm's async API to a sync terminal
    command via ``pyodide.ffi.run_sync``.  Requires JSPI (JavaScript
    Promise Integration), supported by modern Chromium browsers.
    """

    @agent.terminal(visibility="low")
    def esbuild(ctx):
        """Bundle JS / JSX / TS / TSX source via esbuild-wasm.

        Usage:
          esbuild <entry> --outfile=<output> [--minify]
          esbuild --help

        Bare imports (react, @scope/...) stay external and are
        resolved at runtime via the iframe's import map.  Local
        imports (./Chart.jsx) are bundled inline.
        """
        import json
        import sys

        from pyodide.ffi import run_sync

        args = ctx.args
        if not args or args[0] in ("--help", "-h"):
            ctx.stdout.write(
                "Usage: esbuild <entry.jsx> --outfile=<bundle.js> [--minify]\n"
                "       esbuild --help\n\n"
                "Bundles agent app source files (JSX/TSX/JS/TS) into a single\n"
                "ES module.  Bare imports (react, @scope/pkg) stay external\n"
                "and are resolved by the iframe's import map at runtime;\n"
                "local imports (./Chart.jsx) are bundled inline.\n\n"
                "JSX is transformed with the automatic runtime targeting\n"
                "preact (alias react → preact/compat in the import map).\n"
            )
            return None

        entry = None
        outfile = None
        minify = False
        for arg in args:
            if arg in ("--minify", "-m"):
                minify = True
            elif arg.startswith("--outfile="):
                outfile = arg.split("=", 1)[1]
            elif arg.startswith("-o="):
                outfile = arg.split("=", 1)[1]
            elif arg.startswith("-"):
                return ctx.fail(f"esbuild: unknown flag: {arg}")
            elif entry is None:
                entry = arg
            else:
                return ctx.fail(f"esbuild: unexpected positional arg: {arg}")

        if not entry:
            return ctx.fail(
                "esbuild: missing entry point.  Run `esbuild --help`."
            )
        if not outfile:
            return ctx.fail("esbuild: --outfile=<path> is required.")

        fs = ctx.fs
        files = _collect_app_sources(fs)
        if entry not in files:
            return ctx.fail(
                f"esbuild: entry point not found in app/ or helpers/: {entry}"
            )

        # Reach the JS bridge via __main__ (worker.js sets it as a
        # pyodide global).
        main = sys.modules["__main__"]
        try:
            js_esbuild = main._js_esbuild
        except AttributeError:
            return ctx.fail(
                "esbuild: JS bridge not initialized — worker may still be loading."
            )

        options = {"minify": minify}
        try:
            result_json = run_sync(
                js_esbuild(json.dumps(files), entry, json.dumps(options))
            )
        except Exception as e:
            return ctx.fail(f"esbuild: bridge call failed: {e}")

        result = json.loads(result_json)

        # Print warnings to stdout (non-fatal).
        for w in result.get("warnings") or []:
            ctx.stdout.write(_format_diag("warning", w) + "\n")

        if result.get("errors"):
            # Blank line between multi-error blocks so the 3-line
            # structure (header / source / caret) for each is visually
            # separated.
            stderr = "\n\n".join(
                _format_diag("error", e) for e in result["errors"]
            )
            return ctx.fail(stderr or "esbuild: build failed", exit_code=1)

        contents = result.get("contents")
        if contents is None:
            return ctx.fail("esbuild: no output produced")

        # Write the bundle.  Encode UTF-8 for binary fs.write.
        try:
            fs.write(outfile, contents.encode("utf-8"))
        except Exception as e:
            return ctx.fail(f"esbuild: failed to write {outfile}: {e}")

        ctx.stdout.write(
            f"esbuild: bundled {entry} → {outfile} ({len(contents)} bytes)\n"
        )
        return None


def _collect_app_sources(fs) -> dict:
    """Pull source files under app/ and helpers/ into a dict for esbuild.

    Source code is shipped as UTF-8 strings (path → content).  Image
    files (.png/.jpg/.jpeg/.gif/.webp) are shipped as tagged dicts
    ``{"_binary_b64": <base64>}`` so esbuild's dataurl loader can
    inline them when an agent does ``import logo from './logo.png'``.

    Filtered by extension so the bundler doesn't see PDFs, parquet,
    or other large non-source files that happen to live under app/.
    Per-image cap (1MB) prevents runaway bundle bloat from an agent
    accidentally importing a giant asset.
    """
    import base64

    SOURCE_EXTS = (".jsx", ".tsx", ".ts", ".js", ".css", ".json", ".svg")
    BINARY_EXTS = (".png", ".jpg", ".jpeg", ".gif", ".webp")
    BINARY_MAX_BYTES = 1_048_576  # 1MB per image — refuse larger ones

    files: dict = {}
    for root_dir in ("app/", "helpers/"):
        try:
            for rel in fs.list(root_dir, recursive=True):
                full = root_dir + rel
                if not fs.isfile(full):
                    continue
                rel_lower = rel.lower()
                if any(rel_lower.endswith(ext) for ext in SOURCE_EXTS):
                    try:
                        files[full] = fs.read(full).decode("utf-8", errors="replace")
                    except Exception:
                        pass
                elif any(rel_lower.endswith(ext) for ext in BINARY_EXTS):
                    try:
                        data = fs.read(full)
                        if len(data) > BINARY_MAX_BYTES:
                            # Skip — esbuild will error on the missing
                            # import, agent gets a clear message.
                            continue
                        files[full] = {
                            "_binary_b64": base64.b64encode(data).decode("ascii")
                        }
                    except Exception:
                        pass
        except Exception:
            # Directory may not exist yet — fine, just skip.
            pass
    return files


def _format_diag(level: str, d: dict) -> str:
    """Format an esbuild diagnostic for terminal output.

    Three-line block when source location is available:

        {level}: {file}:{line}:{col}: {message}
            {offending source line}
            {caret marker pointing at the column}

    Falls back to a single header line when location is missing.
    """
    text = d.get("text", "")
    loc = d.get("location") or {}
    if not loc:
        return f"{level}: {text}"

    file_ = loc.get("file", "?")
    line = loc.get("line", 0)
    col = loc.get("column", 0)
    line_text = loc.get("lineText", "") or ""
    length = max(int(loc.get("length", 1) or 1), 1)

    header = f"{level}: {file_}:{line}:{col}: {text}"
    if not line_text:
        return header

    # Caret marker — pad with spaces to align under the offending column,
    # then a run of '^' for the length of the highlighted span.
    caret = " " * col + "^" * length
    return f"{header}\n    {line_text}\n    {caret}"


def register_all(agent):
    """Register the bundled libraries + skill markdown onto ``agent``.

    Runs in two layers: agex's helper bundles for popular libraries
    (numpy / pandas / plotly / stdlib / git), then explicit
    ``module(...)`` calls for everything else the studio ships.
    Skills follow.  Order matters loosely — the only hard requirement
    is that matplotlib's Agg backend is selected before anything
    imports pyplot (otherwise backend probing raises in headless
    Pyodide).
    """
    register_stdlib(agent)
    register_pandas(agent)
    register_numpy(agent)
    register_plotly(agent)
    register_git(agent)

    # Override stdlib's restricted random with full access
    import random

    agent.module(random, visibility="low")

    import pypdf

    agent.module(pypdf, visibility="low", recursive=True)

    import openpyxl

    agent.module(openpyxl, visibility="low", recursive=True)

    import scipy

    agent.module(scipy, visibility="low", recursive=True)

    import sklearn

    agent.module(sklearn, visibility="low", recursive=True)

    import skimage

    agent.module(skimage, visibility="low", recursive=True)

    # register_matplotlib forces the Agg backend, pre-warms the font
    # cache (so sandboxed savefig calls don't trigger a fontlist.json
    # lock-write inside site-packages that monkeyfs would block), and
    # exposes the namespace recursively at low visibility.
    register_matplotlib(agent)

    # pyarrow is pandas' default parquet/feather engine and useful in
    # its own right (Tables, schemas, IPC).  Without it, df.to_parquet
    # fails with an engine-not-found ImportError.
    import pyarrow

    agent.module(pyarrow, visibility="low", recursive=True)

    # Document authoring: python-pptx for slide decks, fpdf2 for PDFs.
    # Both registered low-viz — primer mentions the capability,
    # detailed APIs left for the agent to explore via dir() / help.
    import pptx

    agent.module(pptx, visibility="low", recursive=True)
    import fpdf

    agent.module(fpdf, visibility="low", recursive=True)

    # Network access for Google Calendar API
    import calgebra

    agent.module(calgebra, visibility="low", recursive=True, network_access=True)

    try:
        import PIL

        agent.module(PIL, visibility="low", recursive=True)
    except ImportError:
        pass

    import asyncio

    # Low-viz: task primer already documents asyncio.gather / sleep /
    # wait / as_completed; registration still lets the sandbox import
    # and call them.
    agent.module(
        asyncio,
        include=["gather", "sleep", "wait", "as_completed"],
        visibility="low",
    )

    # Calgebra ships its own SKILL.md inside the package, but the
    # studio-customized version at public/skills/calgebra.md teaches
    # studio-specific helpers (local_timezone, google_token) — register
    # only the static one to avoid the agent learning conflicting
    # patterns from two skill files with the same trigger.
    _register_static_skills(agent)

    # esbuild as a terminal command — lets agents bundle JSX/TSX
    # source files into runnable JS for the app preview iframe.
    # See _register_esbuild for the why.
    _register_esbuild(agent)
