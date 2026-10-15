# App preview

An app is files under `/workspace/app`. The preview pane renders it in
an iframe beside the chat, `test_app` builds the same page in hidden
iframes for the agent to check, and play mode shows a published app
alone. All three assemble the page with `buildAppHtml`
(`app-html.js`) and load it on a separate origin.

## A separate origin

`AppPreview.svelte` and `app-control.js`'s test iframes load a
bootloader from `APPS_ORIGIN` (`apps-origin.js`: `apps.agex.studio` in
production, `VITE_APPS_ORIGIN` to point at a local copy of the
agex-studio-apps repo), at `{APPS_ORIGIN}/?t={timestamp}` so each load
reloads it. The handshake is two messages: the bootloader posts
`agex-host-ready` once it listens, and the studio answers with
`agex-host-init` carrying the built HTML, which the bootloader writes
in as its document.

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

`buildAppHtml(appFiles, { appBinaries, appStorage })`:

1. Takes `app/index.html`, or for an app with only a main script, a
   page that loads it.
2. Encodes binary assets as data URLs (`app-assets.js`) and rewrites
   the references the HTML and CSS make to them; `window.appAssets`
   maps each path to its data URL, and `fetch('logo.png')` is patched
   to resolve. A path a script sets at run time uses `appAssets`.
3. Inlines CSS files, and gives each JS file a data URL in an import
   map, rewriting the app's own imports to it (`__app/…`). Bare
   imports go to esm.sh, with pinned entries for preact (and `react`
   as `preact/compat`), htm, marked, dayjs and dompurify; Plotly loads
   as a script, preloaded once per page.
4. Bundles `*.worker.js` files with esbuild into module sources,
   started with `appWorker(name)`.
5. Injects, ahead of the app's own code: the console interceptor,
   the storage shim, the assets script, the worker registry, the host
   bridge, the control bridge, and the import map.

## What the app can ask of the studio

The host bridge (`HOST_BRIDGE_SCRIPT`) gives the page:

- **Storage**: `localStorage` is a shim seeded with the session's
  app data (`app-storage.js`: the studio's `localStorage` under
  `agex-app:ts:<session>:`), capped at 5 MB. Each change posts the
  whole bag (`agex-app-storage`); the preview writes it a moment later
  and tells sync (`sync.appChanged`). `sessionStorage` is in memory;
  `indexedDB` throws, saying to use `localStorage`. A test iframe's
  shim is read-only.
- **The cache**: `getCacheValue(key)` reads a value the agent's code
  put in its cache (`cache.set`).
- **`notify(title, body)`**: resolves false for now; notifications
  aren't wired.
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
  including one a result set off, has settled.
- **`live: true`** acts on the preview the person sees
  (`getLiveIframe`). A delegate's `live` is refused: the preview shows
  the session that asked it.

Actions run in order: `click`, `type`, `select`, `wait`, `read`
(text or a property), `eval`, `assert` (a failure ends the call with
an error), `screenshot` (a PNG in the result, seen by a model that
takes images), `viewport`. The result lists the app's console output,
then each action's result.

A screenshot with a `grid` name (and a `label`) is held: at the end of
the call, `formatResults` tiles each grid's frames, in order, into one
captioned PNG (`grid.js`: 1 to 4 columns by count, frames scaled to
fit within 1,600px wide, at most 12 a grid), so several states cost
the model one image. A failing assert carries the results before it
(`e.results`), so its grids, and its other screenshots, still come
back with the error.

Before a screenshot, `waitForFrame` lets the app paint a fresh frame
(a double `requestAnimationFrame`, with a timeout for a hidden tab,
where the browser pauses frames).

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
