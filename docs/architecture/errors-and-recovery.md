# Errors and recovery

What can go wrong during a turn, where the error surfaces, what
state survives, and how the agent / user can recover.

## Where errors come from

A handful of distinct failure modes, each with its own surface
and behavior:

| Source | Examples | Handling layer |
|---|---|---|
| LLM API | "Prompt is too long", auth failure, rate limit, network error | agex-ts → adapter try/catch → chat error bubble |
| Tool parsing (LLM streaming) | Hallucinated tool name, malformed JSON args | agex-ts synthetic TextEmission fallback |
| Agent code exception | `throw new Error(...)` in `ts_action` body, runtime errors | Captured by agex-ts emission dispatch → next-turn observation |
| Terminal command | Non-zero exit, `TerminalError` from a builtin | agex-ts emission dispatch → next-turn observation |
| Cancellation | User clicks Stop | `AbortSignal` or py cancel flag → `CancelledEvent` in log |
| Worker crash | OOM, unrecoverable WASM error | Surfaces as a worker `error` event → boot failure path |
| Studio-side bug | Bad state in ChatShell, render error | Browser console + chat error bubble if it reaches the agent path |

Different paths because the appropriate response is different.
LLM errors are user-visible (model misbehaving — agent can retry).
Agent code exceptions are internal (agent should self-correct on
next turn). Cancellations are intentional. Worker crashes are
fatal until reload.

## The agent's "self-correct" path

Most errors the agent encounters during a turn don't break out of
the loop. agex-ts catches the exception, produces an
*observation* describing what went wrong, and the agent sees it
as the result of their action on the next iteration:

```
agent emits → ts_action with bad code
   ↓
runtime executes → throws ReferenceError
   ↓
agex-ts wraps → {type: 'output', parts: [{type: 'text', text: 'ReferenceError: ...'}]}
   ↓
next iteration → LLM sees the error in the conversation
   ↓
agent emits → corrected code (usually)
```

This is the **recoverable error contract** — agent should be able
to read the error string in their next-turn context and fix
their own code. The studio doesn't intervene; agex-ts owns this
loop.

## When errors escape the agent loop

Some errors are unrecoverable inside the loop and propagate up to
the chat shell:

- LLM API errors that fail the stream entirely (`Prompt is too
  long`, 401 unauthorized, network error after retries)
- `TaskFailError` from agex-ts hitting `maxIterations`
- Parser crashes in the provider layer (rare; we hardened against
  the known case — see "unknown tool names" below)
- Cancellation via `AbortSignal`

These land in `ChatShell.handleSend`'s catch block. The shell
distinguishes:

```js
const userCancelled = cancelling || e?.name === 'AbortError'
if (userCancelled) {
    // Render with `cancelled: true` → "Stopped" band
} else {
    // Render as Error bubble with stack trace
}
```

## The error bubble + stack trace

For non-cancel errors, the chat shows a regular agent message
whose content starts with `Error: <message>`, plus a `<details>`
collapsible underneath with the full stack trace.

The capture (`_captureStack` in `ChatShell.svelte`) prefers
`e.stack` (V8/SpiderMonkey/WebKit all include the message
header), falls back to `name + message` for thrown values that
aren't proper Error instances.

This was added specifically so when a user reports "the agent
loop broke," they can expand and paste the stack and we can
locate the bug in one read instead of guessing the code path.
For the `file_path` undefined error (commit `e544e37`), the
stack pointed at `CallState.feedArgs` in 1 read — without the
stack we'd have spent a long time grepping.

**Production minification note**: stack traces in deployed
builds reference minified bundle paths
(`/assets/index-AbCdEf123.js:1:NNNNN`). Source maps are emitted
alongside; Chrome devtools unminifies automatically when you
click through. For "user pastes stack to issue tracker"
scenarios, the unminified form is one step away (open devtools,
copy from the Sources panel).

## In-flight events survive errors

When an error fires mid-turn (after the agent has already
emitted some actions), the partial activity card stays visible
alongside the error bubble. From `ChatShell.svelte`:

```js
const eventsBeforeError = [...streamingEvents]
const liveSnapshot = snapshotTurn()
if (liveSnapshot && liveSnapshot.emissions.length) {
    eventsBeforeError.push(liveSnapshot)
}
messages = [...finalMessages, {
    role: 'agent',
    content: `Error: ${e.message}`,
    events: eventsBeforeError,
    ...
}]
```

Without this snapshot dance, the streaming-message filter would
strip the half-built activity and the user would see only the
error string — losing the context of what the agent was *doing*
when it failed.

## Unknown tool names (LLM hallucination)

When the LLM streams a tool_use block whose name isn't one of
the four registered action schemas (`ts_action`,
`terminal_action`, `write_file`, `edit_file`), agex-ts used to
crash inside `CallState.feedArgs` with:

```
TypeError: Cannot read properties of undefined (reading 'file_path')
```

The hardened path: `keyMapFor` returns an empty map for unknown
tools (so streaming-chunk lookups silently skip), and
`CallState.buildEmission` returns null for unknown tools (which
routes through `finalize()`'s existing synthetic-TextEmission
fallback). The synthesized text reads:

```
(<tool-name> call dropped: unknown tool name "<tool-name>" — not in the registered schema set)
```

Surfaces in the activity card as a text observation. The model
sees it on the next turn's input and can self-correct.

This was the fix in agex-ts commit `6647736`. See
`packages/agex-ts/src/providers/parser.ts`.

## Cancellation as a non-error

The studio treats cancellation distinctly from errors. The cue
is `ChatShell.cancelling = true` set by `handleCancel` before
firing the abort — the catch block reads that flag (plus
`e.name === 'AbortError'`) and renders a "Stopped" band rather
than an error bubble.

The `CancelledEvent` from agex-ts (or the manually-constructed
one on the asyncio recovery path in py) lands in the EventLog
just like any other event, so:

- Reload preserves the cancellation as part of the history
- Undo lets the user rewind past it
- Bundle export includes it

Cancellation is a recoverable user-driven outcome, not a failure
state.

## Iteration limits

Each task has a `maxIterations` cap. TS chat task: 40
(`MAX_ITERATIONS` in `ts-agent.js`, bumped from agex-ts default
of 10 because chat-driven app building legitimately needs many
turns and the user can hit cancel anyway).

When hit, agex-ts emits a `FailEvent` with the exhaust message
and throws `TaskFailError`. The shell renders it as an error
bubble with the message ("max iterations exceeded") visible.

The agent can't recover within the same call (the loop is
over), but the user can send a new message and the agent picks
up from a fresh iteration budget — with all prior context
preserved.

## Size-cap truncations

Several size caps fire silently — when they do, the agent sees
a truncation notice in their input but no error per se:

| Cap | When fired |
|---|---|
| iframe-bridge eval value (50 KB) | Agent's eval returned a huge structure |
| iframe-bridge read value (50 KB) | Agent's `read` saw a huge property |
| Iframe console message (50 KB) | App code logged a huge object |
| `collectResults` total (256 KB) | Combined testApp return exceeded the budget |
| agex-ts `safeStringify` (50 KB / arg) | Agent's own `console.log` saw a big arg |
| termish-ts `executeScript` (200 KB) | Terminal command produced huge stdout |

Each truncation notice includes the original size so the agent
can adapt their next call. See [app-preview.md](app-preview.md)
"Size caps" and the relevant commits for the rationale of each
boundary.

## Worker crash

If the agex-runtime-worker dies (rare; OOM under genuinely
pathological code), the worker's `error` event fires and the
runtime reports `"worker failed during boot"` or similar. The
adapter throws; the chat shows an error bubble.

The worker is created lazily on first `execute()` and torn down
on `dispose()`. If a crashed worker leaves stale state, calling
`dispose()` then re-initializing the agent recovers. The studio
doesn't currently surface a "restart kernel" UI affordance —
the workaround is a page reload, which is heavy but reliable.

## Service worker / cache mishaps

The service worker caches Pyodide and the studio bundle for
fast reload. Two pathological modes:

- **Stale cache after deploy.** New deploy hits but the user's
  service worker still serves the old bundle. Hard refresh
  (Cmd-Shift-R) or "Update on reload" in devtools clears it.
- **Worker bundle 404 in prod.** The vite worker bundling
  story is fiddly — vite needs `?worker&url` to actually
  bundle (see commit `536602b` and the "Worker bundling"
  section in [kernels.md](kernels.md)).
  Symptom: `"worker failed during boot"` in production but
  not in dev. Pre-deploy smoke check is the right defense.

## Design notes

### Why distinguish error bubble vs cancel band

User intent. An error means "something went wrong I didn't ask
for" — the user wants to see it loudly. A cancel means "I told
it to stop" — they want a quiet confirmation. Conflating them
under one "error" UI would make every cancel look like a crash.

### Why preserve partial events on error

Debug context. "Error: Prompt is too long" without seeing what
the agent emitted up to that point is unhelpful. The half-built
activity card tells you the agent was doing X, Y, Z and the
prompt got too big at Z — that's actionable.

### Why bound the stack trace at 320px

Long V8 stacks (50+ frames) would dominate the bubble visually
and push the actual error message out of view. Sticky 320px
container with scroll keeps the error message visible while
giving the user access to the full stack when they want it.
