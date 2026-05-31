# Sub-tasks: defineTask / invokeTask

Two pre-registered globals let you define and run **sub-tasks** —
focused, LLM-powered functions that run in their own isolated
sub-agent. Use them for genuinely judgment-laden work you want to
delegate or fan out; use plain TypeScript for everything mechanical.

```ts
const name = await defineTask({ name?, primer, description, inputs?, output?, maxIterations? })
const result = await invokeTask(name, args)
```

`defineTask` returns the **name string** — that's the handle. Pass it
to `invokeTask` (from your own code or from app code in the iframe).

## When to reach for a sub-task

Reach for one when the work needs an LLM's judgment and benefits from a
fresh, focused context:

- **Fan-out / parallel angles** — research three framings at once,
  draft three implementations and pick one, score N candidates.
- **Focused sub-problems** — a self-contained reasoning step that
  doesn't need your whole conversation, just a tight primer + input.
- **App-embedded AI** — an app you build calls back into a sub-task on
  a user action (an opponent's move, an NPC's reply, a tutor's hint).
  See "From an app" below.

**Do NOT reach for a sub-task when a function will do.** An `invokeTask`
is a full LLM round-trip — slow and metered. Mechanical logic (sorting,
filtering, parsing, arithmetic, string work) is plain TS. Sub-tasks are
for judgment, not computation.

## Defining

```ts
const pickMove = defineTask({
  name: 'pick-move',
  primer:
    'You play tic-tac-toe as O. Choose your next move.\n\n' +
    '# Input\nA 3x3 array of "X" | "O" | null.\n\n' +
    '# Output\nCall taskSuccess({ x, y }) where each is 0 | 1 | 2.',
  description: 'Pick a tic-tac-toe move given a 3x3 board.',
})
```

- **`primer`** is the sub-agent's whole world: system prompt + task
  framing + I/O contract. The sub-agent does NOT see your conversation,
  your files, or the studio skills — bake everything it needs in here.
- **Always tell it to call `taskSuccess(...)`** with the answer.
  Without that, a sub-agent often logs the result and never returns,
  hanging until it exhausts its iteration budget (default 10).
- `inputs` (optional): free-form note about the arg shape.
- `output` (optional): a prose description, **or** a JSON Schema object
  (`{ type, properties, required, items, enum }`). A JSON Schema is
  **enforced** — if the sub-agent's `taskSuccess` value doesn't match,
  it sees the error and retries. Reach for it when you need a reliable
  structured return:

  ```ts
  const pickMove = defineTask({
    name: 'pick-move',
    primer: 'Play tic-tac-toe as O. Call taskSuccess({ x, y }), each 0|1|2.',
    description: 'Pick a tic-tac-toe move.',
    output: {
      type: 'object',
      properties: { x: { type: 'integer' }, y: { type: 'integer' } },
      required: ['x', 'y'],
    },
  });
  ```
- `maxIterations` (default 10) caps the sub-task's turns. Pure-function
  sub-tasks can drop to 1–2 for fail-fast; research can opt up to a
  larger number, or pass `'inherit'` to reuse your own (chat agent's)
  budget for a deep sub-task.

## Invoking

```ts
// Test it directly — runs in its own worker, so this works mid-turn.
const move = await invokeTask(pickMove, { board: emptyBoard })
```

**Fan out with `Promise.all`** — each call runs on its own worker
thread, so wall-clock is `max`, not `sum`:

```ts
const [a, b, c] = await Promise.all([
  invokeTask(defineTask({ primer: 'Angle A…', description: '…' }), topic),
  invokeTask(defineTask({ primer: 'Angle B…', description: '…' }), topic),
  invokeTask(defineTask({ primer: 'Angle C…', description: '…' }), topic),
])
return synthesize(a, b, c)
```

`invokeTask` **throws** if the sub-task fails or exhausts its budget —
wrap in try/catch if you want a fallback.

## What a sub-agent can and can't do

- Has its own ephemeral state and a private in-memory filesystem — it
  **cannot see or touch your VFS**. Nothing persists between calls;
  each invocation is a fresh sub-agent.
- Can call `search(query)` and use `console.log` / `cache` / `fs`
  against its own scratch space. That's it.
- **No** `testApp` / `liveApp`, no `esbuild`, and **no `defineTask`** —
  sub-agents can't spawn their own sub-agents (no recursive fan-out).
- Shares your LLM (same model / key), so cost is centralized.

Need library-specific knowledge in a sub-task? Paste the relevant
excerpt into its `primer` — it won't inherit the studio skills.

## From an app (iframe)

The same `invokeTask` is available as a global inside apps you build, so
an app can call back into a sub-task on a user action:

```ts
await fs.writeText('app/index.js', `
  const ac = new AbortController();
  document.querySelector('#stop').onclick = () => ac.abort();
  document.querySelector('#go').onclick = async () => {
    try {
      const move = await invokeTask('pick-move', { board: readBoard() }, { signal: ac.signal });
      applyMove(move);
    } catch (e) {
      showError('The AI could not decide: ' + e.message);
    }
  };
`)
```

- Reference the sub-task by its **name literal** in app code.
- **Always wrap in try/catch** — a failed / exhausted sub-task rejects
  in the app; unhandled, the user clicks and nothing visibly happens.
- Pass `{ signal }` (an `AbortSignal`) for a user-driven cancel button.
- App-triggered calls are app runtime, not chat — they don't appear as
  chips in the conversation, and there's a per-session cap on how many
  an app may make (a guard against runaway cost).

## Footguns

- **Don't autoloop.** `setInterval(() => invokeTask(...))` is a runaway
  bill. App callbacks should fire on user action, not a timer.
- **Mind parallelism caps.** `Promise.all` of dozens of sub-agents will
  hit provider rate limits and won't truly all run at once. A handful
  is the sweet spot.
- **Args go in the prompt.** They're JSON-stringified into the
  sub-task's input — large args burn tokens. Trim before passing.
- **Sub-agent reasoning isn't recorded.** Only the result surfaces as a
  chip. If you need to know *why* it answered, have the sub-task return
  reasoning alongside the answer (e.g. `taskSuccess({ result, why })`).
