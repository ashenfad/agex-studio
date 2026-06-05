# Spawn: delegating to LLM sub-tasks

`spawn` runs an **ephemeral clone of yourself** on a focused sub-task and
returns its result. The clone shares your registered capabilities and
skills but runs on throwaway state (blank VFS, its own context), so its
intermediate reasoning never pollutes yours — you just get the answer.

```ts
const summary = await spawn("Summarize /docs/spec.md in three bullets")

const tile = await spawn({
  task: "Produce a 64×64 SVG tile",
  input: { prompt: "a small castle" },
  output: { type: "object", properties: { svg: { type: "string" } } },
})
```

## When to reach for it

Reach for `spawn` when the work needs an LLM's judgment and benefits from
a fresh, focused context:

- **Fan-out** — research three framings at once, draft three
  implementations and pick one, score N candidates. Fan out with plain
  `Promise.all` — clones run concurrently, so wall-clock is `max`, not
  `sum`:

  ```ts
  const [a, b, c] = await Promise.all([
    spawn({ task: "Argue angle A", input: topic }),
    spawn({ task: "Argue angle B", input: topic }),
    spawn({ task: "Argue angle C", input: topic }),
  ])
  return synthesize(a, b, c)
  ```

- **Context isolation** — a self-contained step (summarize a PDF, draft
  one section) runs in a clean context and hands back just its result.

**Do NOT reach for `spawn` when a function will do.** A `spawn` is a full
LLM round-trip — slow and metered. Mechanical logic (sorting, filtering,
parsing, arithmetic, string work) is plain TS. Spawn is for judgment, not
computation.

## The spec

```ts
spawn(task: string)                 // prose form — returns the clone's taskSuccess value
spawn({
  task: string,                     // what the sub-task should do (required)
  input?: unknown,                  // bound to the clone's `inputs`
  output?: object,                  // JSON Schema — enforced (clone retries on mismatch)
  outputDescription?: string,       // prose shape hint (not enforced)
  primer?: string,                  // extra task-specific framing
  view?: string | string[],         // expose parent path(s) read-only (e.g. "/data")
})
```

- A **JSON-Schema `output`** is enforced: if the clone's `taskSuccess`
  value doesn't match, it sees the error and retries (bounded by the
  iteration cap). Use it when you need a reliable structured return.
- **`view`** mounts your file(s) into the clone **read-only** — for
  "explore these files and report back" without copying them in. Omit it
  and the clone starts with a blank filesystem.
- A clone is **depth-1**: it has no `spawn` of its own, so it can't
  recurse. It shares your skills and capabilities (`search`, etc.) but
  not your VFS unless you pass `view`.

`spawn` **throws** if the sub-task fails or is cancelled — wrap in
try/catch if you want a fallback.

## From an app (iframe callbacks)

The same `spawn` is available as a global inside apps you build, so an
app can call an LLM on a user action (an opponent's move, an NPC reply, a
tutor hint). The spec lives **inline in your app code** — there's no
separate registration step:

```ts
await fs.writeText('app/index.js', `
  const PICK_MOVE = {
    task: 'Play tic-tac-toe as O. Pick your move.',
    output: { type: 'object', properties: { x: {type:'integer'}, y: {type:'integer'} } },
  };
  const ac = new AbortController();
  document.querySelector('#stop').onclick = () => ac.abort();
  document.querySelector('#go').onclick = async () => {
    try {
      const move = await spawn({ ...PICK_MOVE, input: { board: readBoard() } }, { signal: ac.signal });
      applyMove(move);
    } catch (e) {
      showError('The AI could not decide: ' + e.message);
    }
  };
`)
```

- **Always wrap in try/catch** — a failed / cancelled spawn rejects in
  the app; unhandled, the user clicks and nothing visibly happens.
- Pass `{ signal }` (an `AbortSignal`) for a user-driven cancel button.
- App-triggered spawns are app runtime, not chat — they don't appear in
  the conversation, and there's a per-session cap on how many an app may
  make (a guard against runaway cost). App-initiated spawns can't use
  `view` — they get no window onto your files.

## Footguns

- **Don't autoloop.** `setInterval(() => spawn(...))` is a runaway bill.
  App callbacks should fire on user action, not a timer.
- **Mind parallelism.** `Promise.all` of dozens of spawns will hit
  provider rate limits and won't truly all run at once. A handful is the
  sweet spot.
- **Trim `input`.** It's serialized into the sub-task's prompt — large
  inputs burn tokens.
- **Tell the clone to finish.** The clone returns by calling
  `taskSuccess(...)` (the builtin handles this); a clear `task` /
  `output` keeps it from wandering until the iteration cap.
- **Clone reasoning isn't recorded.** Only the result surfaces. If you
  need to know *why* it answered, have the sub-task return reasoning
  alongside the answer (e.g. `taskSuccess({ result, why })`).
</content>
