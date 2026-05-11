# Interactive Apps

Build interactive browser apps that render in a live preview pane.
Write files to `app/` and they appear automatically when
`app/index.html` exists.

## Architecture

Your app runs in a sandboxed iframe with a fixed import map and a
few injected globals. **Don't guess at module names** — only what's
listed below resolves.

### Import map (use these specifiers, no build step required)

| Import | What it gives you |
| --- | --- |
| `'preact'` → `{ h, render, Fragment, ... }` | Raw Preact — element factory, root render, etc. |
| `'preact/hooks'` → `{ useState, useEffect, useCallback, useRef, ... }` | Preact's hooks. |
| `'htm'` → default `htm` | JSX-like template literals (no build step). Bind to `h` to get `html`\`...\` syntax. |
| `'react'` → re-exports preact-compat | React-shaped surface (`useState`, `useEffect`, `createElement`, etc.). Use this when you're following a React example or a React component library expects it. **Does NOT export `h` or `render`** — those live on raw `preact`. |
| `'react-dom'`, `'react-dom/client'` | preact-compat shims. |
| `'marked'` → `{ marked }` | Markdown → HTML. |
| `'dompurify'` → default `DOMPurify` | HTML sanitization. |
| `'dayjs'` → default `dayjs` | Date formatting. |

Plus these globals (no import needed):

- `Plotly` — Plotly.js (auto-injected). Use `Plotly.newPlot(div, traces, layout)`.
- `getCacheValue(key)` — read values the agent stashed via
  `cache.set(key, value)`. The way to pass data from your agent
  code to the running app.

**Bare `import ... from 'lodash'` (or any other unlisted package)
will fail to resolve.** If you need something else, write it
inline or check whether it's already covered by the above (e.g.,
date math via `dayjs` instead of `date-fns`).

## Quick start (no build step required)

For most apps, **HTM** + **Preact** is the lightest path: JSX-shaped
template literals with no build step, no bundler, no source maps to
manage. The pattern is `htm.bind(h)` once, then write
`html\`<Foo />\`` everywhere instead of `<Foo />`.

(If you need real JSX — e.g., copying a component from a tutorial
verbatim — see the "JSX path" section below for the `esbuild` flow.)

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
import { h, render } from 'preact'           // ← `h` and `render` are on 'preact', NOT 'react'
import { useState } from 'preact/hooks'      // ← hooks live on 'preact/hooks'
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

**Common gotcha**: importing `h` or `render` from `'react'` fails —
those are raw Preact exports, not on the React-compat shim. Use
`'preact'` for those, `'preact/hooks'` for `useState` / `useEffect` /
etc., and `'react'` only when a third-party React component library
expects it.

For trivial UIs where Preact is overkill, plain DOM is fine:
```js
// app/index.js
const root = document.getElementById('app')
root.innerHTML = '<button id="btn">Click me</button>'
let count = 0
document.getElementById('btn').addEventListener('click', () => {
  count++
  document.getElementById('btn').textContent = `Clicked ${count} times`
})
```

## JSX path (`esbuild`)

When you want real JSX (copying a tutorial component verbatim, JSX
ergonomics for a complex tree, etc.), use the `esbuild` terminal
command. Bundles `app/`-and-`helpers/` sources into a single ES
module the iframe can load directly.

```html
<!-- app/index.html -->
<!DOCTYPE html><html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
</head><body>
<div id="app"></div>
<script type="module" src="./bundle.js"></script>
</body></html>
```

```jsx
// app/index.jsx
import { render } from 'preact'
import { useState } from 'preact/hooks'

function App() {
  const [count, setCount] = useState(0)
  return (
    <button onClick={() => setCount(c => c + 1)}>
      Clicked {count} times
    </button>
  )
}

render(<App />, document.getElementById('app'))
```

Then bundle:

```
esbuild app/index.jsx --outfile=app/bundle.js
```

How it works:
- **Bare imports** (`react`, `preact`, `@radix-ui/...`) stay external
  — the iframe's import map resolves them at runtime, so the bundle
  only contains your local code.
- **Local imports** (`./Chart.jsx`, `../helpers/util.ts`) are bundled
  inline. JSX/TSX/JS/TS/CSS/JSON/SVG all supported. Image imports
  (`./logo.png`) are inlined as data URLs (≤1MB each).
- The JSX `automatic` runtime targets `react/jsx-runtime`, which the
  iframe import map aliases to `preact/jsx-runtime`. So you can write
  `import {...} from 'react'` in JSX and it ends up running on Preact.
- Source maps are inlined by default — runtime errors point back at
  your `.jsx` source.
- First `esbuild` invocation downloads ~10MB of wasm; subsequent
  builds are sub-second.

Re-run `esbuild` whenever you change source. The iframe loads
`bundle.js`, not `index.jsx`, so a re-bundle is required for changes
to take effect.

`esbuild --help` for the full flag list.

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

**The bridge isn't data-only.** Theme objects, layout config,
feature flags — anything you'd otherwise bake into `app/styles.css`
or hard-code in the app's JS — work just as well. Visual config in
particular is worth thinking about, since CSS variables read at
mount let the agent change a theme without rewriting any files:

```ts
// Agent code
cache.set('theme', { accent: '#7c3aed', radius: '12px', glow: '0 0 24px rgba(124,58,237,0.4)' })
```

```js
// app/index.js, before render
const theme = (await getCacheValue('theme')) || {}
const root = document.documentElement
for (const [k, v] of Object.entries(theme)) {
  root.style.setProperty(`--${k}`, v)
}
// then in styles.css: `color: var(--accent)`, etc.
```

The app picks up the new theme on next reload (or call `liveApp([{eval: 'location.reload()'}])` after `cache.set` to apply
immediately).

## Verifying your app — `testApp`

After writing app files, verify behavior **before** `taskSuccess` with
`testApp`:

```ts
const results = await testApp([
  { eval: 'document.querySelectorAll("li").length' },
  { eval: 'document.querySelector("#title").textContent' },
])
// results: array of { type: 'eval', expr, value } and { type: 'log', level, message }
// `value` is the native JS the expression evaluated to — number, string,
// plain object, array, etc. No need to JSON.parse it.
```

Action shapes are documented in `testApp`'s description — flat array
of plain objects, NOT a Playwright callback. Keep the result reads
narrow (`querySelector` + textContent / getAttribute) so you don't
return giant blobs. (DOM nodes / functions / circular refs are
replaced with descriptive strings on the way back — don't try to
return an `Element` and click it from the agent side.)

`testApp` runs against a hidden iframe of your **uncommitted** app
files, so you can verify changes within the same turn before
committing via `taskSuccess`.

**Two timing rules to keep straight:**

- **Action results returned via `await`** (`eval`, `read`, `assert`)
  → visible **this turn**, in the result array. Inspect, decide, act.
- **Image observations from `screenshot`** + **console output**
  emitted from inside `testApp` → visible **next turn**, as
  observations in your context. Don't `taskSuccess` immediately if
  you intended to look at them. (See the screenshot section below
  for the canonical "capture, then commit" pattern.)

### Screenshots — visually verify the rendered app

`testApp` can capture a PNG of the rendered iframe and ship it as an
image observation:

```ts
await testApp([
  { screenshot: true },                       // full doc
  // or { screenshot: '#chart' },             // specific element
])
```

#### ⚠ Act → observe: screenshots arrive on your NEXT turn, not this one

The image is emitted to your context **between turns** — after this
emission completes, before the next one begins. **Don't `taskSuccess`
right after taking a screenshot if you intended to look at it first.**
That commits before observing.

The wrong pattern (you'll never see the screenshot):

```ts
await testApp([{ screenshot: true }])
taskSuccess('Looks good!')   // ❌ committed before the image arrived
```

The correct pattern — capture, let the loop iterate, look in your
next turn:

```ts
// Turn N — capture and stop. NO taskSuccess.
await testApp([{ screenshot: true }])
```

```ts
// Turn N+1 — image is now in your context. Describe / verify, then commit.
taskSuccess('App renders the chart correctly — see screenshot above.')
```

Same rule applies to console output emitted from inside `testApp` /
`liveApp`: anything captured during the action shows up on the
**next** turn, not in this turn's local variables. (Action results
that come back via `await testApp(...)` return value — `eval`,
`read`, `assert` — ARE visible this turn, since they're returned
synchronously.)

When to use:
- After a build, to verify visually that the app renders the way you
  intended before `taskSuccess` — capture this turn, look next turn,
  commit if it looks right.
- When debugging a layout issue — read the screenshot in your next
  turn, see what actually rendered vs. what you expected.
- Combine with `assert` to gate on functional correctness AND
  capture a screenshot for the user, e.g.,
  `await testApp([{ assert: '...' }, { screenshot: true }])`. The
  assertion gates the success path this turn; the screenshot lands
  in your next turn for visual confirmation.

Skip when:
- A few `read` / `assert` actions cover what you need to verify —
  text-based checks are cheaper, faster (no extra turn needed), and
  the failure messages are more precise than "looks wrong in this
  screenshot."

### `assert` actions for one-shot self-verification

When you just want to gate `taskSuccess` on "the app rendered correctly,"
use `assert` actions. They evaluate a JS expression as truthy/falsy:
**passes are silent; a failing assertion throws** so your code
naturally bypasses `taskSuccess` and surfaces the failure to your
next turn (where you can read the error and self-correct).

```ts
await testApp([
  { assert: 'document.querySelectorAll("li").length === 5',
    message: '5 list items rendered' },
  { assert: '!document.querySelector(".error")',
    message: 'no error state' },
])
taskSuccess('App built and verified.')
```

That's it — no error inspection, no manual gate. If any assertion
fails, `testApp` throws with a message like `AssertionError: 5 list
items rendered — document.querySelectorAll("li").length === 5 (got 3)`.
The throw propagates past your `taskSuccess` call. Your next turn
sees the error as an observation, you fix the app, and try again.

**Don't reach for `taskFail` to escalate assertion failures** —
`taskFail` means "I cannot do this task at all" (refusal-shaped, ends
the conversation loop). A failing assertion is "this iteration was
wrong, try again" — exactly what the recoverable-error path handles
when `testApp` throws.

Use `assert` when you have a known-good condition to check; use
`eval` when you actually need the value back to decide what to do
next.

## Inspecting the live preview — `liveApp`

Once you've shipped (called `taskSuccess`), the user sees your app in
the preview pane. To read what they've selected/entered, use
`liveApp` with the same action shape — operates on the live pane,
not a hidden test iframe.

```ts
const results = await liveApp([
  { read: '#name-input', prop: 'value' },
  { read: '#status-message' },
])
```

## Styling

The preview iframe inherits a dark background (`#1a1a2e`) by
default. Style your app for that — light-themed apps look broken
against the surrounding pane.

```css
body {
  font-family: system-ui, -apple-system, sans-serif;
  background: #1a1a2e;
  color: #e0e0e0;
  padding: 1rem;
  margin: 0;
}
input, select, button {
  background: #0f3460;
  color: #e0e0e0;
  border: 1px solid #1a3a6e;
  border-radius: 4px;
  padding: 0.4rem 0.6rem;
  font-size: 16px;     /* prevents iOS zoom on focus */
  min-height: 44px;    /* touch-friendly */
}
button { cursor: pointer; }
button:hover { background: #1a3a6e; }
```

**For Plotly charts**, use the matching dark template:
```js
Plotly.newPlot('chart', traces, { template: 'plotly_dark', ...layout })
```

### Mobile-friendly layout

Apps render on both desktop and mobile. A few patterns make the
difference between "works on phones" and "looks broken" on phones:

- **Viewport meta tag** in `app/index.html` (shown in the Quick
  Start above): `<meta name="viewport" content="width=device-width, initial-scale=1">`.
- **Flexible layouts** that wrap on narrow screens:
  ```css
  .controls { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  ```
- **Relative heights for charts** so they scale with viewport:
  ```html
  <div id="chart" style="width:100%;height:50vh;min-height:250px;max-height:600px"></div>
  ```
- **Landscape mode on phones** — vertical space is very limited;
  reduce heights and tighten margins:
  ```css
  @media (orientation: landscape) and (max-height: 500px) {
    /* shrink tall elements, tighten gaps */
  }
  ```
- **Touch targets at least 44px** (`min-height: 44px` on inputs,
  buttons, interactive elements).
- **`font-size: 16px` on inputs** prevents iOS Safari from
  auto-zooming when the user taps an input field.

## Multi-file apps and helpers

Beyond the single-file case, organize as:

- `app/index.html` — entry point
- `app/index.js` — main module
- `app/SomeComponent.js` — local module, import via `./SomeComponent`
- `helpers/foo.ts` — shared helper, import via `./helpers/foo` from
  later turns. Lives outside `app/`; not bundled into the preview.
  Use for code your TS emissions reuse, not for the iframe's runtime.

## Things that don't work

- **JSX / TSX without a build step** — run `esbuild` (see the
  "JSX path" section above) to bundle to a runnable `.js`, or use
  HTM for the no-build path.
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
