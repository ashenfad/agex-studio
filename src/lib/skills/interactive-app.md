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

**Responsive layouts:** one call can shoot every shape:

```json
{"actions": [{"viewport": "desktop"}, {"screenshot": true}, {"viewport": "mobile"}, {"screenshot": true}]}
```

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
- Images, fonts, audio and other assets under `app/`, referenced by
  relative path in HTML (`<img src="logo.png">`), CSS (`url('hero.jpg')`)
  and `fetch('data.csv')`; they're inlined when the app is built.
  `window.appAssets` maps each path to its data URL.
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
