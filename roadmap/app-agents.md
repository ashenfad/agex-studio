# Agents in apps, and what apps need

Status: phase 1 built (2026-10-26): agex-ts v0.6.3 (agex-ts #155,
#156, #157), studio #161 (`agex.busy`), #162 (`agex.model`), #163 (the
import map), #164 (`agex.kvStore`) and the `app-agents` skill, whose
spike met the exit below. Phases 2 to 4 not started. This
takes over S6 of [rebuild.md](rebuild.md) (variables, secrets and
services), which was designed and deferred at the switch: its shapes
are here, sliced, and brought up to date with the app agent's meter.

## Why

An app can already call an agent: `agex.task`, a typed function a
helper agent answers on the viewer's model, one call at a time, with
no memory between calls. That suits judgment inside an app (classify,
extract, summarize). It doesn't give an app an agent of its own: a
chat that remembers, with tools, working on the app's own state.

A spike showed agex-ts itself can run inside an app. An agent built
a chat app on agex-ts 0.6.0, its world's kvgit store kept in the
app's `agex.db` through a small connector, and the chat (tool calls
included) synced between the person's devices. The gaps it hit were
all the studio's, not agex-ts's:

- **No model.** An app has no key; the studio keeps it. The spike
  asked for one in a field and kept it in `localStorage`, believing
  it stayed on the device; an app's `localStorage` syncs. A published
  app asking for keys would be a way to collect them, and nothing it
  spends shows on the meter.
- **Loading agex-ts.** esm.sh was failing to serve the packages, so
  it used jsDelivr's `+esm` builds and pinned versions by hand; the
  world's worker can't start from a cross-origin URL, so it wrapped
  it in a `blob:` module worker.
- **A store.** It wrote a kvgit `KVStore` over `agex.db`. `agex.db`
  has no transaction that reads before it writes, so `casMany` leans
  on a guard row whose `CHECK` fails on purpose, read back from the
  error's message.
- **Reloads.** A sync that changes the app's database reloads the
  app, which kills a running turn: its tool calls are kept (each one
  committed), but the run is left without its end.
- **Smaller ones.** Reading the runs (`session.runs()`) needs an
  `Agent` built for it;
  the world's file listing took guessing.

Its storage finding narrows the sync question. kvgit writes almost
everything once, under a content or commit hash, so two devices' rows
union; only a branch's head rows conflict, when both devices commit
to it before syncing.

## The shape: ingredients, not a mini agex-ts

The studio gives an app what only the studio can (a model, a place
to keep a store, a say over reloads) and agex-ts stays the library.
An app's agent is configured the agex way, in the app's code: its
primer, its tools, and host objects that are the app's own functions
(`board.move`, `sheet.setCell`). Running in the app, they need no
bridge, and grant the agent nothing the app couldn't do already.

```js
import { Agent } from 'agex-ts'

const store = await agex.kvStore()
const ws = await store.open('chat', { profile: { hostObjects: { board } } })
const agent = new Agent({ model: agex.model(), primer })
for await (const event of agent.session(ws).stream(text)) render(event)
```

`agex.task` stays as it is: the lighter choice when an app needs an
answer, not an agent, with no agex-ts in the page.

## Phase 1: an agent in an app

Exit: an agent, given the skill alone, builds a chat app on agex-ts
with no key in the app, no connector of its own, no worker workaround,
and no turn lost to a reload.

1. **agex-ts** (released with what is waiting, `fs.remove`'s
   `recursive`):
   - a workspace's runs, read without an `Agent`;
   - the world's worker started from a cross-origin URL, the world
     wrapping it itself.
2. **`agex.model()`**, a provider over the bridge.
   - It returns an agex-ts `Provider`: each `stream` is one model call,
     sent to the studio and run on the viewer's model, its events
     streamed back; a stop is passed through; `transient` and
     `describe` answer as the viewer's provider does.
   - Each reply's usage goes on the app's meter. The limiter counts
     model calls on a rate of their own, about 60 a minute (a chat
     turn can make ten), beside the 10 task calls a minute.
   - The consent question is today's (a session from elsewhere asks
     first), until phase 2's panel replaces it. `test_app` runs it
     for real, and past the rate refuses rather than pauses, as it
     does tasks.
3. **agex-ts for apps.** The import map resolves `agex-ts` and
   `@agex-ts/*` to the versions the studio itself is built with, from
   a CDN that builds them, so an app gets one copy of each, the
   versions whose READMEs the agex-ecosystem skill ships. Needs (1).
4. **`agex.kvStore()`**, a kvgit `KVStore` on a table of the app's
   database. `cas` and `casMany` run as real transactions in the
   database's worker, so nothing leans on a failing statement. It
   syncs as the rest of `agex.db` does; the head conflict between
   devices stays a known limit (Later).
5. **No reload mid-turn.** An app marks work in flight
   (`agex.busy(promise)`); while any is, a sync that changes the
   database under it offers the reload, as another device's
   `localStorage` does now, instead of reloading. A restore still
   reloads: the person asked for it. Any app gains from this, not only
   agents.
6. **The `app-agents` skill**, referenced from the interactive-app
   skill (beside its `agex.task` section, which says when a task is
   enough). The recipe: the imports, `agex.model()`, the store, the
   app's functions as host objects, streaming `TurnEvent`s into the
   page, rebuilding the chat from the runs, stopping. Then a spike
   with headless agents, as the delegation skill had: does an agent
   build a working chat app from the skill alone?

(1), (2), (4) and (5) are independent; (3) waits for (1)'s release;
(6) comes last.

## Phase 2: an app's needs, and its viewer's secrets

- **Needs, declared.** `app/agex.json`:
  `{ "needs": { "model": true, "secrets": [{ "name", "origins", "in", "why" }] } }`,
  where `in` is the one place a secret goes, a request header
  (`"header:Authorization"`).
- **`agex.fetch(url, init)`**: the studio fills `${NAME}` into the
  declared header, for a declared origin only; never into a URL, a
  query or a body, which services echo far more often. A literal echo
  in a response is replaced with the reference (the world's
  `httpHost` rules).
- **What that guarantees, and what it doesn't.** The secret reaches
  only its origins, in its declared header: an app can't send it
  anywhere else. It can't keep a service *at* those origins from
  reflecting it back transformed (a debug echo, an encoding endpoint),
  so the viewer is trusting the service with the key, not the app's
  code with it; the panel says so.
- **One panel, "This app needs…"**, on a viewer's first use: each need
  met (✓ a model) or not (a key for `api.stripe.com`, with a field),
  the value kept on the viewer's device, and for a secret what it
  allows ("this app can use your key with api.stripe.com; a service
  there that echoes keys could expose it"). Allowing grants this app,
  per app and by name, its model (on the meter) and those secrets; it
  replaces today's consent question. A need the app didn't declare
  asks the same way when it is first used.
- **Secrets for an app's agent.** The app's world gets an `http` host
  object that forwards to `agex.fetch` with `${NAME}` unfilled, so
  neither the app's code nor its agent holds the value. agex-ts gains
  a secret declared by name and origins without its value, so the
  tools' descriptions still name it.
- **Stand-ins** for live services, so `test_app` checks an app without
  touching its real backend.

## Phase 3: the agent's own secrets

- Device-wide, in settings beside the model key: name, value (hidden
  once saved), and the origins it may go to, which are required. Not
  synced, not published.
- Given to every session's profile as the world's secrets (`{value,
  origins}`); the agent sees names and origins, never values, and uses
  them as `$NAME` in `curl` and `secret('NAME')` with the `http` host
  object.
- Asked for when needed: a `request_secret` tool (name, origins, why)
  shows a form in the chat; the value goes to settings, never into the
  transcript.

## Phase 4: variables

- Configuration an app needs and anyone may read (a Supabase URL and
  its anon key, which row-level security guards, not secrecy). Per
  session, on the studio plane (`variables`), so they sync, fork,
  bundle and publish with it; set in a session panel, or by the agent.
- Given to the world as its profile's `variables` (`env` in code,
  `$NAME` in the shell), and to the built app as `window.env`.

## Decisions

- **Ingredients first.** A turnkey `agex.agent({ primer, objects })`
  that owns the workspace, storage and streaming waits until apps show
  the same ten lines every time.
- **The limiter counts model calls** for `agex.model`, on its own
  rate (about 60 a minute), not tokens: a count is what the dialog
  can explain.
- **The store is a connector on `agex.db`**, so it syncs with nothing
  new; a kvgit namespace of the studio's own for apps waits (Later).
- **The recipe is a skill of its own**, `app-agents`, referenced from
  interactive-app: it is long, and most apps don't need it.

## Reserved meanwhile

`window.env` and `agex.fetch` in the app's page, `app/agex.json`, and
the `variables` key on the studio plane; the interactive-app skill
tells the agent to leave the app-side three alone. Phase 1 adds
`agex.model`, `agex.kvStore` and `agex.busy`.

## Open questions

- The rate's number (60 model calls a minute), once apps have run on it
  for longer than a spike's few turns.

Settled in phase 1: the meter lists an app agent's model calls in
bursts (calls 30 seconds apart or less are one entry, "agex.model"),
and `agex.kvStore(name?)` takes a name, `default` without one.

## Later

- **A kvgit namespace for apps** in the studio's own store, instead
  of kvgit inside SQLite inside kvgit: no double versioning, and a
  head that syncs as a session's does.
- **Heads across devices:** a branch per device, merged on load,
  which needs a device id an app can read (an app has no storage that
  stays on the device).
- **A turnkey `agex.agent()`** (Decisions).
