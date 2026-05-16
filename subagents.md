# Sub-agents in agex-studio

Captures the design for letting an agent define and invoke sub-agents
— callable, primed task functions that run in their own isolated
context and can be reached either from the parent's own action space
or embedded in an iframe app.

Status: design only. No code yet. No agex-ts changes anticipated for
v1.

## Motivation

Two distinct use cases that turn out to share one primitive:

1. **App-embedded callbacks** — the agent builds an app in `app/`
   (e.g. tic-tac-toe vs an LLM, an NPC dialog window, an interactive
   tutor) and wants the iframe to invoke an LLM-powered "function"
   on user actions. The user clicks "Go", the app calls back into a
   sub-agent, the sub-agent picks a chess move and returns it.

2. **Agent-side delegation** — the parent agent splits work across
   focused sub-agents: research three angles in parallel, draft three
   implementations and pick one, run a hypothesis-testing loop. The
   sub-agents don't need the parent's full context — they need a
   focused primer and a structured input.

Both cases are served by the same primitive: **a named, registered
sub-task with its own primer, ephemeral memory, and a string handle**
that's invokable identically from the parent's worker code or from
the iframe via a postMessage bridge.

## Shape

Two host functions on the parent agent, one global on the iframe
bridge:

```ts
// Registered as a host fn on the parent agent.
defineTask({
  name?: string;            // explicit; auto-generated if omitted
  primer: string;           // sub-agent's combined system prompt + task framing
  description: string;      // for activity-panel / introspection
  inputs?: string;          // free-form description of input shape
  output?: string;          // free-form description of return shape
  maxIterations?: number;   // sub-task budget (default 10)
}): string;                 // returns the name (string handle)

// Registered as a host fn on the parent agent.
// Also exposed as a global on the iframe bridge (with optional signal).
invokeTask(name: string, args: unknown, opts?: { signal?: AbortSignal }): Promise<unknown>;
```

The handle is **the name string**. That's the only thing that
cleanly survives every boundary (worker↔host serialization,
host↔iframe postMessage). Returning a callable would break at one or
both. The agent uses the same `invokeTask(name, args)` call shape
whether they're testing the sub-task in their own code or writing
app code that invokes it from the iframe.

### Worker-side usage (agent's own action space)

```ts
const pickMove = defineTask({
  name: 'pick-move',
  primer: 'You play tic-tac-toe as O. Choose your next move.\n\n' +
          '# Input\nA 3x3 array with values "X", "O", or null\n\n' +
          '# Output\nCall taskSuccess({x, y}) where each is 0|1|2.',
  description: 'Pick a tic-tac-toe move given a 3x3 board.',
});

// Test it directly — works mid-chat-task because the sub-agent
// runs in its own workerRuntime instance, not the parent's.
const test = await invokeTask(pickMove, { board: emptyBoard });

// Run several in parallel:
const [a, b, c] = await Promise.all([
  invokeTask(defineTask({primer: 'Angle A...', ...}), {topic}),
  invokeTask(defineTask({primer: 'Angle B...', ...}), {topic}),
  invokeTask(defineTask({primer: 'Angle C...', ...}), {topic}),
]);
return synthesize(a, b, c);
```

### Iframe-side usage (embedded in an app)

The agent writes app code that references the name as a literal:

```ts
await fs.writeText('app/index.js', `
  const ac = new AbortController();
  document.querySelector('#stop').onclick = () => ac.abort();
  document.querySelector('#go').onclick = async () => {
    try {
      const move = await invokeTask('pick-move', { board: readBoard() }, { signal: ac.signal });
      applyMove(move);
    } catch (e) {
      showError(\`The AI couldn't decide: \${e.message}\`);
    }
  };
`);
```

The iframe-side `invokeTask` global is a thin postMessage proxy:

```
iframe                          host
──────                          ────
invokeTask(name, args, {signal})
  ↓ postMessage
  → { type: 'invokeTask',       → look up name in registry
      name, args, id }            spawn sub-agent (same path
                                  as the agent-side host fn)
                                  run, get result
  ← postMessage
       result                   ← { type: 'invokeTaskResult',
  ← resolve                          id, result }

(if signal aborts before result arrives)
  ↓ postMessage
  → { type: 'cancelInvokeTask', id }  → call AbortController.abort()
                                         on the sub-agent
```

Same lookup, same spawn path, same sub-agent semantics on both
sides. One implementation on the host, two thin transport surfaces.

## Sub-agent construction

Each `invokeTask` call spawns a fresh sub-Agent and disposes it on
completion. No pooling for v1.

```ts
const subRuntime = workerRuntime({ timeoutMs: 30_000 });
const subAgent = await createAgent({
  name: spec.name,
  primer: spec.primer,
  llm: parentLlm,             // shared instance
  runtime: subRuntime,        // fresh worker per invocation
  state: { type: 'memory' },  // ephemeral, not persisted
  fs: { type: 'memory' },     // ephemeral, isolated from parent
  maxIterations: spec.maxIterations ?? 10,
});

// Curated minimal fn set. No fileWrite-against-parent, no testApp,
// no defineTask recursion, no esbuild — sub-agents are focused
// reasoning workers, not full studio agents.
subAgent.fn(consoleLog, {...});
subAgent.fn(searchFn, {...});
// `cache.get/set` and `fs.*` are auto-wired by agex-ts and operate
// on the sub-agent's own ephemeral state/fs — sub-agent has its
// own private workspace it can stash and read from across its own
// iterations within a single invocation.

const subTask = subAgent.task({ description: spec.description, primer: spec.primer });
const result = await subTask(JSON.stringify(args));
await subAgent.dispose();
return result;
```

### What's shared with the parent

- **`llm` (LLMClient instance)** — pass-through. The interface is a
  black-box request/response; concurrent requests against the same
  client are fine. Cost accounting / API key / model selection
  remain centralized.

### What's not shared

- **`runtime`** — each sub-Agent gets its own `workerRuntime()`.
  This is the key to concurrency: the per-runtime `activeExecute`
  guard means parent and sub-agent can run truly in parallel on
  separate worker threads.
- **`state`** — fresh `memory` config per invocation. No memory
  across invocations of the same sub-task name.
- **`fs`** — fresh `memory` config per invocation. Sub-agent has
  its own private fs but cannot see or write to the parent's VFS.
- **registered fns** — sub-Agent registers a curated minimal set
  (`console.log`, `search`). `cache` and `fs` are auto-wired by
  agex-ts against the sub-agent's own ephemeral state. No
  `fileWrite` against parent fs, no `testApp`/`liveApp`, no
  recursive `defineTask`, no esbuild terminal.
- **studio skills** (`interactive-app.md`, `numerical.md`) — not
  registered on the sub-agent. If a sub-task needs skill content,
  the parent should bake the relevant excerpts directly into
  `defineTask({primer})`.

### Sub-agent always sees the agex-ts BUILTIN_PRIMER

Don't override via `agexPrimerOverride`. The builtin teaches eval
semantics, console capture, `taskSuccess`/`taskFail` shape, cache
class-stripping warning — all things any TS-emitting agent needs.
Total primer overhead ≈ 2K from BUILTIN + whatever the parent wrote
in `defineTask.primer`.

## What `defineTask` returns

The **name string**. Nothing else. Examples:

```ts
const a = defineTask({ name: 'pick-move', ... });   // a === 'pick-move'
const b = defineTask({ primer: '...', ... });       // b === 'subtask:abc123' (auto)
```

The agent already knows the I/O shape and primer — they just passed
them. They don't need them returned. The string is sufficient as a
handle for invocation in either context.

## Concurrency model

- Parent's chat task runs on parent's `workerRuntime` (one worker).
- Each `invokeTask` call spawns a new `workerRuntime` (new worker).
- Workers run on separate JS threads; genuine parallelism.
- `Promise.all([invokeTask(...), invokeTask(...), ...])` wall-clock
  is `max(durations)`, not `sum(durations)`.
- LLM concurrency: shared client makes concurrent requests; bounded
  by Anthropic / OpenRouter per-key concurrent-request limits
  (typically 3–10 in parallel; 50+ likely throttled).
- Worker concurrency: practical browser limit ~50–100 workers; well
  beyond expected sub-agent fan-out.
- **Cancellation:**
  - Parent-initiated invokeTask: inherits parent's AbortSignal.
    Cancelling the chat task aborts in-flight sub-agents the chat
    task spawned.
  - Iframe-initiated invokeTask: independent lifecycle, owns its
    own AbortController. App passes `{signal}` for user-driven
    cancel ("Stop thinking" button). Parent's chat-task signal
    does NOT propagate to iframe-triggered sub-agents.
  - iframe destroyed mid-invocation: sub-agent runs to completion
    on host side, result postMessages to dead iframe and vanishes.
    Wasteful by one call but no leak. No special handling in v1.

## Iteration budget

- **Default `maxIterations: 10`** — matches agex-ts's framework
  default. Catches most legitimate sub-task work.
- **Don't match parent's 40** — sub-agents don't build apps (no
  testApp/liveApp/esbuild loops), they fan out (one parent call
  spawns N sub-agents), and there's no human in the loop to cancel
  a runaway.
- **Per-task override** via `defineTask({maxIterations: N})` —
  research tasks (5–15 iterations) opt in; pure-function tasks
  (1–2 iterations) can opt down for fail-fast.
- **On exhaust** — agex-ts throws `TaskFailError`. Propagates out
  of `invokeTask` as an exception. Parent code can catch and
  retry/fall back; iframe code should always wrap in try/catch
  and surface to the user.

## Lifecycle

- **`defineTask`** — adds entry to in-host registry
  `Map<name, TaskSpec>`. Persists the registry to a single state
  key (see Persistence). Returns the name.
- **`invokeTask`** — looks up the spec, constructs sub-Agent +
  runtime, runs the task, disposes both. Synchronous-from-agent's-
  perspective; the await resolves when the sub-task returns.
- **Sub-agent worker** — torn down after each invocation. No pool.

## Persistence

**Sub-task definitions** are per-branch (each chat branch has its
own subtasks, just like everything else in the studio). Stored as
a single JSON blob under a meta key, following the existing
`META_KEYS` convention:

```ts
// Add to META_KEYS in ts-agent.js:
const META_KEYS = {
  // existing...
  subtasks: "__subtasks__",
};

// Shape stored at __subtasks__:
{
  "pick-move": {
    primer: "...",
    description: "...",
    inputs: "...",
    output: "...",
    maxIterations: 10
  },
  "research-angle-a": { ... }
}
```

`defineTask` reads the current blob, adds/updates the entry, writes
the whole thing back. On `loadHistory`, read the blob and replay
each spec through `defineTask` to rehydrate the in-host registry.

**Why one key vs. one-key-per-spec:** atomic writes, trivial
enumeration via `JSON.parse`, matches the `__session_*__`
convention exactly. Total size for any realistic scale (~tens of
subtasks × few-hundred-byte primers) stays under 10 KB.

**Undo for free:** `defineTask` writes through the standard state
mechanism, so kvgit's `resetTo` reverts the registry alongside
everything else. No special handling.

## Event capture (v1: minimal)

This was the trickiest design call. v1 takes the simplest path that
preserves the chat narrative.

### Parent-initiated invokeTask

When the parent agent calls `await invokeTask(...)` from its own
chat-task code, that delegation IS part of the conversation — the
agent decided to spin up sub-agents during its turn. So:

- Emit a single `subtaskInvocation` event to **parent's
  EventLog**.
- Renders as a one-line chip-style summary in the activity panel
  for that turn.
- **No sidecar capture, no expandable detail.** Sub-agent's full
  event stream is not preserved anywhere.

Event shape:

```ts
{
  type: 'subtaskInvocation',
  name: 'pick-move',
  args: { board: [...] },
  result: { x: 1, y: 1 },
  status: 'success' | 'fail' | 'cancelled',
  error?: string,
  iterations: 3,
  durationMs: 4200,
  timestamp, agentName: 'chat',
}
```

Chip rendering:

```
→ pick-move({ board: [[X,_,O],...] })  [3 iterations · 4.2s] → { x: 1, y: 1 }
```

For `Promise.all` of multiple sub-tasks, multiple chips render in
completion order, all attached to the same parent turn.

### Iframe-initiated invokeTask

When the user clicks something in the embedded app and the app
fires `invokeTask`, that's app runtime — the *user* is interacting
with an artifact, not extending the conversation. So:

- Emit **nothing** to parent's EventLog.
- The round-trip happens, the app does what it does, the chat
  thread is unchanged.
- A user playing 50 rounds of tic-tac-toe doesn't generate 50
  chip-bubbles between two real chat turns.

### What we lose in v1

- Can't debug "why did the sub-agent pick (1,2)?" — only the result
  surfaces. Agent author can mitigate by having the sub-task primer
  return reasoning alongside the answer (e.g. `{x, y, why}`).
- No audit trail for iframe-triggered invocations. Game-style apps
  don't need one; sensitive callbacks might.

These are debug/audit features, not core. v1 ships, real usage
shows what's actually missing, v2 addresses it.

### v2 sketch (requires agex-ts changes)

The clean end-state:

1. **Per-event agent identification** — `EventBase` gains
   `agentName` (already there) plus probably `invocationId` so
   concurrent sub-agent invocations are distinguishable.
2. **agex-ts onEvent relay helper** — built-in plumbing to forward
   sub-agent events to parent log, auto-tagged with sub-agent's
   name + invocation id.
3. **Render-time filtering** — chat-thread renderer, LLM-facing
   conversation builder, and chaptering all opt-in to "show events
   from agent X" or "skip events from non-self agents." Defaults
   stay as today (chat shows only parent's events); audit UI flips
   it for drill-in.
4. **Two-tier UI** — chat thread keeps clean parent narrative;
   new audit view (in activity panel or a new drawer) shows full
   event stream including sub-agents, filterable by agent name +
   invocation id.

Not v1.

## Constraints

- **No memory between sub-task invocations** in v1 (ephemeral
  `state: 'memory'`). Each call is a fresh sub-agent. Future
  options: persistent dedicated session per task name; persistent
  isolated identity via Namespaced-style keyspace prefixing.
- **No fs sharing** in v1. Sub-agent has its own private memory fs.
  Future: read-only overlay over parent's fs; later still,
  sub-agent works on a kvgit branch and "submits a PR" the parent
  can merge or discard.
- **Sub-agent's curated fn set** is hardcoded for v1. Future:
  `defineTask({fns: [...]})` or `{denyFns: [...]}` to customize.
- **Args serialization**: `args` are stringified into the sub-task's
  prompt as JSON. Token cost grows with arg size. Future: bind as
  in-scope variable, requires upstream agex-ts plumbing.

## v1 implementation outline

**Studio (`ts-agent.js`):**
- Add `subtasks` entry to `META_KEYS` (`__subtasks__`).
- `defineTask` host fn — registers in in-host `Map`, updates the
  `__subtasks__` JSON blob, returns name.
- `invokeTask` host fn — looks up, spawns sub-agent + runtime, runs,
  emits `subtaskInvocation` event to parent's EventLog (when called
  from parent's worker), disposes, returns result. Wraps in
  try/catch to surface fail/cancelled status in the event.
- `loadHistory` — read `__subtasks__`, replay each spec through
  `defineTask` to rehydrate the in-host registry.

**Studio (`iframe-bridge.js`):**
- `invokeTask(name, args, opts?)` global on iframe side — postMessage
  proxy. Accepts optional `{signal}` for user-driven cancel.
- Bridge protocol: `{type: 'invokeTask', name, args, id}` →
  `{type: 'invokeTaskResult', id, result}` or
  `{type: 'invokeTaskError', id, error}`.
- Cancellation: `{type: 'cancelInvokeTask', id}` from iframe →
  host calls `.abort()` on the sub-agent's AbortController.
- Iframe-initiated calls do **not** emit events to parent's EventLog.

**Studio (renderer):**
- Recognize `subtaskInvocation` event type in `MessageList` /
  `ActivityPanel` segment switcher.
- Render as one-line chip with name + args summary + iteration
  count + duration + result.
- No expand affordance (no sidecar to expand into).

**Studio (skill doc):**
- New skill explaining when to reach for `defineTask` vs. plain
  functions; the contract for primers, inputs, outputs; cost /
  footgun warnings (autoloop sub-agents, recursion, parallelism
  limits, always wrap iframe `invokeTask` in try/catch).

**No agex-ts changes anticipated for v1.** `createAgent`,
`agent.task`, `workerRuntime`, `LLMClient` interface — all already
support the required shape. Verified against agex-ts source as of
2026-05-13.

## Footguns to surface in the skill

- **Don't autoloop**: `setInterval(() => invokeTask(...))` is a
  runaway LLM bill. App callbacks should fire on user action.
- **Mind parallelism caps**: `Promise.all` of 50 sub-agents will
  hit OpenRouter rate limits and won't actually run all in parallel.
- **Don't reach for sub-agents when a function will do**: an
  `invokeTask` call is a full LLM round-trip. Use plain JS for
  mechanical logic; reserve sub-agents for genuinely judgment-laden
  work.
- **Recursion**: sub-agents can't `defineTask` themselves (host fn
  not registered on the curated sub-set). Recursive sub-agent fanout
  isn't possible in v1 by design.
- **Args go in the prompt**: large args burn tokens. Trim before
  passing.
- **Always tell the sub-agent to use `taskSuccess`**: without
  that hint in the primer, sub-agents sometimes `console.log` the
  answer and never call taskSuccess, hanging until iteration limit.
- **iframe `invokeTask` always needs try/catch**: maxIterations
  exhaustion or sub-agent cancellation surfaces as a thrown error
  in the iframe; without handling, the user clicks the button and
  nothing visible happens.
- **Sub-agent reasoning isn't captured in v1**: if you want to
  understand why a sub-agent picked X, have its primer return
  reasoning alongside the answer (e.g. `{result, why}`).

## Future directions (explicitly not v1)

- **Read-only fs overlay** — sub-agent can read parent's files but
  not write. ~50 lines. Probably v1.5 once first use case demands it.
- **kvgit-branch sub-agents** — sub-agent operates on a fresh
  branch, returns the branch handle, parent (or user) decides to
  merge or discard. PR-review workflow for agent work. Composes well
  with existing branch tooling.
- **Persistent dedicated session per task name** — NPC-with-memory
  use cases. Same agent identity, dedicated session per
  `defineTask` name; memory builds across invocations.
- **Distinct sub-agent identity (separate Agent + Namespaced
  backend)** — restricted fn sets, multi-agent simulations with
  character continuity. Requires porting Namespaced from py kvgit.
- **Worker pool per task name** — if cold-spawn cost becomes
  noticeable in benchmarks.
- **Streaming sub-agent tokens to the iframe** — for game-feel UX.
  Bridge protocol extension. Currently spec'd as "non-streaming
  result only" for v1 simplicity.
- **Per-task fn allowlist** — `defineTask({fns: ['search', 'fs.read']})`
  to customize the sub-agent's capability surface per-task.
- **Full event capture with audit view** — see "v2 sketch" under
  Event capture. Requires agex-ts changes for per-event agent
  identification + onEvent relay helper.

## Decisions log

- **2026-05-13** — chose ephemeral-memory new-Agent (sub-Agent, not
  same-Agent task) as the v1 default. Rejected: same-Agent
  same-session (history pollution, sequential constraint),
  persistent dedicated session (premature for v1), Namespaced-backed
  distinct identity (real but premature complexity).
- **2026-05-13** — confirmed parent and sub-agent run on **separate
  `workerRuntime` instances**, not a shared one. Each `invokeTask`
  spawns a fresh worker. This unlocks genuine parallelism and
  removes the "no `invokeTask` from inside parent's task" constraint.
  No agex-ts changes needed.
- **2026-05-13** — chose **string handle** as `defineTask` return
  type. Symmetric across worker / iframe boundaries; no
  serialization complexity.
- **2026-05-13** — chose **JSON-stringified args in prompt** for v1.
  Optimize later if token cost warrants.
- **2026-05-13** — chose **single-key JSON blob** at
  `__subtasks__` for sub-task definition persistence. Per-branch
  scope. Atomic writes, trivial enumeration, undo via existing
  `resetTo`. Matches `META_KEYS` convention.
- **2026-05-13** — sub-agent's curated fn set is `console.log` +
  `search` (plus auto-wired `cache.get/set` and `fs.*` against the
  sub-agent's own ephemeral state). No studio skills registered;
  parent bakes skill excerpts into `defineTask({primer})` if
  needed. BUILTIN_PRIMER stays default — don't override.
- **2026-05-13** — `maxIterations` default is 10 (matches agex-ts
  framework default). Per-task override via
  `defineTask({maxIterations})`. Sub-tasks don't inherit parent's
  bumped 40 because they don't build apps and they fan out.
- **2026-05-13** — v1 emits a summary `subtaskInvocation` event to
  parent's EventLog only for **parent-initiated** invokeTask calls
  (renders as a one-line chip, no expandable detail). Iframe-
  initiated calls emit nothing — they're app runtime, not part of
  the chat narrative. Sub-agent's full event stream is not captured
  anywhere in v1; "why did the sub-agent do X?" requires the
  sub-task primer to surface reasoning in its return value. v2 will
  add per-event agent identification + sub-agent event relay +
  render-time filtering, enabling a separate audit view without
  polluting the chat thread.
- **2026-05-13** — cancellation: parent-initiated invokeTask
  inherits parent's AbortSignal naturally. Iframe-initiated has
  independent lifecycle; bridge accepts optional `{signal}` for
  app-side cancel ("Stop thinking" buttons). Parent's chat-task
  signal does NOT propagate to iframe-triggered sub-agents.
  iframe destroyed mid-invocation: let it complete, discard result.
