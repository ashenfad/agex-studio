# Agents in apps, and what apps need

Status: phase 1 built (2026-10-26): the agex-ts repository's v0.6.3
release (agex-ts 0.6.1, world 0.1.3, kvgit 0.2.1, kvsql 0.1.1; agex-ts
#155, #156, #157), studio #161 (`agex.busy`), #162 (`agex.model`), #163 (the
import map), #164 (`agex.kvStore`) and the `app-agents` skill, whose
spike met the exit below. Phase 2 built (2026-10-26): agex-ts #159
in v0.6.4 (world 0.1.4), studio #167 (`app/agex.json`), #168 (the
vault), #169 (`agex.fetch`), #170 (the panel), #172 (`agex.http()`),
#173 (stand-ins) and #174 (the skills), whose spike met slice 8's
check: agents given the skills alone built a keyed app and an app agent
that used the key, and against httpbin the key went only in its
declared header, its echo came back as the reference, and neither the
app's page nor its agent held it (the studio fills it in). Phase 3 is
sliced, phase 4 not started. This
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

An app is often written by one person and run by another, who brings
their own key. So **sharing an app shares its needs, never values**:
the app says what it needs (a key for `api.stripe.com`, in the
`Authorization` header, and why), and each viewer supplies their own.
The app names a secret (`STRIPE_KEY`); the viewer's key is their own,
whatever an app calls it. Two layers, after GitHub's organization and
repository secrets:

- **The vault**, the person's secrets: one list in settings, beside
  the model key, kept on this device (not synced, not published, not in
  any app's storage). Each entry is a label, a value (hidden once
  saved), and the origins it may go to, which are required and which no
  app can widen. Phase 3's agents use the same vault.
- **Grants**, an app's access: each links one of the app's declared
  needs to one vault entry, by reference, so a key changed in the vault
  changes for every app that uses it. A grant is per app (below), and
  pointing it at another entry (a test key for one session) is all an
  override needs.

The parts:

- **Needs, declared.** `app/agex.json`:
  `{ "needs": { "model": true, "secrets": [{ "name", "origins", "in", "why" }] } }`,
  where `in` is the one place a secret goes, a request header
  (`"header:Authorization"`).
- **`agex.fetch(url, init)`**: the studio fills `${NAME}` into the
  declared header, for a declared origin only, from the app's grant;
  never into a URL, a query or a body, which services echo far more
  often. It runs on the world's `request` (no redirect followed, a size
  cap, a literal echo in the response replaced with the reference).
- **Only a request with a secret leaves through the studio.** The
  studio's origin isn't the app's: a service that trusts the studio, or
  the studio itself, would answer it where it refuses the app. So
  `agex.fetch` with no secret reference is the app's own `fetch`, run in
  its frame; one with a reference goes from the studio only to that
  secret's declared origins, `https:` only, never the studio's or the
  apps' own origins, with no credentials (`credentials: 'omit'`) and no
  redirect followed.
- **What that guarantees, and what it doesn't.** The secret reaches
  only its origins, in its declared header: an app can't send it
  anywhere else. It can't keep a service *at* those origins from
  reflecting it back transformed (a debug echo, an encoding endpoint),
  so the viewer is trusting the service with the key, not the app's
  code with it; the panel says so.
- **One panel, "This app needs…"**, on a viewer's first use, replacing
  today's consent question: each need met (✓ a model) or not ("a key
  for `api.stripe.com`, to look up prices"). For a secret it offers the
  vault entries whose origins cover the app's (Use *Stripe (personal)*),
  or a field for a new key, which goes into the vault and is granted;
  and it says what allowing grants ("this app can use your key with
  api.stripe.com; a service there that echoes keys could expose it").
  A need the app didn't declare asks the same way when it is first
  used. A hidden test refuses rather than asks.
- **In settings**, each vault entry lists the apps it is granted to,
  each with a revoke.
- **Secrets for an app's agent.** `agex.http()` is a host object for
  the app's world that forwards to `agex.fetch` with `${NAME}` unfilled,
  and the app's declared secrets go into its profile by name and
  origins, without values (agex-ts gains such a secret), so the tools'
  descriptions name them and neither the app's code nor its agent holds
  a value.
- **Stand-ins** for live services, so `test_app` checks an app without
  touching its real backend or needing a key.

Slices:

| # | Where | What | Needs |
|---|---|---|---|
| 1 | agex-ts | A secret declared by name and origins, with no value: listed in the tools' descriptions, its reference given by `secret('NAME')` and `$NAME`, its origins enforced, filled only by a host object that forwards it; then a patch release | |
| 2 | studio | `app/agex.json`: parsing and checking `needs`, its mistakes shown where the agent sees a build error | |
| 3 | studio | The vault and grants: the device-only store, the model, and settings (entries, origins, "used by", revoke) | 2 |
| 4 | studio | `agex.fetch`: the page's shim (its own `fetch` without a secret) and the studio's handler on the world's `request` for one with a secret (declared origins only, no credentials, never the studio's own origins), the header-only rule, values from grants | 2, 3 |
| 5 | studio | The "This app needs…" panel, with the picker over the vault, replacing the consent question | 2, 3 |
| 6 | studio | `agex.http()` and declared secrets in an app's world | 1 (released), 4 |
| 7 | studio | Stand-ins for `test_app`: canned responses by origin and path | 4 |
| 8 | studio | Skills (interactive-app's services and secrets, app-agents' note) and a spike: an agent builds a keyed app; httpbin's `/headers` shows only the declared header carried the key, and that the echo was scrubbed | all |

(1) and (2) are independent; (4) and (5) follow (3); (6) and (7)
follow (4).

## Phase 3: the agent's own secrets

The vault is phase 2's. What's left is the person's own agents, which
today have `curl` and no key, so a key typed into the chat lands in
the transcript, the model's context and the session's history.

- **A key, by name, for the agent:** the world's secrets
  (`{ value, origins }`), so the agent sees a name and its origins,
  never the value. It writes `$NAME` in `curl` and `secret('NAME')` in
  code with the `http` host object, which the studio's profile gains
  (its requests sent without credentials). The world fills it in for
  those origins only, and replaces an echo with the reference.
- **Two ways a key reaches a session's agent:**
  - **"Available to my agents"** on a vault entry, off by default, with
    a name for agents (`STRIPE_KEY`, upper-case, one per entry and
    unique among those on). Every session's agent has it, as someone
    sets an `.env` for their own tools.
  - **`request_secret`** (`name`, `origins`, `why`): the agent asks
    when a task needs a key. The chat shows the picker phase 2's panel
    has, over the entries whose origins cover the request, or a field
    for a new key, which goes into the vault. What the person picks
    is granted to this session under the requested name and origins;
    "Not now" answers the tool so the turn goes on. The value is typed
    into the picker, never into a message, and the tool's result names
    the secret only.
- **A grant is per session,** after an app's: kept in the vault under
  `agent:<session>`, apart from that session's app (`session:<name>`),
  so granting the app a key doesn't hand it to the agent, or the other
  way. It keeps the origins the person approved with it (an app's come
  from `app/agex.json`; an agent's request has no such file), and the
  secret goes to those origins only, never the entry's wider ones. A
  fork copies it; a delegate has its top session's; removing a session
  forgets it. A grant beats an entry made available under the same
  name.
- **No one to ask, no asking:** a delegate's `request_secret` is
  refused, since it runs with nobody at the picker (a delegate has
  its top session's grants already). The refusal tells it to finish
  and say in its answer which key it needs (name, origins, why). A
  delegate that delegated passes that up in its own answer, so it
  reaches the top session, whose agent can ask the person and delegate
  again.
- **The world reads its secrets live** (agex-ts): a profile's `secrets`
  may be a function, called each time a request, the shell or a tool
  description needs them. A key granted mid-turn is there for the next
  tool call, and one revoked is gone, without reopening the session.
- **Settings:** each entry's toggle and name for agents, and its "used
  by" listing sessions' agents beside apps, each with a revoke.
- **On another device** the session has no grant (the vault isn't
  synced), so its agent asks again there.

Slices:

| # | Where | What | Needs |
|---|---|---|---|
| 1 | agex-ts | A profile's `secrets` as a function, read at each use (requests, the shell's environment, the tools' descriptions); then a patch release | |
| 2 | studio | Agents' grants in the vault (`agent:<session>`; forks, delegates, removal), "available to my agents" and its name, settings; each session's world given its secrets live, and the `http` host object | 1 (released) |
| 3 | studio | `request_secret`: the picker in the chat (shared with the panel), a delegate's refusal, the result | 2 |
| 4 | studio | The primer's note on keys, and a spike: an agent asked to call httpbin with "my key" asks, uses it in `curl` and `http.fetch`, and httpbin's echo comes back as the reference | all |

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
- **Secrets are a vault plus grants** (phase 2): the person's keys
  defined once, each app granted access to entries by reference.
  Apps and keys meet by origin, not by name.
- **Every vault entry has origins:** without them nothing bounds where
  a key may go, which is the point of keeping it out of apps.
- **A grant is per app.** Your own app's grant is its session's, which
  its forks share; a shared or imported app's is its published id's,
  and a new version keeps it while it declares nothing new.
- **Your own apps use the model without asking,** as now; the panel
  shows for them only when a secret has no grant. A shared app gets the
  whole panel.
- **Header only:** a secret goes in one declared request header. A
  service that takes its key in the query string (some weather and maps
  APIs) can't be used through `agex.fetch` until a real app needs one.
- **`agex.fetch` is unmetered:** it spends the viewer's key with a
  service, not their model, and the panel names the services.
- **The studio fetches only what carries a secret,** to its declared
  origins, without credentials: everything else stays the app's own
  `fetch`, so no app borrows the studio's origin.
- **Agents don't see vault entries by default** (phase 3): an app
  always asks, and a session's agent asks with `request_secret`.
- **An agent's grant is its session's,** apart from its app's: the two
  are trusted differently (a person's own agent, an app anyone may have
  written), so neither inherits the other's keys.
- **The world's secrets are read live,** not fixed when a session
  opens: a key asked for mid-turn has to reach the next tool call.

## Reserved meanwhile

`window.env` in the app's page and the `variables` key on the studio
plane; the interactive-app skill tells the agent to leave `window.env`
alone. Phase 1 adds `agex.model`, `agex.kvStore` and `agex.busy`;
phase 2 `agex.fetch`, `agex.http`, `agex.secrets` and `app/agex.json`.

## Open questions

- The rate's number (60 model calls a minute), once apps have run on it
  for longer than a spike's few turns.

Settled in phase 1: the meter lists an app agent's model calls in
bursts (calls 30 seconds apart or less are one entry, "agex.model"),
and `agex.kvStore(name?)` takes a name, `default` without one.

## Later

- **The vault across your devices:** synced encrypted, with a
  passphrase only the person knows; until then each device's keys are
  entered on it.
- **A kvgit namespace for apps** in the studio's own store, instead
  of kvgit inside SQLite inside kvgit: no double versioning, and a
  head that syncs as a session's does.
- **Heads across devices:** a branch per device, merged on load,
  which needs a device id an app can read (an app has no storage that
  stays on the device).
- **A turnkey `agex.agent()`** (Decisions).
