# Interactive Apps

Build interactive browser apps that render in a live preview pane.
Write files to `app/` and they appear automatically when
`app/index.html` exists.

## Architecture

Your app runs in a sandboxed iframe with these affordances baked in
(no `<script>` tag needed for any of these):

- **React** — `import { useState } from 'react'` works (lightweight
  Preact-compat under the hood). Most React component libraries
  (Radix UI, Recharts, React Aria, etc.) work transparently via the
  same import.
- **Plotly.js** for charts — global `Plotly` (auto-injected).
- **marked** for Markdown rendering — `import { marked } from 'marked'`.
- **DOMPurify** for HTML sanitization — `import DOMPurify from 'dompurify'`.
- **dayjs** for date formatting — `import dayjs from 'dayjs'`.
- **`getCacheValue(key)` bridge** — global function that reads values
  the agent stashed via `cache.set(key, value)`. The way to pass data
  from your agent code to the running app.

## Quick start (recommended: plain JS, no build)

For the static / lightly interactive case, write plain HTML + ESM JS
in `app/`. No bundling step required — the import map resolves bare
`'react'`-style specifiers at runtime.

```html
<!-- app/index.html -->
<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
<div id="app"></div>
<script type="module" src="./index.js"></script>
</body></html>
```

```js
// app/index.js
import { h, render } from 'preact'
import { useState } from 'preact/hooks'
import htm from 'htm'

const html = htm.bind(h)

function App() {
  const [count, setCount] = useState(0)
  return html`
    <button onClick=${() => setCount(c => c + 1)}>
      Clicked ${count} times
    </button>
  `
}

render(html`<${App} />`, document.getElementById('app'))
```

(JSX requires a build step — `esbuild` support is planned but not yet
wired on the TS kernel. For now use HTM, `h(...)` calls, or plain DOM.
For pure-React syntax users: `htm` is JSX-compatible enough that LLMs
fluent in JSX adapt instantly — same shape, backtick template instead
of angle brackets.)

## Passing data from agent → app

Don't try to fetch the agent's data over HTTP — there's no server.
Use the cache bridge:

**Agent code (in your TS emission):**
```ts
cache.set('chartData', {
  x: ['Jan', 'Feb', 'Mar'],
  y: [12, 19, 8],
})
```

**App code (in `app/index.js`):**
```js
const data = await getCacheValue('chartData')
Plotly.newPlot('chart', [{ ...data, type: 'bar' }], { title: 'Sales' })
```

`getCacheValue` is a global; no import needed. Returns `null` if the
key isn't set. Values must be JSON-roundtrippable (postMessage's
structured-clone constraints) — strings, numbers, arrays, plain
objects, typed arrays. Stash before the user opens the preview;
the app reads on mount.

## Verifying your app — `test_app`

After writing app files, verify behavior **before** `taskSuccess` with
`test_app`:

```ts
const results = await test_app([
  { eval: 'document.querySelectorAll("li").length' },
  { eval: 'document.querySelector("#title").textContent' },
])
// results: array of { type: 'eval', expr, value } and { type: 'log', level, message }
```

Action shapes are documented in `test_app`'s description — flat array
of plain objects, NOT a Playwright callback. Keep the result reads
narrow (`querySelector` + textContent / getAttribute) so you don't
return giant blobs.

`test_app` runs against a hidden iframe of your **uncommitted** app
files, so you can verify changes within the same turn before
committing via `taskSuccess`.

### `assert` actions for one-shot self-verification

When you just want to gate `taskSuccess` on "the app rendered correctly,"
use `assert` actions. They evaluate a JS expression as truthy/falsy:
passes are silent, failures become `error`-level log entries.

```ts
const results = await test_app([
  { assert: 'document.querySelectorAll("li").length === 5',
    message: '5 list items rendered' },
  { assert: '!document.querySelector(".error")',
    message: 'no error state' },
])
const failures = results.filter(r => r.level === 'error')
if (failures.length) {
  taskFail(failures.map(f => f.message).join('\n'))
}
taskSuccess('App built and verified.')
```

Using assertions instead of raw `eval` reads keeps the success path
clean — you only pay attention to failures, and the agent's response
naturally surfaces what broke when something does. Use `assert` when
you have a known-good condition to check; use `eval` when you actually
need the value back to decide what to do.

## Inspecting the live preview — `live_app`

Once you've shipped (called `taskSuccess`), the user sees your app in
the preview pane. To read what they've selected/entered, use
`live_app` with the same action shape — operates on the live pane,
not a hidden test iframe.

```ts
const results = await live_app([
  { read: '#name-input', prop: 'value' },
  { read: '#status-message' },
])
```

## Multi-file apps and helpers

Beyond the single-file case, organize as:

- `app/index.html` — entry point
- `app/index.js` — main module
- `app/SomeComponent.js` — local module, import via `./SomeComponent`
- `helpers/foo.ts` — shared helper, import via `./helpers/foo` from
  later turns. Lives outside `app/`; not bundled into the preview.
  Use for code your TS emissions reuse, not for the iframe's runtime.

## Things that don't work

- **JSX / TSX without a build step** — esbuild is planned. For now,
  HTM is the closest substitute.
- **Bare `npm install <pkg>`** — your dependencies are fixed by the
  iframe's import map. React, Plotly, marked, DOMPurify, dayjs are
  in; arbitrary npm packages aren't.
- **Same-origin `fetch('/api/...')`** — there's no server. Use
  `getCacheValue` for agent-side data, hardcode external URLs (CORS
  permitting) for third-party APIs.
- **`document.write`** — sandboxed iframe rejects it. Use DOM mutation.
- **`window.parent.location`** — sandboxed; cross-origin guarded.

## Common patterns

**Filter widget over agent-supplied data:**
```js
const items = await getCacheValue('items')
const input = document.querySelector('#filter')
const list = document.querySelector('#results')
function render() {
  const q = input.value.toLowerCase()
  list.innerHTML = items
    .filter(it => it.name.toLowerCase().includes(q))
    .map(it => `<li>${it.name}</li>`)
    .join('')
}
input.addEventListener('input', render)
render()
```

**Plotly dashboard:**
```js
const data = await getCacheValue('series')
Plotly.newPlot('chart',
  data.map(d => ({ x: d.x, y: d.y, type: 'scatter', name: d.label })),
  { title: 'Trends', autosize: true })
```
