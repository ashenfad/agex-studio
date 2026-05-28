# Sessions and storage

How the studio persists chat history, agent state, files, and
session metadata. Captures the invariants that a well-meaning
refactor would most likely break.

Read this before touching `sessions.js`, `ts-agent.js`, `agent.js`
(py), `ts-kernel-adapter.js`, or `py-kernel-adapter.js`.

## Storage at a glance

Four backing stores. Everything in the studio lives in one of them.

| Store | Holds | Survives reload? |
|---|---|---|
| **IndexedDB (kvgit-backed)** | event log, agent cache, sub-task registry, VFS files | yes |
| **`localStorage`** | API key, settings, active session id, per-session app-storage | yes |
| **Pyodide globals (py kernel, in-memory)** | `_agent`, `_llm`, JS bridges, `_agex_running_task` | no |
| **TS worker module-globals** | The runtime worker's per-emission state | no |

Durable user state lives in IndexedDB + localStorage. The other two
are runtime plumbing rebuilt on every page load.

## Sessions = kvgit branches

One kvgit branch per session. Switching sessions is `git checkout`
of a different branch on the same kvgit database. Forking creates
a new branch (see [Fork modes](#fork-modes)). Deleting a session
is `staged.deleteBranch(name)`.

**Why it matters:** any code reading or writing "the current session"
is implicitly operating on the current branch. Touching session
lifecycle without preserving branch isolation breaks multi-session
safety. The custom name/description fields, title, and even the
`__session_kernel__` discriminator all live as state-keys *on the
branch* — they move with it.

Branch naming: chat sessions use the `chat-` prefix
(`CHAT_BRANCH_PREFIX` in `sessions.js`) with a random hex suffix.
The studio filters branches by this prefix when listing sessions
so an admin-managed `meta` branch (if added) wouldn't show in the
UI.

## The key-prefix map

Within a session's kvgit state, the studio + agex-ts + termish-ts
agree on a set of namespaces:

| Prefix / key | Owner | What |
|---|---|---|
| `evt/<id>` | agex-ts `EventLog` | One per event in the log |
| `__event_log__` | agex-ts `EventLog` | Index of event keys (ordered list) |
| `cache/<key>` | agex-ts `Cache` | Persistent across-turn cache the agent writes via `cache.set(k, v)` |
| `f:<absPath>` | termish-ts kvgit-fs | One per VFS file |
| `d:<absPath>` | termish-ts kvgit-fs | One per VFS directory |
| `__subtasks__` | studio (`ts-agent.js`) | JSON blob of registered sub-task specs (when sub-agents land) |
| `__session_title__` | studio | Session display title |
| `__session_name__` | studio | Optional user-provided slug |
| `__session_description__` | studio | Optional description |
| `__session_updated__` | studio | ISO timestamp of last activity |
| `__session_kernel__` | studio | `"ts"` or `"py"` — kernel discriminator |
| `__session_external__` | studio | True for sessions imported from a published gist |

The `__session_*__` and `__subtasks__` exact keys are defined in
`ts-agent.js`'s `META_KEYS` constant (and mirrored in `agent.js`
for py). The other prefixes are conventions from upstream
packages and considered stable contracts.

If you add a new persistent key, add it to this table.

## Commit timing

When does state become durable on disk?

| Action | Commits? | When |
|---|---|---|
| Chat turn (action / output / report events) | yes | the kernel adapter's `sendMessage` finally block calls `agent.commit(SESSION)` regardless of outcome — including cancels (see `ts-kernel-adapter.js`) |
| File upload via studio | yes | inline after `fs.write_many` |
| File delete via studio | yes | inline after `fs.remove_many` |
| Branch meta edit (title, name, etc.) | yes | inline after `state.set(...)` |
| Branch create / fork | yes | the createBranch op itself commits |
| Sub-task registration (when shipped) | yes | inline with the `__subtasks__` blob write |
| `runQuery` (py app preview bridge) | **no** | writes go to a scratch `Live`, discarded |
| `testApp` | **no** | writes during the headless test discarded |
| `liveApp` | reads only | sees last-committed `app/` |
| Manual chaptering | yes | after `agent.runChaptering(...)`, in the adapter's `runChaptering` |
| Cancel mid-turn | yes | the adapter's finally block fires the same commit on both success and cancellation; see "session commit on cancel" below |

The "no" rows are load-bearing. If `runQuery` ever started
persisting its scratch state, app reads would leak into the chat
event log and inflate prompt token costs by megabytes per session.
If `testApp` started committing, speculative tests would clobber
the user's live app state.

### Session commit on cancel

Earlier the adapter's `sendMessage` wrapped the agent call but
didn't commit. agex-ts itself doesn't auto-commit anywhere —
`task.ts` writes events into the kvgit Staged buffer via
`eventLog.add()` and re-throws on abort without flushing. So on
cancel mid-turn, the partial events lived in Staged but never
became durable; a reload lost them entirely.

`ts-kernel-adapter.js`'s `sendMessage` now wraps the chat call in
a try / finally and unconditionally calls `commitSession()` (see
`ts-agent.js`). Idempotent — committing a clean buffer is a no-op.
The same pattern would apply to py if a similar issue surfaced
there.

## VFS structure

The agent's VFS (and the user's, via the file drawer) is a unified
tree:

- `/` — root. Direct file uploads from the chat input land here.
- `app/` — files the live preview iframe renders. Conventionally:
  `app/index.html`, `app/index.js` (or `app/index.jsx` for the
  esbuild path), `app/style.css`. Binary assets like `app/logo.png`
  are served from the iframe as inlined data URLs (see
  [app-preview.md](app-preview.md)).
- `helpers/` — modules the agent can `import './helpers/foo.js'`
  from its own TS code. Persistent across turns within a session.
- `/chapters/<slug>/` — read-only overlay rendered by agex-ts when
  the agent's event log gets folded into chapter summaries. The
  agent can `cat` these to recall earlier context.
- `/skills/<name>/SKILL.md` — read-only overlay for the studio's
  registered skills (`interactive-app`, `numerical`). Sourced from
  the markdown files in `src/lib/skills/`.

Anything outside `app/`, `helpers/`, `/chapters/`, `/skills/` is
"workspace" — uploaded data, intermediate files the agent wrote
for itself, etc.

## Fork modes

Two fork variants. Both create a new chat session that inherits
some part of the source; the difference is what comes along.

### Full fork (`forkSession`)

`adapter.createBranch(newBranch, { from: sourceBranch })`. New
branch references the source's HEAD commit; all blobs and the
entire commit chain are shared. Title rewritten to `"<source> (fork)"`.

Storage cost: zero blob copies; the new branch is a kvgit ref to
an existing commit. Export size: matches the source's reachable
subgraph (full history).

When to reach for it: continuing from the existing state with all
context (chat history, files, cache).

### Fresh chat, keep files (`forkSessionFreshChat`)

`adapter.createBranch(newBranch)` (empty branch from initial
commit), then read all VFS files from source via the public adapter
API and write them onto the new branch as a single commit.

Storage cost: zero NEW bytes — kvgit is content-addressed so
identical file bytes hash to the same blob and dedup. Just a fresh
commit object + tree pointing at the (shared) blobs.

Export size: small — the export walks the new branch's
single-commit chain, not source's ancestry.

When to reach for it: same workspace, new starting point. Retry
with a different model, drop a context that's wandered off, share
a "template" of files without the prior conversation.

### Why fresh-fork isn't "branch off source then wipe agent-memory keys"

The first cut took that route — instant fork, zero copies. But the
export pipeline walks the reachable commit chain from HEAD, so
exports still inherited source's full ancestry (the tombstones
hide keys from reads but don't excise commits from the chain).
Squash bumped fork-time cost from instant to ~1s for a 100 MB
upload but made exports actually match the user's mental model
of "fresh."

`wipeAgentMemory(branch)` remains as an adapter primitive for a
future "soft wipe in place" feature (reset chat on an existing
branch without forking). See its doc in `kernel-adapter.js`.

## Undo

`adapter.undoToCommit(branch, hash)` — points the branch ref back
to an earlier commit. Wraps kvgit-ts's `staged.resetTo(hash)`. The
post-reset state is whatever was committed at that hash, so all
keys (events, cache, files, meta) snap back together.

The UI surfaces undo per message — every committed event carries
a `commit_hash` field stamped at add-time
(`event-log.ts:144 #stamp`), which the message rows read and
attach to the "undo" button. Undoing past a message in the middle
of a turn rewinds *to that point* — everything later is gone from
the new HEAD.

`Staged.resetTo` clears the buffered writes + read cache on
success, so reads immediately after the rewind see the post-reset
state. Don't try to read the pre-reset state via a cached `staged`
reference.

## Session bundles (export / import)

Self-contained `.agex.b64` payloads — the bundle is the kvgit
subgraph reachable from the branch's HEAD, polymorphic-encoded
through termish-ts's `polymorphicEncoder`, then base64-wrapped for
gist storage (gists don't accept binary).

- `adapter.exportBundlePayload(branch, opts)` — walks the
  subgraph, returns `{ bytes, manifest }`.
- `adapter.importBundlePayload(branch, bytes)` — unpacks into a
  fresh branch.
- `adapter.getBundleStats(branch)` — cheap preview (commit
  count, key count, top key sizes) for the export modal.

The bundle includes the chosen branch's full commit chain so the
recipient can undo / fork it like a native session. See
[fork modes](#fork-modes) — for a small export, fresh-fork the
session first, then export the fresh fork.

## App-storage (per-session iframe localStorage)

The live preview iframe runs sandboxed, so its `localStorage`
isn't really persistent. The studio shims it: writes get
serialized into the session's app-storage entry in
`localStorage[appStorageKey(kernel, branch)]` (see
`src/lib/app-storage.js`). On iframe reload, the shim seeds from
that entry.

This is what lets an agent build, e.g., a form-state-preserving
dashboard that survives reload. The per-session scoping keeps
app data isolated across sessions (so two forked sessions of the
same dashboard don't fight over the same form values).

App-storage is *not* in kvgit — it lives in `localStorage`
exclusively. Bundle export does NOT carry it (a separate
opt-in field if we ever add it).

## Cache scope

The agent's `cache` API (agex-ts `Cache`, py `cache` dict) is for
across-turn persistence of objects too rich to round-trip through
the VFS — fitted models, large in-memory structures, parsed
intermediate results.

- Backing: `cache/<key>` state-keys, encoded via the kvgit codec
- Lifetime: persists across actions and across turns within a
  session
- Class instances lose their methods on serialization (the codec
  preserves Map/Set/Date/typed arrays but strips custom-class
  identity) — the agent is told about this in the agex-ts builtin
  primer
- Scope: per-session — switching sessions switches caches

## Cancellation

Two cancel paths through the studio:

1. **AbortSignal (TS kernel).** The chat shell creates an
   `AbortController` per `handleSend`, plumbs the signal into
   `adapter.sendMessage(..., { signal })`. agex-ts honors it
   natively; cancellation surfaces as a `CancelledEvent` in the
   event log (then a "Stopped" band in the chat UI) and the
   adapter's finally still commits.
2. **Cooperative flag (Py kernel).** Worker sets
   `__main__.__agex_cancel_<task_name> = True`; agex-py's monkey-
   patched `check_cancellation` polls that flag and raises
   `TaskCancelled` from inside the agent loop.

Both paths emit a `cancelled` event before re-throwing, so the
UI can render the partial activity card with a "Stopped" band
instead of showing nothing.

The py side also has an `asyncio.CancelledError` recovery path
in `streaming.py` for the case where the asyncio task is cancelled
out from under the loop. The recovery code is load-bearing — it
manually constructs a `CancelledEvent` and commits state so the
log isn't inconsistent with what the user saw.

## External sessions

Sessions imported from a published gist set
`__session_external__ = true`. The UI treats these specially:

- The Files drawer's Drive import is hidden (visitors viewing
  someone else's published artifact shouldn't be able to pull
  from their own Drive).
- The kvgit branch otherwise works identically — they're
  read-write, can be undone / forked / exported just like a
  native session.

The external flag lives on the branch (it's a `__session_*__` meta
key) so it travels with forks.

## Design notes

### Why kvgit branches and not separate stores per session?

Two reasons:

- **Atomic cross-key commits within a session.** A turn updates
  events + cache + maybe files all at once. With a single kvgit
  branch the commit is one transaction; if it fails, nothing
  half-lands.
- **Cheap fork primitive.** Content-addressed storage means a
  fork is a ref-copy, not a data copy. This is what makes
  "experiment with a parallel direction" actually viable for
  large sessions.

The connect.ts layer in agex-ts does support per-session storage
namespaces (separate IndexedDB databases per session); the studio
opts for the single-store model because branches give us the
fork-and-share story for free.

### Why the studio owns `__session_*__` keys vs. delegating to agex-ts

Session-level metadata (title, name, description, kernel) is
embedder-specific. agex-ts has no opinion on what a "session" is
in the embedder's UX. The studio owns those keys and keeps them
on the branch so they move atomically with everything else.
