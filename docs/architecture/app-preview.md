# App preview

An app is files under `/workspace/app`. The preview pane renders it in
an iframe beside the chat, `test_app` builds the same page in hidden
iframes for the agent to check, and play mode shows a published app
alone. All three assemble the page with `buildAppPage`
(`app-html.js`) and load it on a separate origin.

## A separate origin

`AppPreview.svelte` and `app-control.js`'s test iframes load a
bootloader from `APPS_ORIGIN` (`apps-origin.js`: `apps.agex.studio` in
production, `VITE_APPS_ORIGIN` to point at a local copy of the
agex-studio-apps repo), at `{APPS_ORIGIN}/?t={timestamp}` so each load
reloads it. The handshake is two messages: the bootloader posts
`agex-host-ready` once it listens, and the studio answers with
`agex-host-init` carrying the built page (`hostInit`), which the
bootloader writes in as its document.

So an app's code runs on another origin: it can't reach the studio's
`localStorage`, IndexedDB, settings, keys or DOM, and the studio can't
reach into it. Everything between them is `postMessage`, checked both
ways: the studio accepts a message only from the iframe's own window
at `APPS_ORIGIN` (`isFromAppFrame`) and replies only to that origin
(`replyToApp`); the page posts only to the parent origin the
bootloader stamped (`window.__agexPost`), and drops a message rather
than broadcast when it isn't set. The bootloader accepts a studio only
on its known origins (in development, ports 5173 and 4173).

The iframe has no `sandbox` attribute (the separate origin isolates
it, and an opaque origin broke media capture, stylesheet introspection
and referer-checked services); an `allow=` list delegates browser
features: autoplay, microphone, camera, geolocation, motion sensors,
MIDI, fullscreen, wake lock, web share, clipboard write. Keep the
lists in `AppPreview.svelte` and `app-control.js` in step.

## Building the page

`readApp(ws)` (`app-files.js`) reads the app: text files keyed
`app/<path>`, binaries beside them. The preview rebuilds when the
session's `appStamp` moves (a tool call that wrote, an undo, a
reload), and only when the files' fingerprint changed (`appDigest`).

`buildAppPage(appFiles, { appBinaries, appStorage })` returns the
page's HTML and its assets. It first reads and checks `app/agex.json`
(`app-needs.js`), failing the build on a mistake, and keeps the app's
needs on the page (`needs`), the file itself no part of it. Then:

1. Takes `app/index.html`, or for an app with only a main script, a
   page that loads it.
2. Collects the assets (`app-assets.js`): binaries, and data files
   (`.json`, `.csv`, …: text files other than the page, scripts and
   styles), each once, as bytes with a type. The HTML names each by a
   token (`agex-asset:<n>:`) in the references the HTML and CSS make
   to it and in `window.appAssets`, which maps each path to its URL;
   `fetch('logo.png')` is patched to resolve through it. A path a
   script sets at run time uses `appAssets`.
3. Inlines CSS files, and gives each JS file a data URL in an import
   map, rewriting the app's own imports to it (`__app/…`). Bare
   imports go to esm.sh, with pinned entries for preact (and `react`
   as `preact/compat`), htm (its subpaths' own imports resolved
   through the map), marked, dayjs and dompurify. Any other package
   is asked for with `?external=preact,react,react-dom`, so its own
   imports of those come through the map too: one Preact on the page,
   whatever library the app uses. agex-ts and its packages (each, and
   each subpath its `exports` offer) resolve to the versions the studio
   is built with, read from `node_modules` at build time
   (`virtual:ecosystem-packages`), each asked for with the others
   external, so the page has one copy of each. Plotly loads as a
   script, only for an app whose page or scripts name `Plotly`.
4. Bundles `*.worker.js` files with esbuild into module sources,
   started with `appWorker(name)`.
5. Injects, at the start of the page's head (after the doctype and
   `<html>` tag when it has no `<head>`): the console interceptor, the
   storage shim, the assets script, the worker registry, the host
   bridge, the control bridge, and the import map.

The assets go to the frame when the page does (`hostInit`). A
bootloader that says it takes them (`agex-host-ready` with
`assets: 1`) gets them as Blobs beside the HTML: it mints a `blob:`
URL for each in its own window, which `document.open()` keeps, and
puts it in place of the token, so each asset crosses once, as bytes,
however often the page refers to it. (The studio's own blob URLs
wouldn't serve: they belong to another origin.) An older bootloader
gets the HTML with `data:` URLs written in (`inlineAssets`, as
`buildAppHtml` builds a page that stands alone).

## What the app can ask of the studio

The host bridge (`HOST_BRIDGE_SCRIPT`) gives the page:

- **Storage**: `localStorage` is a shim seeded with the session's
  app data (`app-storage.js`: the studio's `localStorage` under
  `agex-app:ts:<session>:`), capped at 5 MB. Each change posts the
  whole bag (`agex-app-storage`); the preview checks it (strings,
  within the quota: `checkBag`), writes it a moment later, all or
  nothing, and tells sync (`sync.appChanged`). An app that reloads
  itself gets its page again, seeded with what it saved. `sessionStorage` is in memory;
  `indexedDB` throws, saying to use `agex.db` (or `localStorage` for
  small settings). A test iframe's
  shim is read-only: it reports its stores to the test alone, for a
  `{reload: true}`.
- **The cache**: `getCacheValue(key)` reads a value the agent's code
  put in its cache (`cache.set`).
- **`notify(title, body)`**: the preview shows it (`appNotify` in
  `notify.js`) only when the browser already allows the studio's
  notifications, which the person grants from the settings (an app's
  request isn't a click on the studio's page, so it can't ask), and at
  most 5 a minute per session; it answers `shown`, and why not, which
  the bridge logs. Clicking one switches to the session. A test
  iframe answers false at once.
- **`agex.task(spec)`**: an agent task the app calls (below).
- **`agex.model()`**: an agex-ts provider on the viewer's model, for an
  agent the app runs itself (below).
- **`agex.fetch(url, init)`**: `fetch`, with the viewer's keys for
  the secrets the app declares (below).
- **`agex.db`**: the session's SQLite database (below).
- **`agex.busy(promise)`**: work in flight that a reload would cut
  off, which a sync then doesn't (below).

### App data across devices

With sync on, a session's app data syncs beside it on a branch of its
own, `appdata/<session>` (`app-data.js`): never in the session's
history, so never in a bundle or a gist. Two devices' writes settle
on the later. When another device's data arrives, a running app isn't
changed underneath the person: the preview offers to reload it. See
[sessions-and-storage.md](sessions-and-storage.md).

### Agent tasks from apps

`agex.task({ name, instructions, params, returns })`, the types as
JSON Schema, returns an async function; calling it posts `agex-task`
with the spec and the inputs. `app-tasks.svelte.js` (`appAgent`):

- checks the spec (`checkSpec`) and the inputs;
- rebuilds it as an agex-ts task (`agent.task`, its schemas through
  `fromJsonSchema`) on the viewer's model and key, at most 30 model
  calls (`TASK_STEPS`), in a world of its own (the worker, esm.sh,
  and `web` on an OpenRouter key), and returns the value, checked
  against `returns`;
- runs the person's own session's calls at once; a session opened from
  elsewhere (one with a `source`: a bundle or a published link) asks
  first, in the preview ("This app asks to use your model…"), each
  session's question its own (`asking[session]`), for the page's life
  (`allowed`);
- meters each call (`app-meter.js`): the task's model is wrapped
  (`metered`) so each reply's usage adds in as it arrives, and the call
  is listed once it ends. The meter is per session, in the studio's own
  `localStorage` (`agex-studio-meter:<name>`), not the session's store,
  where an undo would rewind it. Each change starts from what is
  stored, so tabs open on one session count together (a `storage`
  event refreshes the others). Deleting the session forgets it
  (`appAgent.forget`): its meter, and the page's say on its app; a call
  that began before writes nothing after;
- limits the rate, not the count: with the session's limiter on (the
  default), a call when `RATE.calls` (10) have started in the last
  minute waits (`paused[session]`) for the person: Keep going counts
  the minute afresh, and Stop refuses the app's calls (`stopped`) until
  they let them go on. A hidden test (`prompt: false`) is refused at
  once instead.

The preview's bar shows a meter button once the app has called (its
calls, or "paused"); it opens `AgentMeter.svelte`: the totals since the
last reset (calls, model calls, input, cached and output tokens), the
last ten calls, the limiter's switch, and Reset (count from zero, and
let a held app go on). The pause also shows in the preview, as the
consent question does. A call that can't run (no model, refused,
stopped, the task failed) rejects with a message the app can show.

### An app's own agent

`agex.model()` returns an agex-ts `Provider` (`name`
`agex-studio:viewer`), so an app can run agex-ts in its own page with
no key: `new Agent({ model: agex.model(), primer })`. Each `stream`
is one model call, relayed (`app-model.js`):

- the app posts `agex-model` (`id`, `messages`, `tools`, `settings`);
  the studio posts back `agex-model-event` (`id`, `event`) for each
  text or thinking delta and the Reply, as they arrive, then
  `agex-model-end` (`id`, `error`: null, or `{ name, message,
  transient, describe }`). The app's generator yields the events, and
  rebuilds a failure as an `Error`, whose `transient` and `describe`
  the provider's own `transient(error)` and `describe(error)` answer
  with: they are the viewer's provider's judgments, made in the studio
  (`AppModelError`).
- A stop crosses: the app's `signal` aborting, or its agent leaving the
  stream early, posts `agex-model-cancel`, and the studio aborts the
  call. A page replaced (`agex-bridge-ready` from the next one, a
  test's reload) or closed has its calls stopped (`cancelModels`), and
  so does deleting the session.
- `appAgent.model` runs it as the settings say now, on a model built
  for the call with its own session key (`<session>:app`, for the
  prompt cache), with the studio's thinking. The app's `maxTokens`
  (capped at 16,000; 8000 if it names none) and `temperature` go
  through; its provider-specific `extra` doesn't, since that could
  route the request to a model the viewer didn't choose.
- It asks as a task call does (the question says "for an agent of its
  own"), and goes on the same meter: each reply's usage adds in, and
  the calls are listed in bursts (`addModelCall`), one starting within
  30 s (`BURST_MS`) of the last one ending joining its entry, as
  `agex.model` with its model calls and tokens, so an entry is roughly
  one of the app's turns; each burst counts as one call. The studio
  sees model calls, not turns, so a burst is the nearest it can list.
  A stop isn't a failure.
- The limiter counts model calls on their own rate, `RATE.modelCalls`
  (60) a minute, beside the task calls' 10, since one turn of a chat
  makes several; past it, the same pause (its `model` flag says which),
  or a refusal for a hidden test.

### Requests with the viewer's keys

`agex.fetch(url, init)` is the app's own `fetch`, run in its frame,
unless the request names a secret (`${NAME}`, as in `Authorization:
Bearer ${STRIPE_KEY}`): only then does it go from the studio, whose
origin a service may trust where it wouldn't the app's. The shim posts
`agex-fetch` (the URL, method, headers as pairs, and body as a string
or bytes), and `answerFetch` (`app-fetch.js`) checks it against the
app's `app/agex.json` (`AppPage.needs`): a secret is filled only into
the header it declares, sent only to its declared origins, over
`https:`, never to the studio's or the apps' origins; a reference in
the URL, the query, the body or another header, one to an undeclared
secret, and one with no grant (`vault.valueFor`, the app's key from
`studio.appKey`) are refused before anything is sent. The request is
the world's `request` (no redirect followed, a 10 MB cap, a key the
response echoes replaced by its reference), with `credentials:
'omit'`. The reply (`agex-fetch-result`) becomes a `Response` in the
page; a refusal or failure rejects with a `TypeError` saying why. An
aborted signal posts `agex-fetch-cancel`, and a page replaced or
closed has its requests aborted (`cancelFetches`), as its model calls
are. A hidden test uses the app's grants too, and fails a request with
no grant rather than asking. It is unmetered: it spends the viewer's
key with a service, not their model.

### The app's database

`agex.db.query(sql, params?)` runs one statement as a transaction and
resolves with `{ rows, changes, lastInsertRowid }`;
`agex.db.transaction([[sql, params?] or sql, ...])` runs several as
one, all or none. Each posts `agex-db`, and the answer
(`agex-db-result`, from `answerDb` in `app-db-bridge.js`) carries the
value, or the error's name, message and, for a transaction, the failed
statement's `index`, which the shim rebuilds as an `Error`. Values
cross as they are: blobs as `Uint8Array`, integers past 2^53 as
`bigint`.

`agex.kvStore(name?)` is a kvgit `KVStore` in the same database, for a
store of the app's own (an agent's world): the rows of `_agex_kv`
(`store`, `k`, `v`, keyed by both) with its name, `default` without
one. Each call posts `agex-db` as the call `kv` and runs as one of the
procedures every tab's database worker serves (`app-kv.js`, kvsql's
`serve(open, { procedures })`): one transaction on the worker holding
the database, so `cas` and `casMany` read and write with nothing
between. The bridge makes the table when a call finds it missing (a
store's first call, or a restore to before it). It syncs as the
database does. kvgit writes almost every row once, under a hash, so
two devices' rows join up; only a branch's head rows conflict, when
both committed to it before syncing, and the person picks a side as for
any other rows.

The database is the one the preview's session names
(`appDbs.dbFor`, in `app-db-clients.js`), never one the message names.
A fork names its parent's, unless the person gave it a copy of its own
when forking (`appDbs.copyTo`: a kvsql logged copy, by the worker
holding the parent's database, under a random id, its log a branch
starting where the parent's stands). A delegate (`lead.scout`) uses
the top-level session's. It is kvsql's: a file in the origin-private file
system, served by the tab's database worker (`db-worker.js`), its
changes logged to a branch of the store. See the design,
[roadmap/app-db.md](../../roadmap/app-db.md). Deleting a session
leaves its database to the sessions still naming it; once none does
(its last one deleted for good, here or from the sync repo's trash), a
sweep deletes it here, file and log (`appDbs.sweepUnnamed`), after the
delete and at page load; the sync's sweep deletes its copy in the sync
repo too, and then its registry record. A tab with it open keeps it for
a later sweep. A device with a fork naming it that the registry didn't
know of yet uploads its own copy again when it syncs.

With sync on, a synced session's database syncs with it (`db-sync.js`,
driven by `sync.svelte.js`): after the session, ten seconds after an
app's last write (and a minute at most after its first, for an app
that keeps writing), and in every sweep. Two devices' changes rebase onto each
other; where they don't fit together, nothing changes until the person
picks a side, and the other is kept as a checkpoint. A database over
the cap stays on its device until the person allows it. Its log starts
a new epoch (a fresh snapshot) as it grows; an older epoch that synced
stays here until no device can still push to it (the sync deletes it
once the repo's copy is gone), and what older epochs, or a deleted
database's log, held is freed by a sweep of the store (`store-sweep.js`)
a minute after kvsql or the sync deletes them, and by one more an hour
on (a sweep keeps what was written in the hour before it). Until it
syncs, the browser's storage is its only copy, so when an app first
keeps data the studio asks the browser to make its storage persistent
(`navigator.storage.persist()`, in `persist.js`; Chromium decides by
how the site is used, Firefox asks the person). The session dialog
(`SessionDialog.svelte`) shows the database (its size, its tables, the
forks sharing it) and where its sync stands: synced, waiting, too
large (with a button to sync it anyway), failed (with a retry), or a
conflict with the two sides to pick from, which the session list shows
too. On a device without sync, it says the database is on this device
only, and offers to ask again for persistence when the browser hasn't
granted it. It exports the database as a `.sqlite` file (kvsql's
`export()`: the file without the log's own tables), and lists its
checkpoints, newest first, to restore (after a second click), delete,
or take another.

A restore (`appDbs.restore`) moves the database forward to its state at
the checkpoint, and the apps on it reload: `db-restore.svelte.js`
counts restores, here and, through a `BroadcastChannel`, in every tab,
and the preview reloads when one was its database's. The agent's
`db.restore(id)` first asks the person, as an app asks before spending
the viewer's key: the question shows above the app (its tab comes
forward), and a turn that ends before an answer takes it as a no.

A sync that brought another device's changes to the database (its
state's `moved`) is announced the same way, marked as a sync, and
reloads the apps on it too, unless an app has work in flight.
`agex.busy(promise)` marks some, and returns the promise: the page
counts the promises it was given that haven't settled (a rejection
settles one) and posts the count (`agex-busy`) as it changes, and the
preview keeps the last, back to 0 whenever a page loads. A sync that
finds it above 0 offers the reload in a bar above the app, as another
device's app data does; the offer stays once the work settles, until
the person takes it or the page loads again, since a reload then would
land as the person reads what the work did or types the next thing.
A restore reloads the app, busy or not: the person asked for it
(`afterDbChange` in `app-busy.js`). A test iframe ignores what the
page posts: nothing syncs its copy of the database.

## `test_app`

`testAppTool` (`test-app.js`) acts on the app in a browser:

- **By default**, `runTestApp` (`app-control.js`) builds the app from
  its files now into a fresh hidden iframe, its storage seeded from
  the session's (writes discarded; `fresh: true` starts empty), at a
  viewport (`desktop`, `tablet`, `mobile`, or a size). Each call has
  its own iframe and checks every message's source, so concurrent
  calls, a delegate's included, don't meet. An app's agent tasks, and
  its own agent's model calls, run for real, on the same meter; the
  iframe stays until every call,
  including one a result set off, has settled. Its `agex.db` is the
  test's own copy of the session's database (`appDbs.testDb`), made on
  the app's first call: a detached copy (kvsql's `copy`), which records
  nothing in any log, so a test never writes the person's. The worker
  holding the session's database, which may be another tab's, copies
  its file in OPFS to `agex-db-tests/<id>` (`test-dbs.js`); the call
  deletes it at the end, and the first copy a page makes sweeps the
  ones closed tabs left. A session with no database yet, or
  `fresh: true`, gets an empty one. Tool calls run one
  after another, so the files a call before it wrote are there.
- **`live: true`** acts on the preview the person sees
  (`getLiveIframe`), with the person's storage and database, once the preview has gone on with the files as
  they are (`whenLiveSettled`: no rebuild due from a write's debounce
  or under way). A delegate's `live` is refused: the preview shows the
  session that asked it.

Before the first action, the call waits for the app's first load
(`settleFirstLoad`): the page's document `load` (its module scripts
with their static imports, its images and styles), which the control
bridge reports (`agex-page-loaded`), then the app's calls to the studio
settling (`waitForIdle`, with a 1s gap). Past `LOAD_TIMEOUT_MS` (30s)
the actions run anyway and the result says so. Neither a dynamic
`import()` nor a `fetch` is counted: the page has no cheap way to see
a module fetch it didn't declare, and a long-lived fetch would hold
every action up. The live preview's page is waited for the same way
when it is still loading.

Actions run in order: `click`, `type`, `select`, `waitFor`,
`waitUntil`, `wait`, `read` (`innerText` or a property), `eval`,
`assert`, `screenshot` (a PNG in the result, seen by a model that takes
images), `viewport`, `reload`. The result lists the app's console
output, then each action's result.

An action that can't do what it asks fails loudly. `click`, `type` and
`select` poll for their target (1s, or the action's `timeout`) and
throw an `ActionError` when it never appears or is disabled (a
`select` value no option has, too); `waitFor` (a selector) and
`waitUntil` (an expression) throw one when their wait (5s) runs out.
`executeActions` ends the call at any error an action throws (an
`ActionError`, a failed `assert`, an unknown action), carrying the
results before it (`e.results`, a grid's frames among them), and the
tool returns them with the error. An `eval` that throws, a screenshot
that can't be drawn and a `soft` assert that fails come back as
results instead, and the run goes on; failed soft asserts are counted
at the end and make the result an error. A click is dispatched
pointer and mouse events at the element's center rather than
`el.click()`, so SVG elements take it, and a dispatched click keeps a
click's default actions (a submit, a checkbox, a label, a link).

The test iframe follows the studio's page: in a background tab the
browser pauses its animation frames and slows its timers. The tool
watches the studio's `visibilityState` through the call
(`watchHidden`) and adds a note to the result when it was hidden.

`{reload: true}` (not live) rebuilds the page from the same files in
the same iframe and waits for its first load again. A test page's
storage shim is read-only to the person's storage, but reports both
its stores to the test (`agex-test-storage`, which only the test's
listener takes, from its own frame); the next page is seeded with what
the test wrote (`reseedAppPage`, `sessionSeed` for `sessionStorage`,
which a browser keeps across a reload), and the console output of the
page before comes first in the result. The test's copy of the database
stays across the reload.

### When a page goes

`send-control.js` follows each frame's page (`pageUp` when its bridge
is ready, `pageLoaded` when its document loaded, `pageGone`). The
frame fires `load` for the bootloader and once more when the page
written into it has loaded, seconds after its bridge for an app with
cold imports: that second `load` is the page's own, not a navigation.
A `load` after it, or the bootloader saying `agex-host-ready` again,
means the page was replaced: the actions waiting fail at once with a
`NavigationError`, so do any sent after, and the call ends there,
rather than waiting out `sendControl`'s timeout. Why is in the
message: the app navigated or reloaded itself, or the studio replaced
the page (the preview rebuilt, or the person reloaded it), which is no
fault of the app's. The live preview answers the bootloader again, so
it takes actions once the app's bridge is back; a test's iframe
answers only a reload it asked for, and the next call builds a fresh
one.

A screenshot with a `grid` name (and a `label`) is held: at the end of
the call, `formatResults` tiles each grid's frames, in order, into one
captioned PNG (`grid.js`: 1 to 4 columns by count, every frame scaled
by one factor so the widest fits its column and none grows, within
1,600px wide, at most 12 a grid), so several states cost
the model one image. A failing assert carries the results before it
(`e.results`, with the console's output and under the same bounds as
a passing call's), so its grids, and its other screenshots, still
come back with the error.

Before a screenshot, `waitForFrame` lets the app paint a fresh frame
(a double `requestAnimationFrame`, with a timeout for a hidden tab,
where the browser pauses frames). The capture is html-to-image's (an
SVG `foreignObject`, drawn to a PNG), loaded from the apps origin's
`vendor/`. It leaves comment nodes out (a `--` in one, which HTML
allows, is invalid XML and fails the whole image), and fetches images
to embed with `cache: "no-store"` rather than html-to-image's
`cacheBust`, whose added query breaks a `blob:` asset URL.

### Size caps

Results flow into the model's context, so they are capped: 50 KB for
an `eval` value or a `read` (`iframe-bridge.js`), 50 KB per console
message (`CONSOLE_INTERCEPTOR`), and 256 KB in all (`collectResults`
drops the earliest entries, logs first, and says so).

## Play mode

`/run/?gist=<owner>/<id>/<slug>&play=1` opens a published session and
shows its app alone (`App.svelte`: `playing`), with a pill back to the
full view; until the gist's session is open it shows a loading line,
not the session last looked at. See
[sessions-and-storage.md](sessions-and-storage.md).
