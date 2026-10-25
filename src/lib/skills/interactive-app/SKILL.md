---
name: interactive-app
description: Build interactive browser apps (dashboards, tools, games) that render in the studio's live preview, from files under /workspace/app, and check them with test_app.
---

# Interactive apps

An app is files under `/workspace/app`. Once `app/index.html` exists (or
`app/main.js`), it renders in the preview pane beside the chat, and the
preview rebuilds whenever its files change. Write them with `file_write`
and `file_edit`; check them with `test_app`.

## Where it runs

The app runs in an iframe on a separate origin (`apps.agex.studio`), so
it can't reach the studio's storage or page, and the studio can't reach
into it. **Any bare npm specifier resolves to esm.sh**: `import { Bar }
from 'recharts'` works with no build step. These are pinned and aliased,
so prefer them when they fit:

| Import | What it gives you |
| --- | --- |
| `'preact'` → `{ h, render, Fragment, ... }` | Raw Preact: the element factory, root render. |
| `'preact/hooks'` → `{ useState, useEffect, useRef, ... }` | Preact's hooks. |
| `'htm'` → default `htm` | JSX-like template literals, no build step: `const html = htm.bind(h)`. |
| `'react'` → preact-compat | A React-shaped surface, for React examples and libraries. **Doesn't export `h` or `render`**: those are on `'preact'`. |
| `'react-dom'`, `'react-dom/client'` | preact-compat shims. |
| `'marked'` → `{ marked }` | Markdown → HTML. |
| `'dompurify'` → default `DOMPurify` | HTML sanitization. |
| `'dayjs'` → default `dayjs` | Dates. |

Globals, no import needed:

- `Plotly`: Plotly.js. `Plotly.newPlot(div, traces, layout)`.
- `getCacheValue(key)`: read a value your code stashed with
  `await cache.set(key, value)` in `run_ts` (see "Data from you to the
  app").
- `agex.db`: the app's SQLite database, for the data it keeps (see
  "Keeping data: `agex.db`").
- `notify(title, body)`: a desktop notification (a timer done, a long
  job finished), shown by the studio only if the person has allowed
  notifications in its settings, at most 5 a minute. Resolves `true`
  if shown, `false` if not; it never throws, so show the news in the
  page too.

Pin a version when it matters (`'recharts@2.10.0'`). Only *static*
`import ... from '...'` statements are resolved, so `import(variable)`
isn't.

## A first app (no build step)

HTM + Preact is the lightest path: JSX-shaped templates, no bundler.

```html
<!-- app/index.html -->
<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="style.css">
</head>
<body>
<div id="app"></div>
<script type="module" src="./index.js"></script>
</body></html>
```

```js
// app/index.js
import { h, render } from 'preact'        // h and render are on 'preact', NOT 'react'
import { useState } from 'preact/hooks'
import htm from 'htm'

const html = htm.bind(h)

function App() {
  const [count, setCount] = useState(0)
  return html`<button id="inc" onClick=${() => setCount((c) => c + 1)}>Clicked ${count} times</button>`
}

render(html`<${App} />`, document.getElementById('app'))
```

For a trivial UI, plain DOM is fine too.

## The JSX path: `esbuild`

For real JSX (a tutorial component verbatim, a big tree), write `.jsx`
or `.tsx` and bundle it in the terminal:

```
esbuild app/index.jsx --outfile=app/bundle.js
```

and load `./bundle.js` from `app/index.html`. Bare imports stay external
(the iframe resolves them at run time), local imports are bundled,
`import ... from 'react'` runs on Preact, and source maps are inline so
errors point at your source. The first run downloads esbuild (~10 MB);
later ones take under a second. **Re-run it after every change**: the
page loads the bundle, not your source. `esbuild --help` lists the flags.

## Data from you to the app

There's no server, so nothing to fetch the agent's data from. Use the
cache: in `run_ts`,

```ts
await cache.set('chartData', { x: ['Jan', 'Feb', 'Mar'], y: [12, 19, 8] })
```

and in the app,

```js
const data = await getCacheValue('chartData')   // null if it isn't set
Plotly.newPlot('chart', [{ ...data, type: 'bar' }], { template: 'plotly_dark' })
```

Values must survive structured cloning (strings, numbers, arrays, plain
objects, typed arrays). It works for config too: a theme object read at
mount and applied as CSS variables lets you restyle without rewriting
files. To apply a new one to the open preview at once, re-run the apply
step with `test_app` and `live: true` (`{eval: ...}`), rather than
reloading the page.

## Keeping data: `agex.db`

For data the app keeps (records, entries, scores, history: anything
that grows, or that you'd filter and sort), use `agex.db`, the
session's SQLite database, kept by the studio. `localStorage` is for
small settings (5 MB in all).

```js
await agex.db.query(`CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL
)`)
const { lastInsertRowid } = await agex.db.query(
  'INSERT INTO tasks (title, created) VALUES (?, ?)', [title, Date.now()])
const { rows } = await agex.db.query(
  'SELECT id, title FROM tasks WHERE done = 0 ORDER BY created DESC LIMIT 50')
await agex.db.transaction([
  ['UPDATE accounts SET balance = balance - ? WHERE id = ?', [10, 'a']],
  ['UPDATE accounts SET balance = balance + ? WHERE id = ?', [10, 'b']],
])
```

- **`query(sql, params?)`** resolves with `{ rows, changes,
  lastInsertRowid }`: rows as objects, blobs as `Uint8Array`, integers
  past 2^53 as `bigint`. Bind values with `?` and an array; never build
  SQL from strings.
- **Each call is a transaction of its own;** `transaction([[sql,
  params], ...])` runs several as one, all or none. `BEGIN` and
  `COMMIT` are refused. A failure rejects with SQLite's message (in a
  transaction, `err.index` is the statement that failed): catch it and
  show it.
- **Every table needs a primary key whose columns are `NOT NULL`**
  (`id INTEGER PRIMARY KEY NOT NULL`, or `TEXT PRIMARY KEY NOT NULL`
  for ids you make): one without is refused. Not available: `ATTACH`,
  `VACUUM`, virtual tables (FTS5, R*Tree), `TEMP` triggers, and pragmas
  that change how the file is stored. Each refusal says what to do
  instead. Foreign keys are enforced (`REFERENCES ... ON DELETE
  CASCADE` works).
- **A call that changes the schema** (`CREATE`, `ALTER`, `DROP`,
  `PRAGMA user_version = n`) is recorded as its SQL and run again
  wherever the database is rebuilt, so it can't use `random()` or the
  clock (`datetime('now')`, `CURRENT_TIMESTAMP`). Change the schema in
  one call and write rows in another, and make times in JS
  (`Date.now()`) and pass them in.
- **Create the schema on load** with `CREATE TABLE IF NOT EXISTS` (and
  `CREATE INDEX IF NOT EXISTS`): one that changes nothing costs nothing.
  **Change an existing schema with `user_version`**, each step once:

  ```js
  const { rows: [{ user_version: v }] } = await agex.db.query('PRAGMA user_version')
  if (v < 1) await agex.db.transaction([
    ['ALTER TABLE tasks ADD COLUMN due INTEGER'],
    ['PRAGMA user_version = 1'],
  ])
  ```
- **It's the person's data.** It outlives your edits to the app, an
  undo doesn't rewind it, and a fork of the session shares it unless
  the person gave the fork a copy of its own. So
  migrate what's there rather than dropping tables to start over, and
  ask before deleting the person's rows to fix a bug.
- **Read what you show:** `WHERE`, `ORDER BY` and `LIMIT` in SQL, not
  a whole table filtered in JS. A database can hold far more than a
  page should load. Add an index for a column you filter or sort a
  large table by.
- **It syncs with the session:** with sync on, another device opening
  the session gets the same data, and the app reloads when its data
  changes underneath it (a sync, a restore), so read state from the
  database when the page loads rather than keeping it only in memory.
  When two devices changed the same rows, the person picks a side in
  the session's dialog. They can also export it as a `.sqlite` file
  there.

**What it suits, and what it doesn't.** Build to its strengths:

- **Well supported:** what a person makes and keeps at a person's pace:
  tasks, notes, journals, trackers, collections, contacts, budgets,
  game saves. Thousands of rows a day and tens of MB are comfortable.
  A query takes a millisecond or two even on a large database, so read
  from it as the page needs rather than caching it all in memory.
- **Fine, written well:** state that changes fast here (a game loop, a
  slider, a timer saving each second): repeated updates of the same
  rows cost little. Bulk data (an import, a generated dataset, a
  backfill) goes in as one `transaction([...])` or one `INSERT ...
  SELECT`, not a call per row: a thousand rows take ~15 ms as one call
  and over a second as a thousand.
- **Poor fits:**
  - *Live sharing between devices* (chat, presence, cursors, a game
    two people play at once): sync is periodic, about a minute at most
    while an app keeps writing, and two devices changing the same rows
    meet a conflict the person settles. It suits one person on several
    devices, not several people at once.
  - *Media as blobs* (images, audio, video, big documents): every copy
    and every sync carries them. Store a URL, or a small thumbnail.
  - *Hundreds of MB, or a large database rewritten again and again:*
    when its changes reach about half its compressed size, the whole
    database uploads again, and a new device downloads all of it; over
    1 GB it stays on the device unless the person allows its sync.
    Keep what the person made, and recompute or refetch what's derived
    (caches, imported reference data) rather than storing it.
  - *Logging without end* (a row every few ms, kept forever): prune old
    rows, or keep a summary.

**From your own code, `db` is the same database:** in `run_ts`,
`await db.query('SELECT count(*) AS n FROM tasks')` reads what the app
stored, with the same `query` and `transaction`. Use it to look at the
data, debug, and seed or migrate it when the person asks; the app
shows a change the next time it reads.

**Checkpoints** are points to bring the data back to. The database
takes one itself before every schema change (from the app or from
you), labelled with the statement, and keeps the last 10. Take your
own before a bulk change to rows, which no schema change precedes:
`await db.checkpoint('before the date backfill')`. `await
db.checkpoints()` lists them, oldest first (`{ id, label, auto, time
}`). `await db.restore(id)` brings the data back to one and discards
everything written since, the person's own use of the app included,
so the person is asked in the app's tab first; if they say no, it
throws, and you leave it unless they ask. After a restore the app
reloads. Restoring past a schema change brings the old schema back,
so the app's code must still read it, or be changed back too.

`test_app` gives the app **a copy of the person's database** as it is
at the call (kept across `{reload: true}`, gone after the call), so a
test runs on real data and still never changes it: write freely, even
migrate, and check the result. `fresh: true` gives an empty database
instead; seed what a test needs from its actions (`{eval:
"agex.db.query(...)"}`). With `live: true` the app is on the person's
database, and what a test writes there stays: write only when the
person asked.

## An agent in the app: `agex.task`

An app can call an agent: for what code can't do well (summarize,
classify, extract, write, answer about the web). Define a task as you
would in run_ts, its inputs and value as JSON Schema, and call it with
an object of its inputs:

```js
const summarize = agex.task({
  name: 'summarize',
  instructions: 'Summarize the text in two plain sentences.',
  params: { text: { type: 'string' } },
  returns: { type: 'string' },
})

button.onclick = async () => {
  out.textContent = 'Thinking…'
  try {
    out.textContent = await summarize({ text: input.value })
  } catch (e) {
    out.textContent = `Couldn't: ${e.message}`
  }
}
```

- **It runs on the viewer's model and key,** in a world of its own
  (with `web` when their key is OpenRouter's), and takes seconds: show
  that something is happening, and keep the button from being pressed
  again meanwhile.
- **Calls are metered, and a loop is paused:** the person sees what
  the app's calls use, and more than 10 calls inside a minute pauses
  them until the person says to go on. Someone opening a
  shared app is asked first whether it may use their model; they can
  refuse, and anyone may have no model chosen. A call that can't run
  rejects saying why: catch it and show it, and leave the rest of the
  app working.
- **Ask for structure** when the app reads the value: `returns: {type:
  'object', properties: {…}, required: […]}`, and the value comes back
  checked against it. **A field with fixed choices gets an `enum`**
  (`{type: 'string', enum: ['bug', 'feature', 'question']}`), not a
  string and a comment: the answer is checked against it, so the app
  never sees a value outside the choices.
- `test_app` runs tasks for real, on the person's meter: wait for the
  value (`{wait: 15000}`, then `{read: …}`) rather than assuming it. A
  test has nobody to ask, so past 10 calls in a minute its calls are
  refused rather than paused.

Designing one:

- **Use it for judgment, not logic.** Classifying, extracting fields
  from free text, summarizing, rewriting, scoring: work whose answer is
  language. Anything code can compute, compute.
- **The helper knows only what the call gives it:** its instructions
  and its inputs. It sees none of the app, the session or this
  conversation, so instructions that say "as discussed" leave it
  guessing; put everything it needs in them.
- **Call it from a person's action** (a button, a form), never on load
  or from code that re-runs (a render, an effect): the page would wait
  on it, and every reload would spend the person's key again.
- **Keep what you got.** Store answers in `localStorage`, and answer a
  repeat from there before calling. Key each by the task's definition
  as well as its input (`` `triage:${JSON.stringify(spec)}:${input}` ``,
  or a version you bump), since app storage outlives your edits: an
  answer kept under the input alone comes back unchanged after you
  change the instructions or the `returns`. Several inputs at once:
  `Promise.all` runs the calls together (each counts).
- **Show the answer as text** (`textContent`, or a template's
  `${value}`), never through `innerHTML`: a model's text can hold
  markup, and the input it read may have been written to put it there.

## Checking your app: `test_app`

After writing the app, **check it before you say it's done.** `test_app`
builds the app from its files as they are now in a hidden iframe, runs
your actions in order, and returns the app's console output and each
action's result.

Before the first action it waits for the page to load (its scripts and
their static imports: a first import from esm.sh can take seconds), then
for the app to settle, so there's no need to wait or poll for a "ready"
element first. A dynamic `import()`, a `fetch` or a timer the app starts
isn't waited for: `{waitFor: "#sel"}` or `{waitUntil: "expr"}`, then
read. If the page still hasn't loaded after 30s, the actions run anyway
and the result says so.

```json
{"actions": [
  {"click": "#inc"},
  {"click": "#inc"},
  {"read": "#inc"},
  {"assert": "document.querySelector('#inc').textContent.includes('2')", "message": "two clicks counted"},
  {"screenshot": true}
]}
```

- `{click: "#sel"}`, `{type: "#sel", value: "text"}`, `{select: "#sel", value: "an option's value"}`: each waits up to 1s for its target (`timeout: ms` to change that); a target that never appears, or is disabled, ends the call with an error naming it. A click is real pointer and mouse events, so an SVG element (a `<g>`, a `<circle>`) takes it like a button
- `{waitFor: "#sel"}` (until the selector matches) or `{waitUntil: "expr"}` (until the expression is true; a throw counts as not yet): up to 5s, `timeout: ms` to change it; running out ends the call with an error. `{wait: 500}` sleeps, for when there's nothing to wait for
- `{read: "#sel"}` or `{read: "#sel", prop: "value"}`: its `innerText` (the text as shown), or a property (`prop: "textContent"` for the raw text)
- `{eval: "expr", label: "setup"}`: a JS expression in the app's page; a Promise is awaited, so async work fits in one action. The optional `label` names it in the result in place of its code
- `{assert: "expr", message: "..."}`: silent when it holds; a failing one ends the call with an error naming it. With `soft: true` a failure is reported and the actions go on; the call then ends as an error saying how many soft asserts failed
- `{screenshot: true}` or `{screenshot: "#sel"}`: a PNG of the page (or an element), **attached to this result**: you see it on your next step, in the same turn
- `{screenshot: true | "#sel", grid: "name", label: "after save"}`: held, and at the end of the call every frame of that grid comes back tiled into **one** image, each frame numbered and captioned with its label (up to 12 a grid; it comes back when an action fails too)
- `{viewport: "mobile" | "tablet" | "desktop" | {width, height}}`: resize between actions
- `{reload: true}`: reload the page (rebuilt from the same files), keeping what this test wrote to `localStorage`, `sessionStorage` and its `agex.db`, and wait for it to load again: checks that what the app saves comes back. The person's storage and database are never written

Actions are plain JSON objects, not a Playwright API: there's no `page`,
and functions can't be passed (use `eval` for in-page JS). Keep reads
narrow (one element's text, an attribute); a DOM node comes back as a
description, not something you can click later.

Options beside `actions`:

- `viewport`: the iframe's starting size (default 800×600). Presets are
  `desktop` (1280×800), `tablet` (768×1024) and `mobile` (390×844).
- `fresh: true`: start with empty app storage (by default it is seeded
  from the person's, and the test's writes are thrown away).
- `live: true`: act on the preview **the person is looking at** instead,
  to read what they entered or selected, or to apply something to the
  open app. A change you just wrote is in it: the call waits for the
  preview to rebuild and load. `viewport` and `reload` aren't available
  live.

Use `assert` for a known condition, `eval` when you need the value to
decide what to do, and a screenshot for layout and look; text checks are
cheaper and their failures more precise. An action that fails ends the
call there, with the results before it (and its grid); an `eval` that
throws is reported and the actions go on.

**Timing:**

- **Wait for the render, not a guess:** after an `eval` or a click that
  changes state, the DOM updates a moment later. `{waitFor: "#tab-dark"}`
  (or `{waitUntil: "!document.querySelector('#buy').disabled"}`) before
  reading or clicking what it renders; a fixed `{wait: 200}` passes alone
  and fails in a long run.
- **The app's clock keeps running between actions:** a value driven by
  a timer moves while the test reads it. Assert with a tolerance
  (`Math.abs(heat() - 5) < 0.5`), or expose a hook to pause or step it
  (`window.engine.tick(dt)`) and test with that.
- **The studio's window has to be at least partly visible:** in a
  background tab (or a window covered entirely) the browser stops
  `requestAnimationFrame` and slows timers to about one a second, so a
  rAF loop doesn't run and timings stretch. The result says when this
  happened: don't trust its timing, and ask the person to keep the
  studio window showing while you test again.
- **Many checks in one call:** `soft: true` on the asserts reports every
  failure rather than stopping at the first.

**Checks that mean something:**

- **Assert on what carries data:** a count that isn't `0`, a chart
  container with children, a table with rows. Static text renders even
  when every fetch failed, so a check of a heading proves nothing.
- **Exercise the flow:** click the filter, wait for the result
  (`waitFor`), and assert that it changed, not only that the page loaded.
- **Check that saved data survives a reload:** change something,
  `{reload: true}`, then read it back.
- **Check a phone too:** `{viewport: "mobile"}` and a screenshot (a grid
  beside the desktop one, below) catch layouts that only fit wide.
- **Fill inputs with `type` and `select`,** not by setting `.value`
  from `eval`: Preact and React don't see that change, and the app
  acts on what it had before.
- **Give every control a stable `id`** (or `data-key`), so a check can
  find it, and keeps finding it after a restyle.
- **An empty result is a state to show,** not an error: a filter that
  matches nothing renders "nothing matches", with the controls still
  there. Check it.
- **If an assert fails, fix the app, not the assert.** A weakened
  check (`x !== '0' || x === '0'`) verifies nothing.
- **Grow in verified steps:** one control and one number working, then
  the rest. Keep each file small enough to rewrite when an edit gets
  hairy.

Your report says what you checked, quoting the asserts, not "it works".

**Several states at once:** put their screenshots in a grid, and they
come back as one image (one image to look at, and to pay for, rather
than one per state). Responsive layouts, in one call:

```json
{"actions": [{"viewport": "desktop"}, {"screenshot": true, "grid": "shapes", "label": "desktop"}, {"viewport": "mobile"}, {"screenshot": true, "grid": "shapes", "label": "mobile"}]}
```

Steps of a flow, or the scenes of an animation, the same way: act,
screenshot into the grid, act again. A grid's frames are scaled down to
fit together, all by the same factor, so a phone beside a desktop keeps
its size against it; for a detail, take a plain screenshot of that
element.

**What a screenshot is:** the page's DOM drawn again into an image (an
SVG `foreignObject`), not a capture of the screen. It is close, not
exact: text can wrap a little differently (emoji, inline chips, tight
buttons), and a `position: fixed` element is drawn against the page,
not pinned to the visible screen. When a screenshot looks wrong in a
way like that, measure before changing the app: `read` the text, or
`eval` an element's `getBoundingClientRect()`.

Each resize fires a real `resize`; an app that reads `innerWidth` only at
startup won't relayout, so for those pass `viewport` to start at a size.

**Canvas and animation:** a frame is painted before each screenshot, so
a canvas shows its current state. Painting doesn't advance time: to step
a game or simulation deterministically, expose `window.engine.tick(dt)`
and drive it with `eval` before the screenshot.

## Browser features

The iframe is granted a generous `allow=` list, so the app can use
features that are usually blocked in third-party frames. Some prompt the
person on first use. Wrap them in try/catch: `NotAllowedError` means
they said no, so offer a "tap to enable" path.

- **microphone / camera**: `navigator.mediaDevices.getUserMedia(...)`
- **geolocation**: `navigator.geolocation.getCurrentPosition()`
- **motion sensors**: `DeviceOrientationEvent` (on iOS, call `requestPermission()` from a tap first)
- **midi**, **fullscreen** (`el.requestFullscreen()`), **screen wake lock** (re-acquire on `visibilitychange`)
- **autoplay**, **web share** (from a tap), **downloads** (`<a download>` on a blob URL)
- **clipboard write** (from a click; reading the clipboard isn't granted)

## Styling

The preview's background is dark (`#1a1a2e`); style for it, since a
light app looks broken in the pane.

```css
body { font-family: system-ui, -apple-system, sans-serif; background: #1a1a2e; color: #e0e0e0; padding: 1rem; margin: 0; }
input, select, button { background: #0f3460; color: #e0e0e0; border: 1px solid #1a3a6e; border-radius: 4px; padding: 0.4rem 0.6rem; font-size: 16px; min-height: 44px; }
button { cursor: pointer; }
```

Use `template: 'plotly_dark'` for charts. For phones: the viewport meta
tag, layouts that wrap (`flex-wrap: wrap`), chart heights in `vh` with a
minimum, 44px touch targets, and `font-size: 16px` on inputs (iOS zooms
otherwise).

## More than one file

- `app/index.html`, `app/index.js`, and modules beside them, imported as
  `./Chart.js`.
- `app/style.css`, linked from the page.
- Images, fonts, audio, and data files (`.json`, `.csv`, `.txt`, …)
  under `app/`, referenced by relative path in HTML
  (`<img src="logo.png">`), CSS (`url('hero.jpg')`) and
  `fetch('data.csv')`; they're served to the page when the app is
  built. `window.appAssets` maps each path to its URL: use it for a
  path your script sets at run time
  (`new Audio(appAssets['theme.mp3'])`, an `innerHTML` string,
  `img.src = …`), which the build doesn't see.
- `helpers/` for code your own `run_ts` calls reuse; it isn't part of the
  app (esbuild can bundle from it).

## Web workers

For heavy work that would freeze the page (simulations, parsing, big
loops), name a file `*.worker.js` under `app/`: it's bundled as a module
worker, and `appWorker('sim.worker.js')` starts it. Pair it with Comlink:

```js
// app/sim.worker.js
import * as Comlink from 'comlink'
Comlink.expose({ step(state, n) { /* heavy loop */ return state } })

// app/index.js
import * as Comlink from 'comlink'
const sim = Comlink.wrap(appWorker('sim.worker.js'))
const next = await sim.step(state, 1000)
```

A worker computes only: `getCacheValue` and the storage shim live on the
page. Arguments and results must be structured-cloneable.

## What doesn't work

- **`location.reload()` or navigating away**: the app is injected into
  the sandbox's page, not served at a URL, so navigating tears it down.
  Reset your state and re-render instead.
- **`document.write`**: it wipes the running app.
- **IndexedDB**: it isn't available (every use throws). Keep data in
  `agex.db`, and small settings in `localStorage`, which the studio
  keeps for the app, up to 5 MB in all (measured as its JSON);
  `sessionStorage` lasts while the page is open.
- **`npm install`**: there's no install step; esm.sh serves browser ESM
  packages, and anything needing Node or a native build won't work.
- **`fetch('/api/...')`**: there's no server; use the cache for your
  data, and full URLs (CORS permitting) for public APIs.
- **`SharedArrayBuffer` / threaded WASM**: the page isn't
  cross-origin-isolated.
- **`window.env`, `agex.fetch`, `app/agex.json`**: reserved for the
  studio's own use; don't define them in an app.
