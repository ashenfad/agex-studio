# Mid-session policy grants for agex-ts (v2)

**Status:** Draft proposal, refined from v1 after upstream
discussion in agex-ts.

**Audience:** agex-ts maintainers, agex-studio integration agent, and
consumers thinking about runtime capability expansion.

**TL;DR:** Today's `agent.namespace` / `agent.fn` / etc. registrations
are construction-time only — they build the system message and stay
fixed for the agent's lifetime. We propose adding a session-time
grant mechanism so the effective policy can grow over the course of a
session without busting the prompt cache. The agent gets a first-
class `request_capability` tool emission (parallel to `ts_action` /
`terminal_action`); the host gets an `agent.policy.grant/revoke` API
and an `onCapabilityRequest` callback for inline-await orchestration.
We also kill `taskClarify` outright — it never had a real resume
protocol, and its use cases now decompose cleanly into `taskFail` /
`taskSuccess` / structured tool calls.

**Changes from v1:**

1. **Render as tool_use / tool_result, not "system-style inline
   message."** Capability requests are turn-level emissions, exactly
   the shape every existing tool uses. This sidesteps the v1 question
   about per-provider mid-conversation system-message caching — the
   tool-use pattern caches identically across Anthropic / OpenAI /
   Gemini because it's the same shape every conversation already
   uses.
2. **`request_capability` is a first-class agent emission**, parallel
   to `ts_action` / `terminal_action`. v1 had it bundled with
   `taskSuccess` via a `ResourceRequest` payload, which was awkward
   (forced the agent to terminate the task to ask for something).
3. **Kill `taskClarify`** — terminator set collapses to
   `taskSuccess` + `taskFail`. v1 kept it; we now think it was
   structurally limbo (terminator without a resume protocol). Use
   cases sort cleanly to existing primitives.
4. **Framework primitives vs embedder primitives.** Only capabilities
   that tie to *framework state* (the policy machinery) get
   first-class primitives. Clarification, credentials, "ask the
   user" — those are embedder-registered host fns, not framework
   concerns.
5. **Built-in kinds first; extension kinds (`kind: string` +
   `data`) deferred to v1.1.** Keeps the v1 type-system gymnastics
   out of the initial scope.

---

## Motivation

### The product use case

An interactive agent realizes mid-session that it needs a library
or capability the user hadn't pre-approved. Today the agent has to
`taskFail` and the user has to restart the session with a wider
policy. The desired flow:

1. Agent emits a `request_capability` turn — "I'd benefit from
   `d3` for the force-directed graph you asked for; here's why."
2. User sees an approval card in the chat shell, clicks approve.
3. Studio's `onCapabilityRequest` returns `{ approved: true, entry: ... }`.
4. agex-ts appends a `PolicyGrantEvent`, the tool result tells the
   agent the grant succeeded, and the agent's next emission has
   `import * as d3 from 'd3'` available.

The studio can build the UX (approval modal, settings overrides,
bundle-import re-prompt) entirely on its own, but the underlying
ability to **add to the agent's policy mid-session** has to come
from agex-ts. And it has to come in a specific shape, because of
the prompt-cache problem.

### Why this can't be a thin wrapper around `_agent.namespace(...)`

`Agent.namespace(...)` (and the other registration methods) mutate
the policy `Map` directly. Today's renderer renders the entire
policy into the system message. If the studio called
`_agent.namespace(...)` mid-session in response to a user
approval, the next request's system message would contain the new
namespace.

For Anthropic's, OpenAI's, and Gemini's prompt caches, the system
message + leading conversation prefix is the thickest cache layer.
Any byte change anywhere in the cached prefix invalidates
everything downstream. For a 50-turn / 50K-token chat session, a
single grant that re-renders the system message turns the next
request from a ~5% cache-hit cost into a 100% recomputation.
Multiply by several grants and the cache is dead.

The constraint is sharp: **policy that grows mid-session must ride
in the conversation as append-only events, not as system-message
edits.** The system message is rendered once at the policy
snapshot taken at agent construction and stays static. Anything
added later lives downstream in the event log.

### Why cache preservation is automatic with the tool-use shape

Prompt caching is prefix-based: bytes 0..N are the cached prefix,
and the cache stays valid as long as those bytes don't change. The
proposal mutates neither the system message nor any prior turn —
new content appears only at the end of the conversation. Every
existing conversation already grows by appending turns (most of
which are tool exchanges); the cache handles that natively. A
capability-request turn pair (assistant tool_use + user tool_result)
is just another tool exchange. No per-provider rendering
investigation needed.

### Why this generalizes beyond namespaces

Once the event-based grant infrastructure exists, the same
machinery covers any capability a session can accumulate over
time:

- **Built-in kinds** (`namespace`, `fn`, `cls`, `skill`,
  `terminal`) — agex-ts knows the data shape AND wires the
  granted entity into the interpreter. These are v1 scope.
- **Extension kinds** (`fetch-origin`, `iteration-budget`,
  `file-scope`, `tool`) — agex-ts stores + renders + makes
  queryable, but doesn't interpret. Host enforces semantics at
  call time. Deferred to v1.1 when there's a second driver.

This v2 focuses on built-in kinds. Adding extension kinds later is
purely additive.

---

## Design overview

Three concepts:

1. **Base policy.** Declared at agent construction via the
   existing methods (or the new generic `agent.policy.declare(...)`).
   Builds the system message, never produces events, never changes
   for the agent's lifetime. This is the agent's "always-on"
   capability set. Frozen after the first task starts.

2. **Session-time grants and revokes.** `PolicyGrantEvent` and
   `PolicyRevokeEvent` events appended to the session log via
   `agent.policy.grant(...)` / `.revoke(...)` (host-initiated) or
   via the agent's `request_capability` tool emission (agent-
   initiated, gated by the host's `onCapabilityRequest`
   callback). Render inline in the LLM context at their turn
   position. Cache-preserving by construction.

3. **Effective policy at point P.** A function of base policy + all
   `PolicyGrantEvent`s up to point P minus all `PolicyRevokeEvent`s
   up to point P. Used by:
   - The interpreter, when looking up a name.
   - The renderer, when assembling LLM context.
   - The `onCapabilityRequest` callback, when deciding whether a
     request is already covered.

### Two paths

**Agent-initiated (the common path).** Agent emits
`request_capability` → host's `onCapabilityRequest` handler fires
inline → handler returns approve/deny → if approved, runtime
appends a `PolicyGrantEvent` and the tool_result tells the agent
"granted" → agent's next turn has the capability. If no handler
or denied, tool_result tells the agent "denied" with a reason; the
agent decides whether to pivot or fail.

**Host-initiated (the settings path).** User toggles "allow d3"
in a settings UI without the agent having asked. Studio calls
`await agent.policy.grant(entry, { session })`. Runtime appends a
`PolicyGrantEvent` directly; it renders as a user-role event in
the next request's context. Agent picks up the grant on their
next emission.

Both paths produce the same event type and go through the same
effective-policy machinery. The difference is who initiated.

### What does NOT change

- Existing `agent.namespace` / `agent.fn` / `agent.cls` /
  `agent.skill` / `agent.terminal` keep their signatures.
  Internally they become sugar over `agent.policy.declare(...)`.
- The system message is still rendered from the base policy. No
  caching surprise for existing callers.
- `taskSuccess` and `taskFail` keep their semantics unchanged.
- The interpreter's name-lookup behaviour is unchanged for code
  that doesn't use session-time grants.

### What is new

- A `PolicyEntry` shape for the five built-in kinds.
- `agent.policy.declare(entry)` (sugar; existing methods stay).
- `agent.policy.grant(entry, { session })` / `.revoke({kind, name}, { session })`.
- `request_capability` as a first-class agent emission type.
- `onCapabilityRequest` callback in `TaskCallOptions`.
- Two new event types: `PolicyGrantEvent`, `PolicyRevokeEvent`.
- Renderer logic that splits "construction-time policy → system
  message" from "session-time grants → inline turn messages."
- Side-effect chain that wires/unwires granted entities into the
  interpreter on grant/revoke (and on branch switch).

### What is removed

- `taskClarify` terminator.
- `TaskClarifyError`.
- `ClarifyEvent` event type.
- The `clarify` arm in `task.ts` and chaptering's boundary check.
- The terminator-trio teaching in `builtin-primer.ts` (collapses
  to two terminators).

---

## Killing `taskClarify`

The agex-py inheritance left us three terminators (`taskSuccess`,
`taskFail`, `taskClarify`), but in practice `taskClarify` is
semantic limbo:

- It ends the task, which means the typed function rejects.
- But it implies "the caller will resume with the answer," and
  agex-ts never defined a resume protocol — every embedder
  invents ad-hoc string-concat plumbing to thread the
  clarification back through the next task call.
- The agent's primer has to teach a subtle distinction between
  `fail` ("impossible") and `clarify` ("blocked, might continue").
  Agents conflate them at emission time.

Every legit use of `taskClarify` decomposes cleanly:

| What the agent wants | v2 mechanism |
|---|---|
| "Which option did you mean?" | Embedder-registered `askUser` host fn |
| "I need credentials for service X" | Embedder-registered `getCredential` host fn (or `request_capability` if credentials are modeled as policy entries) |
| "Should I overwrite F?" | Embedder-registered `confirmAction` host fn |
| "I can't make progress, you decide" | `taskFail` with a clear message |
| "I did what I could, here's a partial result" | `taskSuccess` with a typed shape that signals partial |
| "I need a library I don't have" | `request_capability` (this proposal) |

The principle: **anything the framework's machinery doesn't
participate in stays an embedder concern via `agent.fn`.** The
framework only adds primitives when there's framework state to
manage (policy, in this case). Clarification, credentials,
confirmations — none of those touch framework state, so they don't
need framework primitives.

Net surface reduction: two terminators (`taskSuccess` /
`taskFail`), one new emission type (`request_capability`).
Simpler conceptual model, fewer ways for the agent to misuse the
terminator channel, no phantom "resume protocol" to document.

The migration is a primer rewrite plus removal of the
`ClarifyEvent` rendering path. Pre-1.0 callers using
`TaskClarifyError` need to update (small surface; agex-ts itself
is pre-1.0).

---

## API surface

### Construction-time

Existing methods keep working unchanged (no breaking change):

```ts
agent.namespace({ url: 'https://esm.sh/d3' }, { name: 'd3' })
agent.fn(myHandler, { name: 'compute', description: '...' })
agent.cls(MyClass, { name: 'Frobber' })
agent.skill(skillMd, { name: 'my-skill' })
agent.terminal(myCommand, { name: 'mycmd', description: '...' })
```

A generic `declare` is added for symmetry with `grant`:

```ts
agent.policy.declare({ kind: 'namespace', name: 'd3', url: 'https://esm.sh/d3' })
```

After the first `task(...)` call, all of the above throw
`BasePolicyFrozenError`. The cache-preservation invariant requires
the system message to be byte-stable for the agent's lifetime;
freezing the base policy makes this explicit.

### `PolicyEntry` (built-in kinds only for v1)

A discriminated union over the five built-in kinds:

```ts
type PolicyEntry =
  | { kind: 'namespace'; name: string;
      // Mirrors agent.namespace's URL-shipped shape.
      url?: string; export?: string;
      // Host-bound shape (target) isn't supported for session-time
      // grants — the target value can't survive a session resume
      // from kvgit. URL-shipped only.
    }
  | { kind: 'fn'; name: string; description: string;
      handler: HostFnHandler;
      wantsContext?: boolean
    }
  | { kind: 'cls'; name: string; cls: HostClass }
  | { kind: 'skill'; name: string; content: string }
  | { kind: 'terminal'; name: string; description: string;
      handler: TerminalCommandHandler;
      hostFsAccess?: boolean;
      networkAccess?: boolean
    }
```

`fn` / `cls` / `terminal` carry live JS references (handler /
class). Those can't survive session-resume on their own — but the
*declaration* survives via the event log; the host re-registers
the handler at session boot if it wants the granted fn to persist.
Same lifecycle as a host fn registered at construction. For
namespace and skill, the entry is fully serializable (URL,
markdown string) and survives resume natively.

### Session-time API (host)

```ts
// Append a PolicyGrantEvent. Effective from the next emission forward.
await agent.policy.grant(
  { kind: 'namespace', name: 'd3', url: 'https://esm.sh/d3' },
  { session },
)

// Append a PolicyRevokeEvent. Effective from next emission.
await agent.policy.revoke(
  { kind: 'namespace', name: 'd3' },
  { session },
)
```

Both:

- Accept a `session` option (matches the rest of the per-session
  agent API: `agent.fs(session)`, `agent.events(session)`).
- Append the event to that session's log.
- For built-in kinds, also wire/unwire the entity in the
  interpreter for that session.

### Conflict rules

- **Grant a name already in base policy of the same kind:** throw
  at grant time. Base policy is the agent's identity; session-time
  can extend, not shadow.
- **Grant a name already in a previous (un-revoked) session-time
  grant of the same kind:** idempotent if the entry is identical,
  throw if it differs.
- **Revoke a name that's only in base policy:** throw. Base policy
  isn't revocable session-time; that's an identity change.
- **Revoke a name that isn't currently granted:** no-op.

### Agent-initiated path: the `request_capability` emission

`request_capability` is a new top-level emission type, parallel to
`ts_action` / `terminal_action` / `write_file` / `edit_file`. The
agent emits it in a turn where they decide they need something:

```ts
// What the agent emits (tool_use, in LLM-provider terms):
{
  type: 'request_capability',
  kind: 'namespace',
  name: 'd3',
  reason: 'For the force-directed graph the user asked for.',
  suggested: { url: 'https://esm.sh/d3' }, // optional draft entry
}
```

The runtime routes it to the host's `onCapabilityRequest` handler
(see below). The handler's response becomes a tool_result in the
agent's next turn — same wire shape as any tool exchange, so it
caches identically.

### Caller surface: `onCapabilityRequest`

Embedders supply a handler in `TaskCallOptions`:

```ts
interface TaskCallOptions {
  readonly session?: string
  readonly signal?: AbortSignal
  readonly onEvent?: (e: AgentEvent) => void | Promise<void>
  readonly onCapabilityRequest?: (
    req: CapabilityRequest,
    ctx: { session: string },
  ) => CapabilityResponse | Promise<CapabilityResponse>
}

interface CapabilityRequest {
  readonly kind: 'namespace' | 'fn' | 'cls' | 'skill' | 'terminal'
  readonly name: string
  readonly reason?: string                       // agent-supplied
  readonly suggested?: Record<string, unknown>    // agent's draft entry
}

type CapabilityResponse =
  | { readonly approved: true; readonly entry: PolicyEntry }
  | { readonly approved: false; readonly reason?: string }
```

**Default behavior (no handler): deny.** Agent sees a denial in
their tool_result and decides whether to pivot or `taskFail`. The
task fn does not pause, reject, or otherwise change shape.

**With handler:** runtime awaits the handler, then either appends
a `PolicyGrantEvent` (approved) or surfaces the denial to the
agent (denied). Either way, task continues — the typed function
still resolves/rejects normally on `taskSuccess` / `taskFail`.

#### Three call sites

**Script — auto-allowlist:**

```ts
await summarize(data, {
  onCapabilityRequest: (req) =>
    req.kind === 'namespace' && allowedLibs.has(req.name)
      ? { approved: true,
          entry: { kind: 'namespace', name: req.name, url: `https://esm.sh/${req.name}` } }
      : { approved: false, reason: 'not in allowlist' },
})
```

**Interactive (studio) — async, awaits a user click:**

```ts
await summarize(data, {
  onCapabilityRequest: async (req) => {
    const decision = await showApprovalModal(req)   // awaits the click
    return decision.approved
      ? { approved: true, entry: decision.entry }
      : { approved: false, reason: decision.reason }
  },
})
```

**No handler — agent sees denial, decides:**

```ts
await summarize(data)
// Agent's request_capability returns { approved: false } automatically.
// Agent either pivots or taskFails.
```

The `onCapabilityRequest` callback can be async — the task fn
awaits it. This works for interactive UIs (user takes seconds)
but pins the runtime open during the await; not appropriate for
long-running async approval workflows. For those, the embedder
can return `{ approved: false }` immediately and orchestrate the
approval out-of-band, then call `agent.policy.grant` separately.

---

## Rendering and cache preservation

### System message — built from base policy only

The renderer walks the base policy and emits the registration
section verbatim — same as today. Session-time grants and revokes
do not appear in the system message. The system message is
byte-identical across every request for the agent's lifetime.

### Inline grant rendering — tool-use shape

For agent-initiated grants:

```
[turn 47 — assistant emission: request_capability { kind, name, ... }]
[turn 47 — tool_result: { approved: true, entry: { ... } }]
[turn 48 — assistant emission: ts_action using the granted capability]
```

The tool_use / tool_result pair caches the same way as every
other tool exchange (host fn calls, terminal commands, file ops).
No special wire-format handling needed; the LLM-provider adapters
already know how to round-trip tool exchanges.

For host-initiated grants:

```
[turn 47 — user-role event: "Capability granted: import * as d3 from 'd3' is now available."]
[turn 48 — assistant emission: can use d3]
```

This is the one case where the rendering shape differs — there's
no preceding `tool_use` to pair with, so the grant rides as a
standalone user-role event. The auto-generated text follows the
v1 table:

| Kind        | Auto-generated text |
|-------------|---------------------|
| `namespace` | `Capability granted: \`import * as <name> from '<name>'\` is now available (resolves to <url>).` |
| `fn`        | `Capability granted: host function \`<name>\` is now callable. <description>` |
| `cls`       | `Capability granted: host class \`<name>\` is now constructable.` |
| `skill`     | `Capability granted: skill is now mounted at \`/skills/<name>/SKILL.md\` (cat to read).` |
| `terminal`  | `Capability granted: shell command \`<name>\` is now available. <description>` |

A `PolicyRevokeEvent` renders symmetrically: "Capability revoked:
`<name>` is no longer available."

### Cache cost analysis

For a typical session with N turns and K mid-session grants:

- **Without this feature** (today: studio re-registers via
  `_agent.namespace`, system message changes): each grant busts
  the entire prompt cache. K grants → K full recomputations.

- **With this feature**: each grant adds a single turn (or
  tool_use/tool_result pair) at its position in the event log.
  The cache prefix is preserved; subsequent turns pay only the
  incremental cost. ~99% reduction in grant-induced cache miss
  for typical sessions.

The 99% number is structural (it's the difference between
appending content and mutating it). It doesn't depend on
per-provider rendering quirks.

---

## Side-effect chain — the hard part

When a `PolicyGrantEvent` lands (whether from the agent's
`request_capability` path or the host's direct `policy.grant`),
the runtime has to do more than append to the log. For built-in
kinds, the granted entity has to be live in the interpreter so the
agent's next emission can actually use it.

The side-effect chain by kind:

- **`namespace`** (URL-shipped only at session-time): register
  the URL spec in the runtime's lazy-import table; the worker /
  in-process eval picks it up via `__load(name)` on first
  reference. No upfront network hit.
- **`fn`**: register the handler in the runtime's host-fn table.
  Subsequent agent calls dispatch normally.
- **`cls`**: register the class in the runtime's class table.
  Same as `fn`.
- **`skill`**: append to the skills overlay so
  `/skills/<name>/SKILL.md` resolves on the agent's next `cat`.
  The existing `SkillsOverlay` is built at session connect; we
  need a remount or invalidate hook.
- **`terminal`**: register the handler in termish's host-command
  table.

For revoke, the inverse — `delete` from each respective table.
Today's `Policy` shape uses read-only `Map`s; we need internal
`delete` paths that aren't currently exposed.

### Worker runtime story

Worker-mode adds an RPC dimension. The worker holds its own
configure-time snapshot of URL-shipped registrations. A mid-session
namespace grant needs an `addRegistration` message from host to
worker before the agent's next emission, so `await __load('d3')`
resolves. This is a small surface (one new message type, one
worker-side handler) but it's new code.

Host fns / classes don't need a worker round-trip — they dispatch
via the existing bridge.

### Branch switches and rollback

The session's event log is versioned (kvgit-backed). When the
substrate switches branches (or `versioned.resetTo(hash)`), the
visible event log changes. The effective policy at the new HEAD
might include grants that weren't present in the previous HEAD,
or vice versa.

The kvgit-ts wrappers landed in commit `eb2ecb2` (`Staged.switchBranch`
/ `resetTo` / `refresh`) clear staged state when HEAD moves
underneath. We need a complementary hook: recompute effective
policy at the new HEAD and apply the diff to the runtime's
internal tables. Same diff-and-apply logic as a normal grant/
revoke, just driven by a branch-switch trigger instead of an
explicit API call.

### Why this section deserves its own design pass

v1 labelled this work "mechanical." It isn't. The interpreter's
name-lookup path becomes per-session-aware; the worker gains a
new RPC; the skills overlay needs a remount hook; the branch-
switch hook recomputes a diff against the runtime's live tables.
Each piece is bounded, but together they're the bulk of the
implementation work. Worth a dedicated mini-spec before
committing the timeline.

---

## Migration: removing `taskClarify`

The breaking changes:

1. Remove `taskClarify` from the runtime's injected names
   (`packages/agex-ts/src/runtime/eval.ts` and the worker realm in
   `packages/agex-runtime-worker/src/worker.ts`).
2. Remove `TaskClarifyError` from `packages/agex-ts/src/errors.ts`.
3. Remove `ClarifyEvent` from `packages/agex-ts/src/types.ts`.
4. Remove the `clarify` arm in `packages/agex-ts/src/task.ts`'s
   dispatch.
5. Update the primer (`packages/agex-ts/src/render/builtin-primer.ts`)
   — terminator section drops to two entries.
6. Update tests using `taskClarify` (a small handful in
   `eval-runtime.test.ts` and the integration suites).
7. Update docs: `docs/api/task.md`, `docs/api/errors.md`.

Embedders relying on `TaskClarifyError` need to either:

- Use `taskFail` for the "impossible without input" case, or
- Register an `askUser` host fn that the agent can call.

Both flows are straightforward to teach.

---

## Subtleties + open questions

### Identity of the granter

`PolicyGrantEvent` should carry audit metadata: `grantedAt:
timestamp`, `grantedBy?: string` (free-form, host-provided —
'user-approval', 'job-config', etc.), `requestedInEventId?:
string` (link back to the agent's `request_capability` emission
when the grant is in response to one).

### What if the handler takes hours?

`onCapabilityRequest` is awaited inline by the task fn. Long
async waits pin runtime resources (worker stays alive, event
listeners stay registered). For interactive UIs responding in
seconds, fine. For "wait a day for human review," the handler
should `{ approved: false }` immediately and the host should
orchestrate the approval out-of-band, then call
`agent.policy.grant(...)` separately when the approval lands.
Worth documenting the inflection point.

### Does revoke need a tool_use shape for the agent-initiated path?

Probably not in v1 — agents typically don't ask to *lose*
capabilities. If we ever need it, it's symmetric with
`request_capability` and falls under the same machinery.

### `ctx.policy` for host-fn introspection

Deferred to v1.1 alongside extension kinds. The use case is
extension kinds (`fetch-origin` etc.) where the host fn needs to
query "is this origin in the granted set?" — built-in kinds
don't need it.

### Bundle import

Host-orchestrated; agex-ts doesn't change. The studio handles
bundle import by opening the imported event log, walking it for
`PolicyGrantEvent`s, presenting them to the recipient with
approve/deny, and committing only the approved ones (or
appending `PolicyRevokeEvent`s for the denied ones). The
recipient's agex-ts sees a normal event log.

### `taskRefuse` rename

Out of scope for this proposal but worth flagging: in a separate
discussion we considered renaming `taskFail` → `taskRefuse` for
better calibration. That's an independent decision and doesn't
interact with this work.

---

## Implementation sketch

A rough decomposition for an upstream PR. Numbered roughly in
dependency order.

1. **Type definitions** (`packages/agex-ts/src/types.ts`):
   `PolicyEntry`, `PolicyGrantEvent`, `PolicyRevokeEvent`,
   `CapabilityRequestEmission`, `CapabilityRequest`,
   `CapabilityResponse`. Remove `ClarifyEvent`.

2. **Errors** (`packages/agex-ts/src/errors.ts`): remove
   `TaskClarifyError`; add `BasePolicyFrozenError`.

3. **Runtime adapters**: remove `taskClarify` from injected
   names in `evalRuntime` and the worker realm. Add
   `request_capability` emission handling parallel to
   `ts_action` — the agent emits, the runtime captures it, the
   task loop dispatches to the host callback.

4. **Policy builder** (`packages/agex-ts/src/policy.ts`): add
   `delete` paths for built-in kinds; refactor existing
   `register*` methods to delegate to a shared internal
   `declarePolicyEntry(entry)`. Freeze check after first task.

5. **Agent API surface** (`packages/agex-ts/src/agent.ts`):
   add `agent.policy.declare`, `agent.policy.grant`,
   `agent.policy.revoke`. Wire the freeze gate.

6. **Event log integration**: extend `EventLog` to recognize
   the two new policy event types; provide
   `effectivePolicyAt(position, basePolicy)` helper.

7. **Renderer changes**: `render/registrations.ts` builds
   system message from base only; new `render/grants.ts` emits
   inline text for grant/revoke events.

8. **Task loop** (`packages/agex-ts/src/task.ts`): remove
   `clarify` arm; add `request_capability` arm that fires the
   `onCapabilityRequest` callback and appends a
   `PolicyGrantEvent` or denial tool_result.

9. **Side-effect chain** (the hard piece — own design pass):
   - Wire/unwire granted entities into runtime tables on
     grant/revoke.
   - Worker runtime: add `addRegistration` / `removeRegistration`
     RPC.
   - Skills overlay: add a remount hook.
   - Branch-switch hook: recompute effective policy and apply
     diff.

10. **Primer + docs**: rewrite terminator section
    (`packages/agex-ts/src/render/builtin-primer.ts`); add
    `request_capability` description; update
    `docs/api/task.md`, `docs/api/errors.md`,
    `docs/api/registration.md`; add new `docs/api/policy.md`.

11. **Tests**: round-trip grants, revokes, branch-switch
    recomputation, cache-preservation invariants (system message
    is byte-stable across grants), `onCapabilityRequest`
    callback flows (allow / deny / default-deny / async).

### Recommended landing order

If we want to ship incrementally:

- **PR 1**: Kill `taskClarify`. Independent of the policy work,
  clears the conceptual ground. Pure subtraction.
- **PR 2**: `agent.policy.grant` / `revoke` infrastructure,
  built-in kinds, side-effect chain (item 9), tests. The bulk.
- **PR 3**: `request_capability` emission +
  `onCapabilityRequest` callback. Builds on PR 2's machinery.
- **PR 4** (v1.1): Extension kinds + `ctx.policy` for host-fn
  introspection.

---

## Out of scope

- **Sub-agent inheritance.** If agex-ts ever spawns sub-agents,
  do they inherit parent's session-time grants? Default yes, but
  the semantics around revocation across the boundary need their
  own thinking.
- **Programmatic agent self-elevation.** An agent that grants
  itself a capability without host intermediation. The
  infrastructure here doesn't preclude it but doesn't endorse it
  either; host policy decision.
- **Cross-session shared-policy registry.** A user-level "always
  allow these libraries" store. Pure host-side concern; the host
  layers it on top of session grants by calling
  `agent.policy.grant` at session boot for anything in its
  global allow-list.
- **Bundle signing / trust.** Recipient-side approval is the
  trust boundary; signing the bundle to attest to its grants is
  a separate stack.
- **Extension kinds (`kind: string` + `data` + `renderText`).**
  Deferred to v1.1 once there's a second driver beyond the
  studio's namespace case.

---

## Why agex-ts is the right home for this

1. **Cache preservation is structurally agex-ts's
   responsibility.** Only agex-ts knows where the system-message
   boundary is and how per-turn rendering composes. A host trying
   to do this without agex-ts cooperation either re-renders the
   system message (busting the cache) or duplicates agex-ts's
   renderer (becoming coupled to its internals).

2. **The interpreter's name-lookup needs to honor session-time
   grants** for built-in kinds. That can't be done outside agex-ts
   without leaking the policy `Map` and re-implementing the
   interpreter's lookup path.

3. **The infrastructure benefits other agex-ts consumers.** Long-
   running coding agents in a CLI tool, multi-tenant servers
   needing per-session policy expansion, future studios — all
   want this and will all build it themselves if it's not
   upstream. Better to have one definition.

The studio is the immediate driver but it's not the only
consumer. The proposal tries to leave the API agnostic to the
studio's specific UX choices (approval modals, settings
overrides, bundle-import semantics) — those stay studio-side.
agex-ts provides the ledger; consumers provide the meaning.
