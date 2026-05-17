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
- Re-throws so the adapter's `try` catches it
- The adapter's `finally` calls `commitSession()`, persisting
  the cancellation event

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

The activity card shows one block per emission. The `report`
text emissions (if any) stream into their own bubble between
the activity card and the user's next message.

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
