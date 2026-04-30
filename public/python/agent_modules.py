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


def _register_calgebra_skill(agent):
    """Calgebra ships its own SKILL.md inside the package; mount it
    via the package's __file__ path."""
    import pathlib

    try:
        pkg_dir = pathlib.Path(__import__("calgebra").__file__).parent
        agent.skill(pkg_dir / "skills" / "calgebra" / "SKILL.md")
    except Exception as e:
        print(f"[skills] failed to register: {e}")


def _register_static_skills(agent):
    """Pull skill markdown files served from public/skills/."""
    for path in _STATIC_SKILLS:
        agent.skill(open_url(path).read().encode("utf-8"))


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

    # matplotlib registered low-viz so the primer doesn't enumerate
    # its API surface (huge), but agents can still import it (or
    # pyplot) when they reach for it.  Force the non-interactive Agg
    # backend before any pyplot import — Pyodide has no GUI display
    # and the default backend selection would fail trying to find one.
    import matplotlib

    matplotlib.use("Agg")
    agent.module(matplotlib, visibility="low", recursive=True)

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

    _register_calgebra_skill(agent)
    _register_static_skills(agent)
