# State, Filesystem, and Cache

How studio-specific persistence works.  Captures the invariants that
aren't documented elsewhere and that a well-meaning refactor would
most likely break.  Read this before touching `agent.js`,
`sessions.js`, or any of the `public/python/*.py` modules that wrap
state.

This is **not** a full architecture doc — agex's own state semantics,
kvgit branch behavior, and IndexedDB internals are owned by their
upstream docs.  The bar here is "does dropping this section make a
refactor riskier?"


## Storage at a glance

Four backing stores.  Everything in the studio lives in one of them.

| Store | Holds | Survives reload? |
| --- | --- | --- |
| **IndexedDB (kvgit-backed)** | event log, agent cache, VFS files | yes |
| **`localStorage`** | API key, settings, current session id | yes |
| **Pyodide globals (in-memory, per page)** | `_agent`, `_llm`, JS bridges, `_agex_running_task` | no |
| **`__main__` attribute flags** | `__agex_cancel_<task_name>` (cooperative cancel) | no |

The first two are durable user state; the second two are runtime
plumbing rebuilt on every page load.


## Sessions = kvgit branches

One kvgit branch per session.  Switching sessions is `git checkout` of
a different branch on the same kvgit repo.  Forking creates a new
branch from a commit hash.  Deleting a session is a branch delete.

**Why it matters**: any code that reads or writes "the current
session" is implicitly operating on the current branch.  Touching
session lifecycle without preserving branch isolation breaks
multi-session safety.  Custom name/description fields and the
`__session_title__` key all live on the branch — they move with it.


## Commit timing

When does state become durable?

| Action | Commits? | When |
| --- | --- | --- |
| Chat turn (action / output / chapter event) | yes | agex's task loop, at well-defined boundaries |
| File upload (`uploadFiles`) | yes | inline after `fs.write_many` |
| File delete (`deleteFiles`) | yes | inline after `fs.remove_many` |
| `runQuery` (app preview bridge) | **no** | writes go to a scratch `Live`, discarded |
| `test_app` | **no** | writes during the headless test discarded |
| `live_app` | reads only | sees last-committed `app/` |
| Manual chaptering (`runChaptering`) | yes | after `replace_events_with_chapters` |
| `asyncio.CancelledError` recovery | yes | manual `CancelledEvent` + commit in `streaming.run_chat_task` |

The "no" rows are load-bearing.  If `runQuery` ever started persisting
its scratch state, app reads would leak into the chat event log and
inflate prompt token costs by megabytes per session.  If `test_app`
started committing, speculative tests would clobber the user's live
app state.


## `runQuery` isolation

The most subtle invariant in the codebase.  State sharing between the
chat agent and a query is intentional and **asymmetric**:

- **Cache slice** (keys with `agex.cache.PREFIX`): copied into a
  scratch `Live` state at query start.  Apps can read whatever the
  agent has explicitly cached (e.g. `cache["df"] = df`), but they
  read a snapshot — later cache writes from chat won't appear until
  the next query.
- **VFS**: shared *live*, not copied — `fs=agent.fs()` is passed
  through.  Queries read whatever is currently on disk; helpers and
  scratch files survive the round-trip naturally.
- **Post-exec namespace**: variables defined inside the query code
  live in the namespace dict and disappear when it falls out of scope
  (per agex's stateless contract since 0.12.0).
- **Scratch `Live`**: writes go here; they never sync back to the
  chat agent's state and are discarded when the query returns.

The serialization layer (`queries.run_query`) is responsible for
this — don't move state plumbing out of that module without
understanding why each direction is configured the way it is.


## App preview surface (`test_app` vs `live_app`)

These look similar but have different state semantics.

**`test_app`** loads `app/` files in a hidden iframe for the agent's
own use.  It seeds the iframe's `localStorage` shim with the agent's
persisted app-storage state (so tests see real user state) but writes
during the test are **discarded**.  Speculative testing must not
clobber the user's saved app data.

**`live_app`** drives the iframe the *user* is looking at.  It
reflects the **last-committed** `app/` files — uncommitted changes
made earlier in the current chat turn won't appear there until
`task_success()` triggers the agex loop's commit.

This last invariant is the source of "I edited the app but it didn't
change in the preview" confusion.  The chat task primer warns about
it; if a refactor adds optimistic-write previews, that warning
becomes a lie and apps render with inconsistent state.


## Cache scope and convention

The agent's `cache` dict is the in-Python-session persistence layer
for objects too rich or expensive to round-trip through the VFS
(fitted models, large DataFrames, parsed structures).

- Backing: keys with the `agex.cache.PREFIX` prefix in the chat
  agent's state, picklable values
- API: dict-like (`cache["key"] = value`, `cache.get("key")`,
  `del cache["key"]`, `list(cache)`)
- Lifetime: persists across actions and tasks within a session
- Mirror: snapshot copied into `runQuery`'s scratch state at query
  time.  Writes from query code (`cache["x"] = ...`) succeed but are
  turn-local — discarded when the query returns, never sync back to
  chat.  Reads see the agent's last-committed cache slice.

The agent learns this from the agex builtin primer.  The studio's
involvement is only at the visibility boundary — making sure the
cache slice gets copied (not shared) into queries.


## Cancellation bridge

Two distinct cancel paths, both documented inline in `streaming.py`:

1. **`TaskCancelled`** — the clean path.  The worker sets
   `__main__.__agex_cancel_<task_name> = True`; agex's monkey-patched
   `check_cancellation` polls that flag and raises `TaskCancelled`
   from inside the agex loop.  The exception handler in
   `run_chat_task` records a `cancelled` event in the log.

2. **`asyncio.CancelledError`** — the bypass path.  Some cancel paths
   (worker termination, top-level abort) cancel the asyncio task out
   from under agex's loop.  The loop never sees the cancel and never
   commits a record of it.  `run_chat_task`'s except branch
   compensates: it manually constructs a `CancelledEvent`, appends it
   to the log, and commits state.

The asyncio recovery code is **not** defensive — it's load-bearing.
If you delete it, asyncio cancels leave the persistent log
inconsistent with what the user saw in the UI.


## Pyodide globals (rebuilt per page load)

Names that the studio installs on `__main__` for cross-cutting access:

| Name | Set by | Read by |
| --- | --- | --- |
| `_agent`, `_llm` | `initAgentBasics` | every per-call heredoc |
| `_post_token`, `_run_id` | `worker.js`, `runPythonStreaming` | `streaming.py`, `sessions.js` progress |
| `_js_test_app`, `_js_live_app`, `_js_render_pdf`, `_js_pdf_page_count` | `worker.js` | `agent_helpers.py` (looked up at register time) |
| `_install_module` | `initAgentBasics` loader block | every subsequent install in basics + rich |
| `_agex_running_task` | `streaming.run_chat_task` (entry/exit) | worker's cancel-message handler |

The `__main__`-as-shared-namespace pattern is how the studio's
Python layer lets per-call modules find the studio-singleton agent /
LLM / JS bridges without threading them through every function
signature.  The trade-off: anything that adds a new global needs a
row in this table to remain auditable.


## Forking and external sessions

Forking copies the kvgit branch under a new id and rewrites the
session title to mark it as a fork.  External sessions (loaded from
a published gist) follow the same pattern — the gist payload is
unbundled into a fresh branch.

Both flows preserve event log + cache + VFS in lockstep because
they're all on the same branch.  If you're tempted to "save just
the conversation" or "fork without the files," know that you're
breaking the implicit invariant that a session's state is one
indivisible unit.
