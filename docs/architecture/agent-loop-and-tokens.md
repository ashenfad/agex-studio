# Agent loop and token streaming

How a chat message flows from the user's keypress to a rendered
agent response in the chat. Covers the TS-kernel path in detail
(primary); py-kernel divergences called out where they matter.

## End-to-end flow

```
User types in ChatInput
    │
    ▼
ChatShell.handleSend(prompt, attachments)
    │
    ├─► busy=true; commit attachments to VFS (writeFiles + FileEvent)
    │
    ▼
adapter.sendMessage(branch, prompt, {onToken, signal})
    │
    ├─► (TsKernelAdapter) makeLiveTokenTranslator + onEvent callback
    │
    ▼
agentChatMessage(prompt, ...)        ← ts-agent.js
    │
    ▼
_chatTask(prompt, {session, signal, onToken, onEvent})  ← agex-ts
    │
    │ for each agent turn:
    │   ▼
    │   llmClient.complete({system, turns}, signal)
    │   │
    │   │ stream:
    │   │   ▼  TokenChunk objects (per-emission-field deltas)
    │   │
    │   ▼ token translator → shell-shape tokens
    │   │
    │   ▼ onToken callback → handleToken in ChatShell
    │   │
    │   ▼ MessageList renders streaming bubble
    │   │
    │   ▼ ActionEvent → onEvent → translator.turnComplete()
    │
    │ on success:
    │   ▼ taskSuccess / taskFail / loop exit → response.result
    │
    ▼ adapter's finally → commitSession() (always, even on cancel)
    │
    ▼ ChatShell replaces streaming message with committed message
```

## Tokens

agex-ts streams `TokenChunk`s — small per-emission-field delta
objects. Defined in `agex-ts/types`:

```ts
type TokenChunkType =
  | 'title' | 'thinking' | 'text' | 'ts' | 'terminal'
  | 'filePath' | 'fileSearch' | 'fileContent'
  | 'emission' | 'signature' | 'toolStart'
```

Each chunk has `type`, `content` (string delta), `emissionIndex`
(which emission within the turn), and `done` (final chunk for
that field). The studio's shell expects a slightly different
vocabulary (snake_case names, a synthetic `turn_complete`
boundary, a `start`-flagged `report` token for text), so
`ts-event-translator.js` translates between them.

The translation table (from `ts-event-translator.js`):

| agex-ts → | shell |
|---|---|
| `title` | `title` |
| `thinking` | `thinking` |
| `text` | `report` (with `start: true` on first per emission) |
| `ts` | `ts` |
| `terminal` | `terminal` |
| `filePath` | `file_path` |
| `fileSearch` | `file_search` |
| `fileContent` | `file_content` |
| `emission` / `signature` / `toolStart` | dropped |

The `report` token gets an extra `start: true` flag the first time
it appears per emission — used by the chat shell to decide whether
to create a new streaming bubble or append to the existing one.

After each `ActionEvent` (via the agex-ts `onEvent` callback), the
adapter calls `translator.turnComplete()` which emits a synthetic
`turn_complete` token. This is the shell's boundary marker for
"flush the current streaming activity card into the messages
array."

## ChatShell's streaming state

`ChatShell.svelte` keeps several pieces of state during an
in-flight turn:

- `streamingEvents` — array of `{type: 'action', ...}` events
  flushed from `onEvent`.
- `currentTurn` — a half-built action being accumulated from
  per-emission tokens.
- `activeReportText` / `activeReportIdx` — the in-flight text
  bubble's accumulated content + emission index. Lives outside
  `currentTurn` because text emissions render as their own bubble,
  not as part of the activity card.

`handleToken(token)` walks the token type and updates the right
piece of state. The rendering pipeline (`MessageList`) reads
`messages` + the streaming pieces and produces:

- An **activity card** (the `ActivityPanel` component) showing
  what the agent emitted this turn — code, terminal commands,
  file ops. Expandable to a full modal (`ActionModal`).
- A **report bubble** for any `text`-emission content. Streams
  in real-time, then commits when `turn_complete` fires.

## Commit timing for streaming

The agex-ts EventLog buffers writes (it adds to the kvgit Staged
buffer; nothing reaches disk until `commit()`). The studio's
adapter calls `commitSession()` in its `sendMessage` finally
block — guaranteed to run on success, fail, OR cancel.

agex-ts itself doesn't auto-commit anywhere; this is on the
embedder. See [sessions-and-storage.md](sessions-and-storage.md)
"Session commit on cancel" for the bug this defends against.

## Cancellation

Two cancel paths flow through `ChatShell.handleCancel`:

```js
function handleCancel() {
    cancelling = true
    cancelTask()              // py-only worker-side flag
    activeAbort?.abort()      // TS AbortSignal
}
```

Both fire because the active session might be either kernel; the
non-applicable one is a no-op.

**TS path:** `activeAbort.signal` is plumbed into
`adapter.sendMessage(..., { signal })` and from there into
agex-ts's task call. agex-ts honors `AbortSignal` natively —
checks before each LLM call + after each emission, throws
`CancelledError` from inside the loop. The exception:

- Emits a `CancelledEvent` to the EventLog (so the activity
  card shows "Stopped")
- Re-throws; the adapter wraps the call in `try`/`finally`
  (no `catch`), so the error propagates past it to the shell
- On the way out, the adapter's `finally` calls
  `commitSession()`, persisting the cancellation event

The catch block in `ChatShell.handleSend` distinguishes
user-cancel from genuine errors via `cancelling || e?.name ===
'AbortError'` and renders a "Stopped" band instead of an error
bubble.

**Py path:** worker sets `__main__.__agex_cancel_<task_name> =
True`; agex-py's monkey-patched `check_cancellation` polls and
raises `TaskCancelled`. Same UX outcome — cancelled event in
log, "Stopped" band.

Py also has an `asyncio.CancelledError` recovery path in
`streaming.py` for when the asyncio task itself gets cancelled
out from under the loop. The loop never sees it, so
`run_chat_task`'s except branch manually constructs a
`CancelledEvent`, appends to the log, and commits. This is
**load-bearing** — without it, asyncio cancels leave the
persistent log inconsistent with what the user saw.

## Error bubbles vs cancel bands

| Outcome | UI surface | Persisted? |
|---|---|---|
| Successful turn (`taskSuccess` / `taskFail`) | Normal agent bubble + activity card | yes |
| User cancel | "Stopped" band + partial activity card | yes (via cancel-path commit) |
| LLM stream error (e.g., 400 "Prompt too long") | Error bubble with collapsible stack trace, partial events preserved | yes |
| Worker crash | Error bubble; agent state may need a reload | last-good commit survives |
| Iteration limit | Error bubble noting "max iterations exceeded" | events up to limit committed |

The error bubble (from `MessageList.svelte`) includes a
`<details>` element showing the captured `e.stack` — see
[errors-and-recovery.md](errors-and-recovery.md) for why this
matters for debugging.

## Multi-emission turns

A single LLM response can contain multiple emissions (e.g.,
"think → write file → run code"). Each emission has its own
`emissionIndex`; tokens for different emissions interleave in
the stream but are partitioned by index in the translator.

The activity card shows one block per *tool* emission (ts /
terminal / file ops / thinking). `text` emissions are
deliberately excluded from the card — they render only as the
`report` bubble that sits above the activity, so the narration
isn't shown twice (once as a bubble, once as a card section).
This exclusion lives in `synthesizeAction` (committed / reload
path) and `snapshotTurn` (live streaming); `groupEventsForChat`
mirrors it for the chapter modal by surfacing `action.report`
as its own bubble. A turn that's *only* narration synthesizes to
an emission-less action, which the feed, reload, and chapter
paths all drop so it never renders as an empty card.

## Spawn (sub-agent fan-out) chips

When agent code calls native `spawn(...)` (script-side fan-out) or an
app fires `spawn(spec)` from the iframe, agex-ts runs an ephemeral
**clone** and forwards the clone's events to the parent task's
`onEvent`, tagged with a structured `spawnIndex` (0-based per spawning
task; agex-ts ≥ 0.3.1).

The adapter (`ts-kernel-adapter.js`) does **not** render those clone
events into the chat narrative — that would surface a clone's actions as
if the parent emitted them. Instead it keys off `spawnIndex` and demuxes
them into a synthetic `spawn` **token** (not an agex-ts `TokenChunk` —
the adapter emits it directly):

- clone `taskStart` → `{ type: 'spawn', phase: 'start', id, inputsSummary, inputs }`
- clone `action` → `{ phase: 'progress', id, steps, events?: [action] }`
- clone `output` → `{ phase: 'progress', id, events: [output/error...] }` (no step bump)
- clone `success`/`fail`/`cancelled` → `{ phase: 'end', id, status, steps, durationMs, resultSummary?/result?/error? }`

The `events` payloads are the clone's actions/outputs translated to the
same shell-canonical shape parent events use (see
`serializeSpawnActionEvent` in `ts-event-translator.js` — unlike
`synthesizeAction` it keeps text emissions inline, since a clone has no
chat bubble for narration).

`ChatShell` maintains a per-turn `liveSpawnChips` list keyed by `id`,
each chip accumulating its clone's `events` timeline. `EventDetail`
renders a "running → done/failed" chip under the action that spawned it,
expandable (live or after the fact) into the clone's full event detail —
inputs, per-step actions/outputs, and result — via a recursive
`EventDetail`. Clone stdout follows the modal's existing "stdout" toggle
just like parent output (`hasOutputEvents` in `event-utils.js` looks one
level into chips so the toggle appears even when only clones printed).

The live chips are in-memory only, but they are **not lost on reload**:
`captureSpawnEvents: true` (set on `createAgent` in `ts-agent.js`;
agex-ts ≥ 0.4.0) makes agex-ts attach each clone's event timeline to the
parent task's terminal event (`spawnEvents` on
`success`/`fail`/`cancelled`), which persists in the kvgit log and is
invisible to the parent LLM. On reload, `loadHistory` (and the chapter
walk in `serializeChapterEvents`) rebuilds equivalent chips from that
field via `serializeSpawnChips`. A clone bucket with no terminal event
(parent cancelled mid-spawn) reconstructs as `cancelled`. Cost note:
wide fan-outs make terminal events — and therefore commits and exported
gist bundles — proportionally larger.

## Activity panel collapse / expand

The compact activity card in `MessageList` shows a per-emission
summary (the title, a one-line preview of code/commands). Click
to open the full `ActionModal` which renders every emission's
full text, eval results, and observations.

This split is what keeps the chat scannable for long sessions
while preserving the option to drill into "what did the agent
actually do on turn 47?"

## Design notes

### Why not stream directly without translation?

agex-ts's TokenChunk vocabulary is more granular than the
shell needs — per-emission boundaries, signature tokens for
provider opaque blobs, etc. The studio's UI cares about
turn-level events (one activity card per agent turn,
synchronized to `ActionEvent`) and per-emission deltas for
the streaming text. Translating once at the adapter boundary
keeps the shell-rendering side simple and shielded from
upstream token-shape evolution.

### Why both `onToken` and `onEvent`?

`onToken` is the streaming channel — per-keystroke updates for
the UI to render mid-flight. `onEvent` is the structured channel
— typed `ActionEvent` / `OutputEvent` objects the studio uses
to drive turn boundaries (the synthetic `turn_complete` marker
flushes the activity card) and to capture cancellation events.
Both come from the same upstream stream; the adapter unifies
them through one chat call.

### Why doesn't the chat shell commit?

Commit ownership lives in the kernel adapter. The shell has no
concept of "kvgit branch" — that's a kernel detail. By keeping
the commit in the adapter's `sendMessage` finally, the shell
stays kernel-agnostic *and* the commit is guaranteed to fire
even on cancel (which a shell-side commit would miss without
the same finally pattern).
