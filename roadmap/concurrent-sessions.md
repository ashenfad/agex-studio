# Concurrent / background sessions

**Status:** proposal (not yet implemented)

Let sessions stay *active in the background*: the user fires a turn on
session A, flips to session B, and A keeps streaming — eventually
running real concurrent agent loops across sessions, not just one at a
time.

This is a two-phase change. The phases are sequenced deliberately:
Phase 1 is a storage-agnostic refactor that can ship on its own and
de-risks Phase 2; Phase 2 is the storage change that actually lights up
concurrency. The seam between them is a single guard.

## Today: one working tree, one loop

Two facts make the studio single-active, and they're independent:

1. **One kvgit working tree.** There is exactly one agex-ts session
   (`SESSION = "default"`, `ts-agent.js:77`) and therefore one
   `Staged` — one working tree with one `currentBranch`. Every studio
   session multiplexes through it via `_ensureBranch` →
   `staged.switchBranch(branch)` (`ts-kernel-adapter.js:119`). kvgit's
   `switchBranch` **discards staged changes** by contract
   (`@agex-ts/kvgit` `Staged`), so the buffer can only hold one
   branch's work at a time. Crucially, *reads* go through this same
   switch — `loadHistory` / `listFiles` / `undoToCommit` all call
   `_ensureBranch` — so even browsing another session yanks the branch
   out from under anything mid-turn.

2. **The loop lives in the view.** `ChatShell.svelte` owns the agent
   run loop (`handleSend`) and accumulates all streaming state into
   component-local `$state`. Switching the foreground view away from a
   running turn orphans / corrupts that state.

Fact 2 is pure studio wiring (storage-agnostic). Fact 1 is the storage
model. Splitting the work along that line is what makes Phase 1
shippable alone.

## Phase 1 — lift the session runtime out of `ChatShell`

Storage-agnostic. Move the session-scoped state and the run loop into a
session-keyed manager; `ChatShell` becomes a projection of the
foreground session.

### State split (verified against `ChatShell.svelte`)

**Session-scoped → moves into the manager record:**

- `messages`, `busy`, `cancelling`, `activeAbort`, `historyChunks`,
  `files`, `chaptering`, `tokenHistory`, `previewRefreshKey`
- streaming accumulators (`ChatShell.svelte:381–393`):
  `streamingEvents`, `currentTurn`, `activeReportText`,
  `activeReportIdx`, `liveSpawnChips`
- the logic that mutates them: `handleSend`, `handleToken`,
  `snapshotTurn`, `commitActiveReport`, `rebuildStreamingMessages`.
  This cluster is already self-contained — it only touches the fields
  above.

**View-scoped → stays in `ChatShell`:**

- drawers (`settingsOpen` / `sessionsOpen` / `filesOpen`)
- modals (`actionModalIndex`, `chapterModalData`, `tokenModalOpen`)
- layout / scroll (`viewMode`, `mobileView`, `scrollKey`)
- kernel boot status (`agentReady`, `initStatus`, `initError`,
  `activeKernel`) — per-kernel/global, not per-session.

### Shape

- `session-runtime.js` — `Map<branch, record>` of reactive,
  session-scoped records; owns `sendMessage` + token accumulation
  parameterized by branch; exposes the foreground record to the view.
- `ChatShell` subscribes to the foreground record, keeps view state,
  and renders a per-session status indicator in the session list from
  each record's `busy`.
- **Global single-flight guard** around kernel-touching ops. This is
  the one line coupling Phase 1 to Phase 2 — mark it clearly
  (`// Phase 2: make this per-session`).

### What Phase 1 delivers vs. defers

Delivers (with per-session in-memory caches): fire a long turn on A,
flip to B and read its already-loaded conversation, flip back — A is
still streaming. Also fixes a latent bug today where a turn's
`onToken` callbacks bleed into whatever session you switched to.

Defers to Phase 2: starting a *second* concurrent turn, or any kernel
read on another session while one runs (both contend on the shared
`Staged`). Until then the global guard serializes kernel ops.

## Phase 2 — per-session working trees

The storage change. Two routes:

- **Route A — agex-ts native sessions (one store per session).** Map a
  studio session to an agex-ts session id; the default `connectState`
  resolver already gives each its own IndexedDB DB. Concurrency is free
  and fully isolated. **Cost:** loses the cheap fork/share story —
  forks become cross-DB blob copies, not content-addressed ref-copies.
  That's a signature studio feature, so this route trades it away.

- **Route B — custom resolver: shared `Versioned`, pinned `Staged` per
  session (recommended).** A `StateBackend` is a Map-shaped surface and
  a kvgit `Staged` satisfies it (agex-ts `connect` typedef). The
  `Agent` is driven by a `StateResolver`
  (`constructor(opts, stateResolver)`), so inject a resolver where
  `resolve(branchName)` returns `new Staged(sharedVersioned)` switched
  **once** to that branch and never again — one pinned working tree per
  active session, all over one shared store. Cheap fork/undo preserved
  *and* concurrency works: each session has its own buffer and commits
  its own branch ref; `peek(key, {branch})` already reads across
  branches without switching.

Then the Phase 1 guard relaxes from global to per-session, and
concurrency turns on.

### Open questions to de-risk Route B

- Does `createAgent` accept a custom `StateResolver`, or must we
  construct `Agent` directly / get agex-ts to expose the injection?
  (The `Agent` constructor takes one; the `createAgent` factory
  currently takes declarative `StateConfig`.)
- Are concurrent `commit()`s to one `Versioned` on *different* branch
  refs transaction-safe? (Expected yes — IndexedDB serializes, refs
  are per-branch keys, objects are content-addressed/idempotent — but
  verify before relying on it.)
- Per-session overlays (`/skills/`, `/chapters/`) and VFS rebuild per
  session already; confirm they bind to the pinned backend, not a
  shared one.

## Non-goals / known limits

- **One Web Worker.** CPU-bound agent eval still serializes across
  sessions; only LLM I/O is truly parallel. Acceptable — turns are
  latency-bound and the worker interleaves at `await` points. Escape
  hatch if it ever bites: worker-per-session (cheap for TS, heavy for
  Pyodide).
- **App preview is foreground-only.** Backgrounded sessions don't
  render their iframe; app-storage is already keyed per
  `(kernel, branch)` (`app-storage.js`) so there's no cross-session
  conflict.

## Sequencing

1. This doc (pin the phasing).
2. Phase 1 extraction as its own PR — move the streaming cluster + loop
   behind `session-runtime.js`, no behavior change, global guard in
   place.
3. Phase 1 UX — per-session status in the session list; preserve
   streaming state across foreground switches.
4. Phase 2 — custom `StateResolver` (Route B), relax the guard to
   per-session.
