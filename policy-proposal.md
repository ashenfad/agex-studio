# Mid-session policy grants for agex-ts

**Status:** Draft proposal originating from agex-studio. Intended for
upstream discussion in agex-ts.

**Audience:** agex-ts maintainers (and consumers thinking about
runtime capability expansion).

**TL;DR:** Today's `agent.namespace` / `agent.fn` / etc. registrations
are construction-time only — they build the system message and stay
fixed for the agent's lifetime. We propose adding a session-time
grant mechanism (`agent.policy.grant` / `agent.policy.revoke`) that
appends events to the conversation history rather than mutating the
system message, so prompt caches are preserved while the effective
policy can grow over the course of a session. The same machinery
unlocks an extensible ledger of host-defined capabilities (fetch
origins, file scopes, iteration budgets, …) without requiring agex-ts
to interpret each one.

---

## Motivation

### The product use case

An interactive agent realizes mid-session that it needs a library or
capability the user hadn't pre-approved. Today the agent has to fail
the task and the user has to restart the session with a wider policy.
The desired flow:

1. Agent's `taskSuccess` carries a `ResourceRequest` — "I'd benefit
   from `d3` for the force-directed graph you asked for; here's why."
2. User sees an approval card in the chat shell, clicks approve.
3. Studio appends a grant; agent's next task has `import * as d3
   from 'd3'` available.

The studio can build the UX (approval modal, settings overrides,
bundle-import re-prompt) entirely on its own, but the underlying
ability to **add to the agent's policy mid-session** has to come from
agex-ts. And it has to come in a specific shape, because of the
prompt-cache problem.

### Why this can't be a thin wrapper around `_agent.namespace(...)`

`Agent.namespace(...)` (and the other registration methods) mutate
the policy `Map` directly. Today's renderer renders the entire policy
into the system message. If the studio called `_agent.namespace(...)`
mid-session in response to a user approval, the next request's
system message would contain the new namespace.

For Anthropic's, OpenAI's, and Gemini's prompt caches, the system
message + leading conversation prefix is the thickest cache layer.
Any byte change anywhere in the cached prefix invalidates everything
downstream. For a 50-turn / 50K-token chat session, a single grant
that re-renders the system message turns the next request from a
~5% cache-hit cost into a 100% recomputation. Multiply by several
grants over the session and the cache is dead.

The constraint is sharp: **policy that grows mid-session must ride
in the conversation as turn-level events, not as system-message
edits.** The system message is rendered once at the policy snapshot
taken at agent construction and stays static. Anything added later
lives downstream in the event log.

### Why this generalizes beyond namespaces

Once the event-based grant infrastructure exists, the same machinery
covers any capability that a session can accumulate over time:

- `kind: 'namespace'` — the immediate driver; agex-ts knows how to
  interpret these (registers in interpreter).
- `kind: 'fetch-origin'` — a host's permissive `fetch` agent.fn
  checks at call time whether the requested origin is in the granted
  set. agex-ts doesn't interpret; it just stores + renders + makes
  queryable.
- `kind: 'iteration-budget'` — agent requests more turns mid-task.
  Host-enforced.
- `kind: 'file-scope'` — eventual file-system access expansion.
  Host-enforced.
- `kind: 'tool'` — third-party API exposed as an agent.fn (later;
  thornier because the fn body has to come from somewhere safe).

Built-in kinds get implementation in agex-ts core. Extension kinds
ride on `data` + `renderText` + the runtime query API. Same event-
based machinery for both.

---

## Design overview

Three concepts:

1. **Base policy.** Declared at agent construction via the existing
   methods (or the new generic `agent.policy.declare(...)`). Builds
   the system message, never produces events, never changes for the
   agent's lifetime. This is the agent's "always-on" capability set.

2. **Session-time grant.** A `PolicyGrantEvent` appended to the
   event log via `agent.policy.grant(...)`. Renders inline in the
   LLM context at its turn position. Cache-preserving by
   construction (only the message at the event's position and
   beyond is paid for; everything before stays cached).

3. **Effective policy at point P.** A function of base policy + all
   `PolicyGrantEvent`s up to point P − all `PolicyRevokeEvent`s up
   to point P. Used by:
   - The interpreter, when looking up a name (built-in kinds).
   - Host fns, via `ctx.policy.grantsOfKind(...)` (extension kinds).
   - The renderer, when emitting LLM context.

### What does NOT change

- Existing `agent.namespace` / `agent.fn` / `agent.cls` /
  `agent.skill` / `agent.terminal` keep their signatures. They
  remain the primary construction-time API. Internally they become
  sugar over `agent.policy.declare(...)`.
- The system message is still rendered from the base policy. No
  caching surprise for existing callers.
- The interpreter's name-lookup behavior is the same for code that
  doesn't use mid-session-granted capabilities.

### What is new

- A unified `PolicyEntry` shape across all kinds (built-in and
  extension).
- `agent.policy.grant(entry)` / `agent.policy.revoke({kind, name})`
  for session-time mutation, both producing events.
- `ctx.policy.grantsOfKind(kind)` / `ctx.policy.has(kind, name)`
  for runtime introspection inside host fns.
- Two new event types: `PolicyGrantEvent`, `PolicyRevokeEvent`.
- Renderer logic that splits "construction-time policy →
  system message" from "session-time grants → inline turn messages."
- For built-in kinds (`namespace`, `fn`, `cls`, `skill`,
  `terminal`), agex-ts also wires/unwires the granted entity into
  the interpreter on grant/revoke.

---

## API surface

### `PolicyEntry`

A discriminated union with tight types for built-in kinds and an
opaque `data` shape for extensions:

```ts
export type PolicyEntry =
  // Built-in kinds: agex-ts knows the data shape AND acts on the
  // grant (registers the namespace in its interpreter, mounts the
  // skill overlay, wires the host-bound fn, etc.).
  | { kind: 'namespace';  name: string; url: string; export?: string }
  | { kind: 'fn';         name: string; description: string;
                           handler: HostFnHandler;
                           wantsContext?: boolean }
  | { kind: 'cls';        name: string; cls: HostClass }
  | { kind: 'skill';      name: string; content: string }
  | { kind: 'terminal';   name: string; description: string;
                           handler: TerminalCommandHandler;
                           hostFsAccess?: boolean;
                           networkAccess?: boolean }
  // Extension kinds: agex-ts stores + renders + makes queryable,
  // but doesn't interpret. Host enforces semantics at call time
  // via `ctx.policy.grantsOfKind`.
  | { kind: string; name: string;
       data: Record<string, unknown>;
       renderText?: string };
```

The discriminator does the work — built-ins type-check tightly; the
extension variant requires explicit `data`. `renderText` is
optional everywhere; agex-ts auto-generates a sensible default if
absent (see "Rendering" below).

### Construction-time

Existing methods are kept (no breaking change) and a generic
`policy.declare()` is added:

```ts
// Existing — continue to work, become thin sugar over declare:
agent.namespace({ url: 'https://esm.sh/d3' }, { name: 'd3' });
agent.fn(myHandler, { name: 'compute', description: '...' });
agent.cls(MyClass, { name: 'Frobber' });
agent.skill(skillMd, { name: 'my-skill' });
agent.terminal(myCommand, { name: 'mycmd', description: '...' });

// New — generic form for arbitrary kinds (built-in + extension):
agent.policy.declare({ kind: 'namespace', name: 'd3',
                       url: 'https://esm.sh/d3' });
agent.policy.declare({ kind: 'fetch-origin', name: 'github-api',
                       data: { origin: 'https://api.github.com' },
                       renderText: 'fetch access to the GitHub API is available' });
```

Construction-time `declare` calls produce no events. They build the
base policy, which is rendered into the system message at the start
of the first task.

Hosts use `declare` for extension kinds they want as part of the
agent's baseline (always-on `fetch-origin` for whitelisted APIs,
default file scopes, etc.).

### Session-time

```ts
// Append a PolicyGrantEvent. Effective from the next turn forward.
await agent.policy.grant({
  kind: 'namespace',
  name: 'd3',
  url: 'https://esm.sh/d3',
}, { session });

await agent.policy.grant({
  kind: 'fetch-origin',
  name: 'example-api',
  data: { origin: 'https://api.example.com' },
  renderText: 'fetch access to api.example.com is now permitted',
}, { session });

// Append a PolicyRevokeEvent. Effective from next turn.
await agent.policy.revoke({ kind: 'fetch-origin', name: 'example-api' },
                          { session });
```

`grant` and `revoke` both:
- Accept a `session` option (matches the rest of the per-session
  agent API: `agent.fs(session)`, `agent.events(session)`).
- Append the event to that session's log.
- For built-in kinds, also wire/unwire the entity in the
  interpreter for that session.
- Return the new event (or just resolve once the append is
  durable).

#### Conflict rules

- **Grant a name already in base policy of the same kind**: throw
  at grant time. Base policy is the agent's identity; session-time
  can extend, not shadow.
- **Grant a name already in a previous (un-revoked) session-time
  grant of the same kind**: idempotent if the entry is identical,
  throw if it differs. Prevents accidental URL-swap drift.
- **Revoke a name that's only in base policy**: throw. Base policy
  isn't revocable session-time; that's an identity change.
- **Revoke a name that isn't currently granted**: no-op (already
  effectively absent).

These rules keep the model debuggable. "Why does the agent see
`d3` from `https://esm.sh/d3@5` when the latest grant says `@6`?"
should never happen.

### Runtime introspection — `ctx.policy`

Host fn / terminal handlers receive `ctx` (per `wantsContext: true`
or always for terminals). `ctx.policy` exposes:

```ts
ctx.policy.grantsOfKind('fetch-origin'): Promise<PolicyEntry[]>
// Effective entries of `kind` at the current execution point —
// base policy entries of that kind ∪ session-time grants up to
// here − session-time revokes up to here.

ctx.policy.has('fetch-origin', 'example-api'): Promise<boolean>
// Shortcut for grantsOfKind(...).then(g => g.some(e => e.name === name)).
```

Both are `async` because the underlying event log may be backed by
async storage (kvgit / IndexedDB / SQLite). For performance,
agex-ts caches the effective-policy snapshot for the duration of a
single emission — multiple lookups in one host-fn invocation don't
re-walk the event log.

#### Worked example: a host's `fetch-origin`-checking fn

```ts
agent.fn(async function safeFetch(...args) {
  const ctx = args[args.length - 1];
  const [url, opts] = args.slice(0, -1);

  const requestedOrigin = new URL(url).origin;
  const grants = await ctx.policy.grantsOfKind('fetch-origin');
  if (!grants.some(g => g.data.origin === requestedOrigin)) {
    throw new Error(
      `safeFetch: origin ${requestedOrigin} not approved. ` +
      `Approved origins: ${grants.map(g => g.data.origin).join(', ') || '(none)'}`
    );
  }
  return fetch(url, opts);
}, {
  name: 'safeFetch',
  description: 'HTTP fetch, restricted to user-approved origins.',
  wantsContext: true,
});
```

The host fn does its own enforcement; agex-ts is just the source of
truth for "what's in the granted set right now."

---

## Rendering and cache preservation

### System message — built from base policy only

The renderer walks `agent.policy.base()` (an in-memory snapshot of
all construction-time `declare` calls) and emits the registration
section verbatim — same as today. Session-time grants and revokes
do **not** appear in the system message.

This is the cache-preservation foundation: the system message
content depends only on agent-construction-time state, never on
session history. For the agent's lifetime, the system message is
byte-identical across requests.

### Inline grant rendering — at the event's position in history

When the renderer walks the event log to assemble per-turn LLM
context, each `PolicyGrantEvent` becomes a system-style message
inserted at its position:

```text
[turn 47 — assistant emission]
[turn 47 — output]
[capability granted] (← rendered from PolicyGrantEvent)
  Capability granted at this turn: `import * as d3 from 'd3'` is
  now available.
[turn 48 — user message]
[turn 48 — assistant emission, can use d3]
```

The exact transport varies by provider (Anthropic might use a
`role: 'user'` content block; OpenAI similarly; some might support
mid-conversation `system`). agex-ts's job is to insert the message
at the right position; the provider adapter's job is to route it
appropriately.

#### `renderText` — auto-generated when absent

For built-in kinds, agex-ts can synthesize sensible default text:

| Kind        | Auto-generated `renderText` |
|-------------|----------------------------|
| `namespace` | `Capability granted: \`import * as <name> from '<name>'\` is now available (resolves to <url>).` |
| `fn`        | `Capability granted: host function \`<name>\` is now callable. <description>` |
| `cls`       | `Capability granted: host class \`<name>\` is now constructable. <description>` |
| `skill`     | `Capability granted: skill is now mounted at \`/skills/<name>/SKILL.md\` (cat to read).` |
| `terminal`  | `Capability granted: shell command \`<name>\` is now available. <description>` |

For extension kinds, if `renderText` is absent, fall back to a stub:

```text
Capability granted: <kind> '<name>'.
```

…but encourage hosts to provide explicit `renderText` for clarity
(linter / type warning).

### Cache cost analysis

For a typical session with N turns and K mid-session grants
distributed across the session:

- **Without this feature** (today: studio re-registers via
  `_agent.namespace`, system message changes): each grant busts the
  entire prompt cache. Cost on the next turn after each grant =
  full input tokens recomputed. K grants → K full recomputations.

- **With this feature**: each grant inserts one message at its
  event-log position. Cache prefix up to that position is
  preserved; turns after the grant pay only for the additional
  message + any subsequent uncached turns. Net cost per grant is
  one extra message of context, not the full prefix.

For a session with 50K input tokens and 5 grants spread evenly:
- Today: 5 × 50K = 250K tokens of cache-miss cost.
- Proposed: 5 × ~50 tokens of new content + standard incremental
  cost. ~99% reduction in grant-induced cache miss.

---

## Revocation

`agent.policy.revoke({kind, name})` appends a `PolicyRevokeEvent`.
Effective-policy computation walks both `grant` and `revoke` events,
most-recent-wins per `(kind, name)` pair.

For built-in kinds, agex-ts also needs to *unregister* the entity
from the interpreter's policy `Map` on revoke. Today's `Map`-based
storage is one-way (no `delete` path is exposed). This proposal
includes adding the `delete` path internally and the corresponding
revoke side-effects:

- `kind: 'namespace'` revoked → `policy.namespaces.delete(name)`.
- `kind: 'fn'` revoked → `policy.fns.delete(name)`.
- `kind: 'cls'` revoked → `policy.classes.delete(name)`.
- `kind: 'skill'` revoked → unmount overlay + `policy.skills.delete(name)`.
- `kind: 'terminal'` revoked → `policy.terminals.delete(name)`.

For extension kinds, revoke has no interpreter effect — the host
fn's next `ctx.policy.grantsOfKind(...)` call will simply not see
the revoked entry.

---

## Effects on the agent's view

### Mid-session

The agent's emission stream is unchanged. They write code as before;
the interpreter's name-lookup uses the effective policy (base ∪
session-time grants) at the execution point. From the agent's
perspective, granted names just "work" starting from the turn after
the grant message appears in their context.

The agent doesn't need a new API. They don't call `policy.grant` or
`policy.has`. Capability expansion is brokered by the host (studio,
CLI, …) responding to whatever signal the agent sends — typically a
`ResourceRequest` part in `taskSuccess`, but any host-defined flow
works.

### After undo

Rolling back the session's branch (kvgit undo / `versioned.resetTo`)
drops events past the rollback point, including any
`PolicyGrantEvent`s that landed there. The renderer re-walks the
new event log, the system message is unchanged, the inline grant
messages are simply not present, and the effective policy at the
new HEAD reflects the rollback.

For built-in kinds, agex-ts must also un-wire the namespace/fn/etc.
from the interpreter on rollback if it was wired. The mechanism is
the same as for explicit revoke (see "Revocation" above) — the
substrate's branch-switch hook needs to recompute the effective
policy and apply the diff.

### After bundle import

This is host-orchestrated. agex-ts doesn't need a "pending" flag
on events.

The host (studio) handles bundle import by:
1. Opening the imported event log read-only.
2. Walking it for `PolicyGrantEvent`s.
3. Presenting them to the recipient with approve/deny.
4. Committing the import to the recipient's branch with only the
   approved grants kept (rejected ones get appended as
   `PolicyRevokeEvent`s, or the host writes a fresh log without
   them — its choice).

agex-ts sees a normal event log on the recipient's side; the
hydration logic doesn't care that some of those events came from
elsewhere.

---

## Subtleties + open questions

### How is `ctx.policy` cached per-emission?

Suggested: agex-ts maintains a `WeakMap<EmissionContext,
PolicySnapshot>` populated lazily on first `grantsOfKind` /
`has` call, valid for the duration of the emission. Cleared when
the emission ends. Subsequent emissions get a fresh snapshot
that reflects any grants that landed between them.

### What if the agent is in the middle of an emission when a grant lands?

It can't happen: grants are appended via `agent.policy.grant`,
which is host-side code outside the emission's execution. The
host calls `grant` between emissions (typically in response to a
user click). The agent's next emission sees the new grant.

(If a host wanted "grant from within the agent's own code" — e.g.,
self-elevating agents — that's a different design question. For
now, all grants come from host code.)

### Identity of the granter

`PolicyGrantEvent` should carry enough metadata to audit:
`grantedAt: timestamp`, `grantedBy?: string` (free-form, host-
provided — the studio might write `'user-approval'`, a CI agent
might write `'job-config'`), `requestedInEventId?: string` (if the
grant is in response to a specific agent request, link back).

### Does `revoke` need its own renderer entry in LLM context?

I'd say yes — symmetric with grants. "Capability revoked: `d3` is
no longer available" lets the LLM know not to keep trying to use
something that worked earlier in the conversation.

### Construction-time vs first-task-time

Today, `agent.namespace(...)` etc. can be called any time before
the first task starts (it's just policy mutation). After tasks
start, mutating base policy would be a system-message change →
cache bust. Should we **freeze** base policy after the first task?

Proposed: yes. After the first `task()` call, calls to base-policy
`declare` (or the helpers) throw `BasePolicyFrozenError`. Forces
hosts toward `agent.policy.grant` for any post-task additions.

### Skill overlays — granted skills also mount overlays?

Yes — `kind: 'skill'` granted mid-session should mount its
markdown at `/skills/<name>/SKILL.md` so the agent can `cat` it
on their next turn. The overlay update is part of the grant's
side-effect chain, same as namespace registration.

### Versioning of policy state

Granted policy is part of the session's event log → versioned by
kvgit (or whatever substrate the session uses). No new persistence
machinery needed.

For "always-trusted" cross-session state (e.g., user's machine-
wide approved namespaces), that's host-side concern — the host
can layer it on top by always calling `policy.grant` at session
boot for anything in its global allow-list.

### Backwards compatibility

- Existing `agent.namespace` / `agent.fn` / etc. continue to work
  unchanged.
- Existing `Policy` shape gets the new event-derived layer added on
  top, but reads from `policy.namespaces` etc. continue to return
  the snapshot of base + currently-granted.
- Renderer changes: existing system-message rendering becomes
  "render base only"; inline grant rendering is purely additive.
  No cache impact for clients that don't use the new API.
- New event types are append-only additions; older code that
  doesn't understand them can ignore them.

---

## Implementation sketch

A rough decomposition for an upstream PR:

1. **Type definitions** (`types.ts`): `PolicyEntry`,
   `PolicyGrantEvent`, `PolicyRevokeEvent`. Update `Policy`
   interface to expose `base()` and `effectiveAt(eventLogPosition)`.
2. **Policy builder** (`policy.ts`): add `delete` paths for built-
   in kinds; refactor existing `register*` methods to delegate to
   a shared `declarePolicyEntry(entry)` internal.
3. **Agent API surface** (`agent.ts`): add `agent.policy.declare`
   (sugar for the existing methods + extension kinds), `agent.policy
   .grant`, `agent.policy.revoke`.
4. **Event log integration**: extend `EventLog` to recognize the
   two new event types; provide `effectivePolicyAt(position,
   basePolicy)` helper.
5. **Renderer changes**: `render/registrations.ts` builds system
   message from base only; new `render/grants.ts` emits inline
   text for grant events when assembling history.
6. **Runtime ctx surface**: `ctx.policy` — `grantsOfKind`, `has`,
   per-emission caching.
7. **Side-effect application**: when a grant for a built-in kind
   is appended, also call the corresponding policy-builder
   `register*`. When a revoke is appended, call the corresponding
   `unregister*`. Branch-switch hook: re-compute effective policy
   and apply diffs.
8. **Frozen-after-first-task** check on base policy mutations.
9. **Tests**: round-trip grants, revokes, undo, bundle-import-style
   replay, cache-preservation invariants (system message is
   byte-stable across grants).

The biggest single piece is probably (7) — the diff-and-apply
machinery for branch switches. Everything else is fairly
mechanical.

---

## Out of scope

These are real questions but explicitly not addressed by this
proposal:

- **Sub-agent inheritance.** If agex-ts ever spawns sub-agents, do
  they inherit parent's session-time grants? Default yes, but the
  semantics around revocation across the boundary need their own
  thinking.
- **Programmatic agent self-elevation.** An agent that requests a
  capability and grants itself that capability without host
  intermediation. The infrastructure here doesn't preclude it but
  doesn't endorse it either; that's a host policy decision.
- **Cross-session shared-policy registry.** A user-level "always
  allow these libraries" store. Pure host-side concern; the host
  layers it on top of session grants.
- **Capability shape negotiation.** "I want `d3` v7+, you have v6"
  kinds of versioning conflicts. Out of scope; host's problem.
- **Bundle signing / trust.** Recipient-side approval is the trust
  boundary; signing the bundle to attest to its grants is a
  separate stack.

---

## Why agex-ts is the right home for this

Three reasons:

1. **Cache preservation is structurally agex-ts's responsibility.**
   Only agex-ts knows where the system-message boundary is and how
   per-turn rendering composes. A host trying to do this without
   agex-ts cooperation either re-renders the system message
   (busting the cache) or duplicates agex-ts's renderer (becoming
   coupled to its internals).

2. **The interpreter's name-lookup needs to honor session-time
   grants** for built-in kinds. That can't be done outside agex-ts
   without leaking the policy `Map` and re-implementing the
   interpreter's lookup path.

3. **The infrastructure benefits other agex-ts consumers.** Long-
   running coding agents in a CLI tool, multi-tenant servers
   needing per-session policy expansion, future studios — all
   want this and will all build it themselves if it's not
   upstream. Better to have one definition.

The studio is the immediate driver but it's not the only consumer.
The proposal tries to leave the API agnostic to the studio's
specific UX choices (approval modals, settings overrides, bundle-
import semantics) — those stay studio-side. agex-ts provides the
ledger; consumers provide the meaning.
