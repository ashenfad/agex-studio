---
name: app-agents
description: Give an app an agent of its own on agex-ts — a chat that remembers, with tools and the app's own functions as host objects, on the viewer's model (`agex.model()`), its world kept in the app's database (`agex.kvStore()`). The whole page to start from, streaming a turn into it, rebuilding the chat from its runs, stopping, and checking it. Read it before building an agent into an app; for a single judgment call (classify, summarize, extract), interactive-app's `agex.task` is enough.
---

# An agent in an app

An app can run an agent itself: agex-ts in the page, with a world of
its own, on the viewer's model. Read the interactive-app skill first;
this builds on it.

**Use this when the app needs an agent, not an answer:** a chat that
remembers what was said, an assistant that acts on the app's state
(moves cards, edits a sheet, plans a trip in the app's own data),
work that takes several steps and tools. **For one answer per call**
(classify this, summarize that), `agex.task` in interactive-app is
simpler: no agex-ts in the page, no memory, one call each.

The studio gives the app three things only it can, and agex-ts does
the rest:

- **`agex.model()`**: an agex-ts `Provider` on the viewer's model and
  key. The app never holds a key; never ask for one.
- **`agex.kvStore(name?)`**: a kvgit store kept in the app's
  `agex.db`, for the agent's world: its files, its conversation, all of
  it, synced, forked and restored with the app's data.
- **`agex.busy(promise)`**: marks a turn in flight, so a sync offers
  the person a reload instead of cutting the turn off.

`agex-ts`, `@agex-ts/world` and the rest are in the import map, at the
versions the studio runs: import them by name. Their READMEs are in
the agex-ecosystem skill (`references/agex-ts.md`, `world.md`); read
them for anything here doesn't cover.

## The whole page

A chat with an agent that can call the app's own functions. Start from
this and change the parts that are the app's: its state, the host
object, the primer.

```html
<!doctype html>
<html>
<head>
  <style>
    #log { display: flex; flex-direction: column; gap: 8px; }
    .you { align-self: flex-end; } .agent { white-space: pre-wrap; }
    .note { color: #888; font-size: 0.9em; }
  </style>
</head>
<body>
  <ul id="cards"></ul>
  <div id="log"></div>
  <form id="ask">
    <input id="text" autocomplete="off" placeholder="Ask the assistant…">
    <button id="send" disabled>Send</button>
    <button type="button" id="stop" hidden>Stop</button>
  </form>
  <script type="module">
    import { Agent, Policy, messageText, readRuns } from 'agex-ts'
    import { Store } from '@agex-ts/world'

    // The app's own state, kept in agex.db as any app keeps it.
    await agex.db.query('CREATE TABLE IF NOT EXISTS cards (id INTEGER PRIMARY KEY, title TEXT NOT NULL)')
    const cardsEl = document.getElementById('cards')
    async function renderCards() {
      const { rows } = await agex.db.query('SELECT id, title FROM cards ORDER BY id')
      cardsEl.replaceChildren(...rows.map((r) => Object.assign(document.createElement('li'), { textContent: r.title })))
      return rows
    }
    await renderCards()

    // What the agent may do to the app: these methods, called from its
    // code as `board.cards()` and `board.add(title)`. Each updates the
    // page itself, so the person sees the change as it happens.
    const board = {
      async cards() {
        return renderCards()
      },
      async add(title) {
        if (typeof title !== 'string' || !title.trim()) throw new TypeError('board.add(title): a title')
        const { lastInsertRowid } = await agex.db.query('INSERT INTO cards (title) VALUES (?)', [title.trim()])
        await renderCards()
        return Number(lastInsertRowid)
      },
    }

    const PRIMER = `You are the assistant inside a card board app. The person sees the board beside this chat.
Your code has a host object \`board\`:
- \`await board.cards()\`: the cards, as [{ id, title }]
- \`await board.add(title)\`: adds a card and returns its id
Use run_ts to read or change the board. Reply briefly, in plain text with no Markdown.`

    // The agent's world, kept in the app's database. A profile is kept in
    // memory only: give it each time the page opens the session.
    const store = await Store.open(agex.kvStore())
    const ws = await store.open('chat', { profile: { hostObjects: { board } } })
    const agent = new Agent({ model: agex.model(), primer: PRIMER, maxSteps: 12, compaction: new Policy(100_000) })
    const chat = agent.session(ws)

    const log = document.getElementById('log')
    function bubble(who, text = '') {
      const el = Object.assign(document.createElement('div'), { className: who, textContent: text })
      log.append(el)
      return el
    }

    // The conversation so far, from the world: it survives a reload, and
    // came with the database to another device.
    for (const run of await readRuns(ws)) {
      for (const m of run.messages) {
        const text = messageText(m)
        if (m.role === 'user' && text) bubble('you', text)
        if (m.role === 'assistant' && text) bubble('agent', text)
      }
    }

    const form = document.getElementById('ask')
    const input = document.getElementById('text')
    const send = document.getElementById('send')
    const stop = document.getElementById('stop')

    form.onsubmit = async (event) => {
      event.preventDefault()
      const text = input.value.trim()
      if (!text || chat.running) return
      input.value = ''
      bubble('you', text)
      const reply = bubble('agent')
      const note = bubble('note')
      send.disabled = true
      stop.hidden = false
      const turn = async () => {
        for await (const ev of chat.stream(text)) {
          if (ev.kind === 'TextDelta') reply.textContent += ev.text
          else if (ev.kind === 'ToolStarted') note.textContent = 'Working…'
          else if (ev.kind === 'ToolEnded') note.textContent = ''
          else if (ev.kind === 'RunEnded') {
            note.textContent =
              ev.status === 'completed' ? '' :
              ev.status === 'cancelled' ? 'Stopped.' :
              ev.status === 'interrupted' ? `Interrupted (${ev.message ?? 'the model was out of reach'}). Send again to retry.` :
              `Couldn't finish: ${ev.message ?? 'something went wrong'}`
          }
        }
      }
      try {
        await agex.busy(turn())
      } finally {
        send.disabled = false
        stop.hidden = true
      }
    }
    stop.onclick = () => chat.cancel('stopped by the person')
    send.disabled = false
  </script>
</body>
</html>
```

## The pieces

- **`agex.model()`** runs each of the agent's model calls on the
  viewer's model, with their thinking setting, at up to 16k output
  tokens (8k unless `settings.maxTokens` says more). Each call goes on
  the app's meter. Past about 60 model calls a minute (a turn can make
  ten) the app's calls pause until the person says to go on. Someone
  opening a shared app is asked first whether it may use their model.
  A call that can't run (no model chosen, refused, paused and stopped)
  fails the turn: `RunEnded` says why in `message`. Nothing throws.
- **The store:** `Store.open(agex.kvStore())` is a world store in the
  app's database (the table `_agex_kv`; leave it to the store).
  `store.open(id)` opens that session, or starts it: one id per
  conversation (`'chat'`, or `chat-${n}` for an app with several).
  `agex.kvStore('name')` keeps a separate store, which an app rarely
  needs.
- **Host objects** are the app's own functions, running in the page,
  so they need no bridge and grant the agent nothing the app couldn't
  do. Only methods reach the agent's code (not `_private` ones), every
  call is `await`ed there, and arguments and results cross by value
  (data, not class instances or functions). Check arguments as the
  example's `add` does, since the model writes the call. Update the
  page from inside the method, so a change shows as it lands.
  `typedHost(obj, contract)` from `@agex-ts/world` checks each
  argument with zod schemas instead (`import { z } from 'zod'`).
- **The primer** is all the agent knows about the app: what it is, what
  each host object method does and returns, and how to reply. Name the
  methods exactly as the object has them. Ask for short plain text with
  no Markdown: the page shows the reply as text, so `*Dune*` shows its
  asterisks.
- **What the agent has besides:** its world's files, a shell
  (`terminal`) and `run_ts`, which runs its TypeScript in a worker the
  world starts. The worker loads on the agent's first code run, which
  can take a few seconds.
- **A turn** is `chat.stream(text)`: `TextDelta`s as the reply comes
  (several model calls' text run together, between tool calls),
  `ToolStarted`/`ToolEnded` around each tool call, and `RunEnded` with
  `status`: `completed`, `cancelled`, `failed` or `interrupted` (a
  model error worth retrying: `await chat.resume()` continues it, or
  the next message starts afresh). `chat.say(text)` is the same without
  the stream, resolving to `{ status, text }`.
- **Stopping:** `chat.cancel(reason)` ends the turn `cancelled`, its
  work so far kept. `chat.running` says whether a turn runs; let only
  one run at a time.
- **`agex.busy(turn())`** keeps a sync from reloading the page under a
  running turn. Wrap the whole turn, as the example does.
- **Send starts disabled,** enabled once the page has set up: the
  imports and the store take a moment, and a form submitted before its
  handler is set reloads the page.
- **The history** is the world's runs, oldest first: `readRuns(ws)`.
  Each run's messages have a `role` (`user`, `assistant`, `tool`) and
  `parts`. `messageText(m)` is a message's prose, and an assistant
  message that only called tools has none. Its `tool_call` parts
  (`name`, `args`) are there to show if the app wants a "ran code"
  line.
- **A long chat** is folded as it grows (`compaction: new
  Policy(100_000)`): what the model is sent is summarized past that
  many tokens, while the stored runs keep everything for the page.

## Services with the viewer's keys

For an agent that calls a service needing a key, declare the key in
`app/agex.json` (interactive-app: "Services with the viewer's keys"),
and give the world the `http` host object and the declared secrets:

```js
const ws = await store.open('chat', {
  profile: { hostObjects: { board, http: agex.http() }, secrets: agex.secrets() },
})
```

- **`agex.http()`** is the world's `http` over `agex.fetch`. The
  agent's code calls `await http.fetch(url, { headers, as: 'json' })`
  (`as`: `text`, the default, `json` or `bytes`) and gets
  `{ status, ok, statusText, url, headers, body }`. `secret('NAME')`
  in its code is the key's reference, which goes in the declared
  header: `{ Authorization: 'Bearer ' + secret('WEATHER_KEY') }`. The
  studio fills it in, so neither the app nor its agent holds the key.
- **`agex.secrets()`** is the declared secrets by name and origins,
  with no values, so the agent's tools list them.
- **Configuration** the app reads from `window.env` (a service's base
  URL) goes to its agent as the world's variables:
  `profile: { ..., variables: window.env }`, so its code reads
  `env.API_URL` and its shell `$API_URL`.
- **Say it in the primer:** the service, what to call, and that the key
  goes as `secret('WEATHER_KEY')` in that header, through
  `http.fetch`. `curl` in the agent's shell refuses a request carrying
  one of these keys.
- **Test** with `test_app`'s `standIns`, as any app that calls a
  service.

## Designing one

- **Give the agent the app's verbs, not its insides.** `board.add`,
  `board.move(id, column)`, `sheet.setCell(ref, value)`: a few methods
  that do what a person could do in the app, checked as a person's
  input would be. Not `agex.db` itself: the agent would write SQL
  against tables the app owns.
- **The app's data stays the app's.** Cards, cells and trips live in
  the app's own tables. The agent's world holds its conversation and
  whatever it writes there for itself. Don't make the app read the
  agent's files for its state.
- **Show what it did,** in the app (the board changes), and briefly in
  the chat. A reply's text is the model's: show it with `textContent`,
  never `innerHTML`.
- **Every message spends the viewer's model.** Send only what the
  person sends: never call the agent on load, from a render, or on a
  timer.
- **A fresh conversation** is a new session id, kept in the app's own
  data (a "New chat" button that bumps `chat-${n}`). Old ones stay in
  the store, readable by their id.

## Checking it: `test_app`

`test_app` runs the agent for real, on the person's meter: every turn
costs model calls. Check the page once with a short message, and wait
for the turn's end (a note that clears, a reply that stops growing)
with `waitFor` or `{wait: 30000}` before reading. A test can't ask the
person anything, so past the rate its calls are refused rather than
paused. Keep tests to a turn or two. A test's database is a scratch
copy, so its turns don't land in the person's chat.

## What doesn't work

- **A key in the app**, a field asking for one, or a provider made with
  one (`createAnthropic({ apiKey })`): use `agex.model()`. App storage
  syncs, and a shared app asking for keys would be a way to collect
  them.
- **Pinned CDN URLs** for agex-ts (jsDelivr, unpkg, esm.sh with a
  version): import by name, or the page gets a second copy of a
  package, and a world's store and an agent's session must share one.
- **`profile.code.worker.url`**, or a `blob:` worker of your own: the
  world finds and starts its worker itself.
- **IndexedDB or a store of your own** (a `Memory` store loses the chat
  on reload; IndexedDB is blocked in apps): `agex.kvStore()`.
- **Two devices chatting in the same conversation at once**, before
  either syncs: the conversation's latest turn conflicts, and the
  person picks one side in the session's dialog.
