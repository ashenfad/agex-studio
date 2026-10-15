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
- **Calls are budgeted:** 20 a visit to begin with. Someone opening a
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
- `test_app` runs tasks for real, on the same budget: wait for the
  value (`{wait: 15000}`, then `{read: …}`) rather than assuming it.

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
  on it, and every reload would spend the budget again.
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

```json
{"actions": [
  {"click": "#inc"},
  {"click": "#inc"},
  {"read": "#inc"},
  {"assert": "document.querySelector('#inc').textContent.includes('2')", "message": "two clicks counted"},
  {"screenshot": true}
]}
```

- `{click: "#sel"}`, `{type: "#sel", value: "text"}`, `{select: "#sel", value: "opt"}`, `{wait: 500}`
- `{read: "#sel"}` or `{read: "#sel", prop: "value"}`: `textContent`, or a property
- `{eval: "expr"}`: a JS expression in the app's page; a Promise is awaited, so async work fits in one action
- `{assert: "expr", message: "..."}`: silent when it holds; a failing one ends the call with an error naming it
- `{screenshot: true}` or `{screenshot: "#sel"}`: a PNG of the page (or an element), **attached to this result**: you see it on your next step, in the same turn
- `{screenshot: true | "#sel", grid: "name", label: "after save"}`: held, and at the end of the call every frame of that grid comes back tiled into **one** image, each frame numbered and captioned with its label (up to 12 a grid; it comes back when an assert fails too)
- `{viewport: "mobile" | "tablet" | "desktop" | {width, height}}`: resize between actions

Actions are plain JSON objects, not a Playwright API: there's no `page`,
and functions can't be passed (use `eval` for in-page JS). Keep reads
narrow (`textContent`, an attribute); a DOM node comes back as a
description, not something you can click later.

Options beside `actions`:

- `viewport`: the iframe's starting size (default 800×600). Presets are
  `desktop` (1280×800), `tablet` (768×1024) and `mobile` (390×844).
- `fresh: true`: start with empty app storage (by default it is seeded
  from the person's, and the test's writes are thrown away).
- `live: true`: act on the preview **the person is looking at** instead,
  to read what they entered or selected, or to apply something to the
  open app. The preview shows the files as they are, so a change you just
  wrote is already in it.

Use `assert` for a known condition, `eval` when you need the value to
decide what to do, and a screenshot for layout and look; text checks are
cheaper and their failures more precise.

**Checks that mean something:**

- **Assert on what carries data:** a count that isn't `0`, a chart
  container with children, a table with rows. Static text renders even
  when every fetch failed, so a check of a heading proves nothing.
- **Exercise the flow:** click the filter, wait, and assert that the
  result changed, not only that the page loaded.
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
fit together; for a detail, take a plain screenshot of that element.

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
- **`npm install`**: there's no install step; esm.sh serves browser ESM
  packages, and anything needing Node or a native build won't work.
- **`fetch('/api/...')`**: there's no server; use the cache for your
  data, and full URLs (CORS permitting) for public APIs.
- **`SharedArrayBuffer` / threaded WASM**: the page isn't
  cross-origin-isolated.
- **`window.env`, `agex.fetch`, `app/agex.json`**: reserved for the
  studio's own use; don't define them in an app.
