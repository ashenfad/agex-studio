# Migration: studio sub-tasks → agex-ts `spawn`

Replace the studio's hand-rolled `defineTask`/`invokeTask` sub-agent
machinery with agex-ts 0.3.0's `spawn`. **Supersedes
[`subagents.md`](./subagents.md)** (that design — named registry,
per-call worker, studio-managed persistence/chips — is being torn out).

Status: planned. agex-ts already bumped to 0.3.0 (commit `e54aff6`);
`Agent.spawn` host method confirmed present.

## Final shape: `spawn` everywhere

One primitive, identical shape in scripts and apps; no registry.

- **Agent scripts** → native `spawn(spec)` (agex-ts builtin, injected
  when `maxSpawns > 0`). Fan out with `Promise.all`. This is THE
  script-side delegation tool.
- **App (iframe) code** → `spawn(spec, { signal })`, an injected global
  that posts `agex-spawn` to the host, which calls
  `agent.spawn(spec, { signal })`. The spec lives inline in
  `app/index.js` (already persisted as a file) — **the app source is the
  registry**.
- `defineTask` / `invokeTask` / the `__subtasks__` registry / the
  `__subtask_invocations__` chip records — **all deleted**. So is
  `json-schema.js` (agex-ts compiles the JSON-schema `output` itself).

| | before | after |
|---|---|---|
| script fan-out | `defineTask`+`invokeTask` | `spawn` |
| app callback | `defineTask`+`invokeTask('name')` | `spawn(spec)` |
| named registry | `__subtasks__` + rehydrate | — (app source) |
| chip persistence | `__subtask_invocations__` + loadHistory interleave | — |
| output validation | `json-schema.js` | agex-ts built-in |
| sub-agent worker | one fresh `workerRuntime` per call | reuses the agent's worker (multiplexed) |

## Decisions (settled in design discussion)

- **Reuse the chat agent** for spawning — no dedicated sub-task agent.
  Clones inherit full policy; that was judged acceptable:
  - *testApp/liveApp* read the parent's files host-side and can't alter
    source; `testApp` runs a throwaway iframe. Not a real hazard.
  - *primer/skill tokens* — skills are lazy (listing only); the ~1.1K
    agent primer rides a **cached** system prefix (Anthropic adapter,
    1h TTL) shared with the already-warm chat agent, so clones pay ~read
    rate, not full. Negligible.
  - *recursion* — neutralized by making `invokeTask` not exist in any
    script/clone scope (below), not by a separate agent.
- **`invokeTask` is app-only, enforced by removal.** It's never
  registered as an agent host fn, so it can't be called from a script or
  inherited by a clone — there's nothing to guard. `defineTask` is gone
  too (apps carry inline specs). The capability boundary is the iframe
  postMessage boundary itself.
- **No persisted chips.** Spawn activity isn't written to state. The
  delegation is still visible post-reload (the `spawn(...)` calls are in
  the agent's logged `ts_action` code); the sub-agent's internals are
  not (the roadmap already conceded this). Live chips are a fast-follow
  (see below), not part of core.
- **Threat model accepted.** App-side `spawn` lets a (possibly imported)
  app run an arbitrary spec on the user's key. Bounded by: the existing
  per-session iframe cost cap (in-memory) **and** the host handler
  **refusing `view`** for app-initiated spawns (no clone access to the
  user's real files). Consistent with "cooperative code you're willing
  to run."

## Behavior changes to flag

- Per-task `maxIterations` / `'inherit'` knob is **gone** — `SpawnSpec`
  has no such field; clones run at the agent's `maxIterations`.
- History chips gone (see above).

## Work items

### Core (host) — one PR

- **`subtasks.js`** — delete. **`json-schema.js`** (+ `.test.js`) —
  delete. **`subtasks.test.js`** — delete / replace with tests for the
  new app-spawn bridge handler + cap.
- **`ts-agent.js`:**
  - Keep `maxSpawns > 0` (default 8) so native `spawn` is injected for
    scripts.
  - Remove the `createSubtaskManager` wiring and the `defineTask` /
    `invokeTask` host-fn registrations.
  - Replace the `invokeSubtask` export with `spawnFromApp(spec, opts)` —
    a host entry that strips `spec.view`, enforces the in-memory
    per-session cap, and calls `_getAgent().spawn(spec, { signal })`.
  - Simplify `loadHistory`: drop `rehydrate` + the `drainSubtasksUpTo`
    interleave; it just walks the agex-ts event log again.
  - Drop `_liveInvocationSink` and the `onSubtask` handling in
    `chatMessage`. Remove now-dead imports.
- **`ts-kernel-adapter.js`:**
  - **Required leak fix:** in `onEvent`, segregate events whose
    `agentName` matches `/:spawn#\d+$/` so clone events don't render
    into the chat narrative (the translator keys on type, not
    `agentName`). For core: drop them.
  - Replace the `invokeTask(branch, name, args, signal)` adapter method
    with `spawn(branch, spec, signal)` → `spawnFromApp`. Remove the
    `onSubtask` block.
- **`AppPreview.svelte`:** rename the `agex-invoke-task` handler to
  `agex-spawn` (carries `spec`, not `name`); call
  `appAdapter.spawn(appBranch, spec, signal)`. Keep origin validation,
  the per-call `AbortController`, and `agex-cancel-*`.
- **`ChatShell.svelte`:** remove `pendingSubtaskChips` + the `subtask`
  token handling (re-added in a simpler form by the live-chips
  fast-follow).

### Skill — same or follow-up PR

- Rewrite `skills/subtasks.md` (rename to `spawn`) to teach one
  primitive: `spawn(spec)` in scripts (fan-out via `Promise.all`) and in
  app code (callbacks), the spec shape, `taskSuccess`, JSON-schema
  `output`, and the footguns (don't autoloop; trim args; reserve for
  judgment, not mechanical work).

### Apps repo (`agex-studio-apps`) — coordinated

- Replace the injected iframe-side `invokeTask(name, args)` global with
  `spawn(spec, opts)` posting `agex-spawn`. Cross-repo; must land with
  the studio's `AppPreview` change.

### Fast-follow (not core)

- **Live chips.** Turn the required event-filter from "drop tagged
  events" into "demux by `:spawn#n` and emit live chip tokens" — a
  "running → done/failed" chip during the spawning turn. Live-only (not
  persisted). Can be richer than the old chips (real progress from the
  clone's event stream).

## Sequencing

1. Core (host) PR — deletes + rewire + required leak filter. Studio
   builds/tests green on its own (app-spawn path is exercised by unit
   tests of `spawnFromApp`; end-to-end needs the apps-repo change).
2. Apps-repo PR — inject `spawn` global. Land with #1.
3. Skill rewrite.
4. Live-chips fast-follow.
</content>
