# Sub-agents in agex-studio

Captures the design for letting an agent define and invoke sub-agents
— callable, primed task functions that run in their own isolated
context and can be reached either from the parent's own action space
or embedded in an iframe app.

Status: design only. No code yet. No agex-ts changes anticipated for
v1. Audited 2026-05-30 against agex-ts v0.1.1 and the current studio;
corrections applied inline (see the 2026-05-30 entries in the
Decisions log).

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

// `pickMove` is the NAME STRING ('pick-move'), not a callable —
// defineTask returns the handle string (see "What defineTask
// returns"). invokeTask takes that string. Test it directly — works
// mid-chat-task because the sub-agent runs in its own workerRuntime
// instance, not the parent's.
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

#### This is a NEW message direction — not an extension of the existing bridge

Worth being precise, because it's the thinnest part of this design and
easy to under-scope. The existing iframe bridge (`iframe-bridge.js`)
is **entirely host-driven**: the host posts `agex-control` actions
(click/type/eval/screenshot) and the iframe *responds* with
`agex-control-result`. The iframe never *initiates* a message today,
and the parent has no standing listener for one — `sendControl`
attaches only a temporary per-request handler. There is also no
existing precedent for an injected iframe-side global; nothing exposes
a host-proxying function to app code today.

So iframe-side `invokeTask` is the inverse direction and requires
three genuinely new pieces, not a copy of an existing one:

1. **A standing parent-side listener** for iframe-initiated
   `invokeTask` messages (the current model has none — every existing
   listener is request-scoped and torn down on response).
2. **Origin validation on the parent side** — the mirror of the
   iframe's `__AGEX_PARENT_ORIGIN` check. The apps iframe is
   cross-origin (apps-host / esm); the host must validate the origin
   of inbound `invokeTask` messages and ignore anything not from the
   expected app frame. Without this, any frame that can post to the
   window could spend the user's tokens.
3. **An injected iframe-side global** (`invokeTask`), installed via
   the bootloader / `AGENT_CONTROL_BRIDGE_SCRIPT` path alongside
   `installControlBridge`. This injection pattern does not exist yet.

#### Trust / cost boundary (iframe-initiated calls)

Iframe-initiated `invokeTask` lets a **sandboxed, cross-origin,
possibly imported** app drive real LLM spend on the host. Apps are
shareable (see `gist-publish.js`), so "the app is trusted because the
agent wrote it" does not hold for imported sessions. This is a
trust-boundary decision, not just a user-education footgun. v1 should
pick at least one concrete guard and state it:

- a per-session spend/invocation cap on iframe-initiated calls, and/or
- a confirm-on-first-invoke prompt for imported (non-author) sessions,
  and/or
- a visible "this app is making AI calls" indicator while in flight.

The "don't autoloop" footgun below covers the author's own mistakes;
this covers the case where the app's author is not the person running
it.

## Sub-agent construction

Each `invokeTask` call spawns a fresh sub-Agent and disposes it on
completion. No pooling for v1.

```ts
const subRuntime = workerRuntime({
  workerUrl: agexWorkerUrl,   // same vite-bundled URL the chat agent uses
  timeoutMs: 30_000,
});
const subAgent = await createAgent({
  name: spec.name,
  primer: spec.primer,        // agent-level primer; the task below adds
                              // only a description (don't pass primer twice)
  llm: parentLlm,             // shared instance
  runtime: subRuntime,        // fresh worker per invocation
  state: { type: 'live' },    // ephemeral in-process map, not persisted.
                              // NB: `{ type: 'memory' }` is NOT a valid
                              // StateConfig — `live` is the ephemeral one.
  fs: { type: 'memory' },     // ephemeral, isolated from parent
  maxIterations: spec.maxIterations ?? 10,
});

// Curated minimal fn set. No fileWrite-against-parent, no testApp,
// no defineTask recursion, no esbuild — sub-agents are focused
// reasoning workers, not full studio agents.
subAgent.fn(searchFn, {...});
// `console`, `cache.get/set`, and `fs.*` are auto-injected by the
// worker runtime — they are NOT registered host fns. `console`
// captures stdout; `cache` and `fs` operate on the sub-agent's own
// ephemeral state/fs, giving it a private workspace it can stash and
// read from across its own iterations within a single invocation. So
// the only host fn the sub-agent actually registers is `search`.

const subTask = subAgent.task({ description: spec.description });
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
- **`state`** — fresh `{ type: 'live' }` config per invocation (the
  ephemeral in-process map; `memory` is not a valid `StateConfig`).
  No memory across invocations of the same sub-task name.
- **`fs`** — fresh `{ type: 'memory' }` config per invocation.
  Sub-agent has its own private fs but cannot see or write to the
  parent's VFS.
- **registered fns** — sub-Agent registers exactly one host fn:
  `search`. `console`, `cache`, and `fs` are auto-injected by the
  worker runtime (not registered) and operate on the sub-agent's own
  ephemeral state. No `fileWrite` against parent fs, no
  `testApp`/`liveApp`, no recursive `defineTask`, no esbuild terminal.
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
- **Don't match parent's 40 by default** — sub-agents don't build apps
  (no testApp/liveApp/esbuild loops), they fan out (one parent call
  spawns N sub-agents), and there's no human in the loop to cancel
  a runaway.
- **Per-task override** via `defineTask({maxIterations: N})` —
  research tasks (5–15 iterations) opt in; pure-function tasks
  (1–2 iterations) can opt down for fail-fast.
- **Opt-in inheritance** via `defineTask({maxIterations: 'inherit'})`
  — resolves to the parent agent's current cap at invoke time (so a
  deliberately deep sub-task can match the chat agent's budget without
  hardcoding the number or going stale if the parent's cap changes).
  Stored as the sentinel, resolved per-invocation.
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

> **Corrected 2026-05-30.** The original plan emitted a custom
> `subtaskInvocation` event *into the parent's agex-ts EventLog* and
> rehydrated it via `loadHistory`. The audit found that `AgentEvent`
> is a **closed 10-member union** and `EventLog.add(event: AgentEvent)`
> is typed to it — `subtaskInvocation` is not a member. It happens to
> *work at runtime* only because (a) the studio is JS, so `add()`
> doesn't reject the foreign type at compile time, and (b) every place
> agex-ts iterates events (`render/index.ts`, `chaptering.ts`,
> `chapters-overlay.ts`) falls through to a no-op `default`
> (`const exhaustive: never = e`) on unknown types. That is undocumented
> tolerance, not a contract: a future agex-ts that adds a runtime guard
> to `add()` or flips a `default` to throw would silently break studio
> sessions. So v1 does **not** put a foreign event type in the log.
> See the two options below; v1 uses Option A.

### Parent-initiated invokeTask

When the parent agent calls `await invokeTask(...)` from its own
chat-task code, that delegation IS part of the conversation — the
agent decided to spin up sub-agents during its turn. The agent itself
already sees the result (it's the return value of its own `await`, in
its execution output); the chip is a **UI affordance for the human**
in the activity panel, and should NOT add tokens to the LLM
conversation. Two ways to record it without a foreign event type:

**Option A (v1) — studio-state record, decoupled from agex-ts.**
Append an invocation record to a studio-state list under a `META_KEYS`
entry (`__subtask_invocations__`), written through the same state
mechanism as the `__subtasks__` registry:

```ts
// appended to the list at __subtask_invocations__
{
  name: 'pick-move',
  args: { board: [...] },
  result: { x: 1, y: 1 },
  status: 'success' | 'fail' | 'cancelled',
  error?: string,
  iterations: 3,
  durationMs: 4200,
  timestamp,            // ISO; used by loadHistory to interleave chips
  agentName: 'chat',
}
```

`loadHistory` reads this list and interleaves chips into the chat
narrative by `timestamp`, relative to the surrounding `action`
events it already walks. This is fully decoupled from agex-ts's event
union (robust against future tightening), **invisible to the LLM
conversation** (zero token cost, no double-surfacing of a result the
agent already has), and gets **undo-for-free** via kvgit `resetTo` —
identical to the `__subtasks__` registry, because it's the same state
substrate. Cost: `loadHistory` needs interleave-by-timestamp logic
rather than reading position straight from the log.

**Option B (fallback) — ride on `SystemNoteEvent`.** If the
interleave logic proves fiddly, encode the chip payload in the
`message` of a `SystemNoteEvent` (`{ type: 'systemNote', message }`),
a sanctioned union member that's already ordered in the log and
rendered everywhere. Studio's renderer recognizes a sentinel prefix
and draws a chip instead of a plain note. Tradeoff: `systemNote`
*does* render into the LLM conversation (`render/index.ts` handles it
as a first-class type), so it costs a line of context per invocation
and re-surfaces a result the agent already had. Acceptable if terse,
but Option A is cleaner.

Chip rendering (either option):

```
→ pick-move({ board: [[X,_,O],...] })  [3 iterations · 4.2s] → { x: 1, y: 1 }
```

For `Promise.all` of multiple sub-tasks, multiple chips render in
completion order, all attached to the same parent turn.

**Live rendering (added 2026-05-30).** Chips don't wait for a reload.
The manager fires start/complete callbacks for parent-initiated calls;
`chatMessage` installs a per-turn sink that streams them to the chat
shell as a `subtask` token. A chip appears **"running…"** the moment a
sub-task is invoked (before the sub-agent even spawns) and resolves to
its result/status on completion — so a multi-second fan-out shows
progress instead of the parent appearing to hang. Two paths keep the
chip consistent: the live path (a per-action `pendingSubtaskChips`
buffer committed after the action's snapshot) for the in-flight turn,
and the final-events path (the adapter pushes the completed chip into
`response.events` between the action and its output) for the committed
message and post-reload `loadHistory`. Iframe-initiated calls fire no
callbacks — they're app runtime, not chat narrative.

### Iframe-initiated invokeTask

When the user clicks something in the embedded app and the app
fires `invokeTask`, that's app runtime — the *user* is interacting
with an artifact, not extending the conversation. So:

- Record **nothing** — no `__subtask_invocations__` entry, no chip.
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
- Add `subtasks` and `subtaskInvocations` entries to `META_KEYS`
  (`__subtasks__`, `__subtask_invocations__`).
- Expose the parent's LLM client for reuse. `_buildLlmClient` is
  module-private today; either cache the built instance at
  `initAgent` time (like `_agent`) and hand it to sub-agents, or
  export it. Do NOT re-call `_buildLlmClient(settings)` per
  invocation — it would re-read current settings and a mid-flight
  model/key change would silently apply to the sub-agent.
- `defineTask` host fn — registers in in-host `Map`, updates the
  `__subtasks__` JSON blob, returns name.
- `invokeTask` host fn — looks up, spawns sub-agent + runtime (reuse
  the same `agexWorkerUrl` the chat agent uses), runs, **appends an
  invocation record to `__subtask_invocations__`** (when called from
  parent's worker; see Event capture, Option A), disposes, returns
  result. Wraps in try/catch to surface fail/cancelled status in the
  record. No foreign event type goes into the agex-ts EventLog.
- `loadHistory` — read `__subtasks__`, replay each spec through
  `defineTask` to rehydrate the in-host registry; read
  `__subtask_invocations__` and interleave chips into the narrative
  by `timestamp`.

**Studio (`iframe-bridge.js`):** (note: this adds a *new message
direction* — iframe→host initiation — not covered by today's
host-driven `agex-control`/`sendControl` flow; see "This is a NEW
message direction" above.)
- `invokeTask(name, args, opts?)` global on iframe side — postMessage
  proxy. Accepts optional `{signal}` for user-driven cancel. Must be
  **injected** into the app scope via the bootloader /
  `AGENT_CONTROL_BRIDGE_SCRIPT` path (no iframe-side global exists
  today — new injection point).
- **Standing parent-side listener** for iframe-initiated messages.
  The existing parent code only attaches temporary per-request
  handlers (`sendControl`); `invokeTask` needs a persistent listener
  registered when the app frame mounts.
- **Origin validation on the parent listener** — mirror of the
  iframe's `__AGEX_PARENT_ORIGIN` check. Reject `invokeTask` messages
  whose `event.origin` / `event.source` isn't the expected app frame,
  so a stray frame can't spend the user's tokens.
- Apply the iframe-initiated **trust/cost guard** chosen above (spend
  cap / confirm-on-import / in-flight indicator).
- Bridge protocol: `{type: 'invokeTask', name, args, id}` →
  `{type: 'invokeTaskResult', id, result}` or
  `{type: 'invokeTaskError', id, error}`.
- Cancellation: `{type: 'cancelInvokeTask', id}` from iframe →
  host calls `.abort()` on the sub-agent's AbortController.
- Iframe-initiated calls do **not** record invocations (no chip, no
  state write) — they're app runtime, not chat narrative.

**Studio (renderer):**
- Render invocation records (from `__subtask_invocations__`, surfaced
  by `loadHistory`) as one-line chips in `MessageList` /
  `ActivityPanel` — name + args summary + iteration count + duration +
  result. These are studio-side records, not agex-ts events, so no
  new branch is needed in the agex-ts event-type switch; the chip is a
  new render path keyed off the interleaved record.
- No expand affordance (no sidecar to expand into).

**Studio (skill doc):**
- New skill explaining when to reach for `defineTask` vs. plain
  functions; the contract for primers, inputs, outputs; cost /
  footgun warnings (autoloop sub-agents, recursion, parallelism
  limits, always wrap iframe `invokeTask` in try/catch).

**No agex-ts changes anticipated for v1.** `createAgent`,
`agent.task`, `workerRuntime`, `LLMClient` interface — all already
support the required shape. Verified against agex-ts source as of
2026-05-13; **re-audited 2026-05-30 against v0.1.1.** The re-audit
confirmed: `createAgent` options (`name/primer/llm/runtime/state/fs/
maxIterations`), per-task `primer`, `TaskCallOptions.signal`,
`workerRuntime({ workerUrl, timeoutMs })`, `agent.dispose()` →
`runtime.dispose()`, default `maxIterations` of 10, auto-injected
`console`/`cache`/`fs`, the stateless `LLMClient` (safe to share), the
per-runtime `activeExecute` guard (separate runtimes ⇒ real
parallelism), and `TaskFailError` on exhaustion. Two corrections fell
out (both studio-side, neither an agex-ts change): the sub-agent
`state` config must be `{ type: 'live' }` (not `'memory'`), and the
event-capture path must not write a foreign event type into the
agex-ts EventLog (see Event capture).

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
- **2026-05-13** *(superseded 2026-05-30 — see below)* — v1 emits a
  summary `subtaskInvocation` event to
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
- **2026-05-30** — re-audited the whole design against agex-ts v0.1.1
  and the current studio. Core architecture (fresh sub-Agent per
  invoke, own `workerRuntime`, shared stateless `llm`, string handle,
  `dispose()` lifecycle, `__subtasks__` persistence, default
  `maxIterations` 10, per-runtime `activeExecute` ⇒ real parallelism)
  all verified against real code. "No agex-ts changes for v1" holds.
- **2026-05-30** — corrected the sub-agent `state` config:
  `{ type: 'memory' }` is not a valid `StateConfig`. The ephemeral
  option is `{ type: 'live' }` (in-process map); `memory` is valid
  only for `fs` and for `versioned`'s `storage`. Also clarified that
  `console`/`cache`/`fs` are auto-injected by the worker (not
  registered host fns), so the sub-agent's only registered host fn is
  `search`; and dropped the duplicated `primer` (set on `createAgent`,
  not also on the task).
- **2026-05-30** — **superseded the event-capture decision.** Do NOT
  emit a custom `subtaskInvocation` event into the agex-ts EventLog:
  `AgentEvent` is a closed union and `EventLog.add` is typed to it; it
  works at runtime only by JS bypassing the type and agex-ts no-op'ing
  unknown event types everywhere (undocumented, not a contract).
  Instead, v1 stores invocation records in studio state under
  `__subtask_invocations__` (Option A) and interleaves chips by
  timestamp in `loadHistory` — decoupled from agex-ts, invisible to
  the LLM, undo-for-free. `SystemNoteEvent` is the fallback (Option B)
  if interleave logic proves fiddly, at the cost of LLM-context tokens.
- **2026-05-30** — chips render **live** during the turn, not only on
  reload. The original v1 surfaced chips solely via `loadHistory` (the
  live UI is driven by the parent task's agex-ts event/token stream,
  which has no sub-task records). Added a per-turn live sink: the
  manager fires invocation start/complete callbacks → `chatMessage`
  forwards them as a `subtask` token → the shell renders a
  "running → done" chip. The completed chip is also pushed into the
  turn's `response.events` (between its action and output) so the
  committed message and reload match. Needs no agex-ts changes — the
  events were already available host-side via the task's `onEvent`.
  (Sub-agent *token* streaming and full event-stream capture remain
  deferred; this is chip-granularity progress only.)
- **2026-05-30** — added `maxIterations: 'inherit'` as an opt-in: a
  sub-task can resolve to the parent agent's current cap at invoke
  time. Default stays 10 (the fan-out rationale holds); inheritance is
  an explicit choice for deliberately deep sub-tasks, not the default.
- **2026-05-30** — chips interleave by timestamp into the turn's
  activity card (after the action that spawned each), not dumped at the
  turn's end. Relies on agex-ts stamping `ActionEvent` at emit time and
  the terminal/output events after dispatch, so
  `action.ts < invocation.ts < output.ts` holds; `loadHistory` drains
  pending chips at the start of each action/output branch plus a
  finalize catch-all.
- **2026-05-30** — flagged iframe-side `invokeTask` as a **new message
  direction**, not an extension of the host-driven `agex-control`
  bridge. v1 must add a standing parent-side listener, parent-side
  origin validation (mirror of `__AGEX_PARENT_ORIGIN`), and an
  injected iframe-side global — none of which exist today. Added a
  trust/cost boundary requirement: a sandboxed, possibly *imported*
  app can drive real LLM spend, so v1 must pick a guard (spend cap /
  confirm-on-import / in-flight indicator), not just rely on the
  "don't autoloop" footgun.
