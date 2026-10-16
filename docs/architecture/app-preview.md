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
page's HTML and its assets:

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
   whatever library the app uses. Plotly loads as a script, only for an
   app whose page or scripts name `Plotly`.
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
  `indexedDB` throws, saying to use `localStorage`. A test iframe's
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
- counts calls per session for the page's life (`budgets`): 20 at once
  (`APP_CALLS`) for the person's own session; a session opened from
  elsewhere (one with a `source`: a bundle or a published link) asks
  first, in the preview ("This app asks to use your model…"), each
  session's question its own (`asking[session]`).

The preview's bar shows the count ("agent 2/20") and, once spent,
"Allow 20 more". A call that can't run (no model, refused, budget
spent, the task failed) rejects with a message the app can show.

## `test_app`

`testAppTool` (`test-app.js`) acts on the app in a browser:

- **By default**, `runTestApp` (`app-control.js`) builds the app from
  its files now into a fresh hidden iframe, its storage seeded from
  the session's (writes discarded; `fresh: true` starts empty), at a
  viewport (`desktop`, `tablet`, `mobile`, or a size). Each call has
  its own iframe and checks every message's source, so concurrent
  calls, a delegate's included, don't meet. An app's agent tasks run
  for real, on the same budget; the iframe stays until every call,
  including one a result set off, has settled. Tool calls run one
  after another, so the files a call before it wrote are there.
- **`live: true`** acts on the preview the person sees
  (`getLiveIframe`), once the preview has gone on with the files as
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

Actions run in order: `click`, `type`, `select`, `wait`, `read`
(text or a property), `eval`, `assert` (a failure ends the call with
an error), `screenshot` (a PNG in the result, seen by a model that
takes images), `viewport`, `reload`. The result lists the app's
console output, then each action's result.

`{reload: true}` (not live) rebuilds the page from the same files in
the same iframe and waits for its first load again. A test page's
storage shim is read-only to the person's storage, but reports both
its stores to the test (`agex-test-storage`, which only the test's
listener takes, from its own frame); the next page is seeded with what
the test wrote (`reseedAppPage`, `sessionSeed` for `sessionStorage`,
which a browser keeps across a reload), and the console output of the
page before comes first in the result.

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
captioned PNG (`grid.js`: 1 to 4 columns by count, frames scaled to
fit within 1,600px wide, at most 12 a grid), so several states cost
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
