---
name: interactive-app
description: Build interactive browser apps with React (via Preact-compat) + esbuild, or HTM for trivial cases. Plotly available globally. Use when the user wants dashboards, data explorers, filter widgets, or any interactive UI beyond static charts.
user-invocable: true
---

# Interactive Apps

Build interactive browser apps that run in a live preview panel. Write files
to the `app/` directory and they appear instantly.

## Architecture

Your app runs in a sandboxed iframe with:
- **React** (lightweight Preact-compat under the hood — `import` works) for reactive UI
- **`esbuild`** terminal command for bundling JSX/TSX/TS source into runnable JS
- **Plotly.js** for charts (global `Plotly` — auto-injected, no `<script>` tag needed)
- **marked** for Markdown rendering (via import map)
- **DOMPurify** for HTML sanitization (via import map)
- **dayjs** for date formatting/parsing (via import map)
- **query()** bridge to call Python in your sandbox (global `query` — auto-injected, no import needed)

The preview panel appears automatically when `app/index.html` exists.

## Sandbox constraints

The iframe runs with `sandbox="allow-scripts"` — agent code can compute and render freely, but a few browser APIs are blocked by the missing sandbox keywords. The console warns *"Ignored call to '<api>()'. The document is sandboxed…"* when this fires.

- **`confirm()` / `alert()` / `prompt()`** — blocked (no `allow-modals`). For destructive actions, use a **two-click confirm**: the button shows its normal label on first click, an "are you sure?" label on second click, with a brief reset timeout so a slow user doesn't accidentally commit.

  ```jsx
  function ConfirmButton({ children, onConfirm }) {
    const [armed, setArmed] = useState(false)
    useEffect(() => {
      if (!armed) return
      const t = setTimeout(() => setArmed(false), 3000)
      return () => clearTimeout(t)
    }, [armed])
    return armed
      ? <button onClick={() => { onConfirm(); setArmed(false) }}>Confirm?</button>
      : <button onClick={() => setArmed(true)}>{children}</button>
  }
  ```

  Or render an inline confirmation row next to the action (`Delete this? [Yes] [Cancel]`). For longer messages, render a real in-app dialog component — anything that's part of the app's own DOM works.

- **`window.open()` / `top.location = …`** — also blocked. Render "open" or "navigate" actions inside the app instead (modal, drawer, or component state).

  Note on forms: standard React/Preact `<form onSubmit={(e) => { e.preventDefault(); … }}>` patterns work — the iframe has `allow-forms` so the submit event fires and your handler runs. What you should *not* do is let a form navigate to its `action` URL (without `preventDefault`) — the iframe content is loaded from a blob URL with no routes, so a real form submission would unload your app.

### Powerful features that prompt the user

The iframe **does** delegate these features (the studio's iframe `allow=` list grants them), but the first call triggers a browser permission prompt. Handle the rejection path — the user can block. Available:

- **microphone** — `navigator.mediaDevices.getUserMedia({ audio: true })`. Use for audio analysis (tuners, voice apps, pitch detection).
- **camera** — `navigator.mediaDevices.getUserMedia({ video: true })`. Use for visual demos, color pickers, QR readers.
- **motion sensors** — `DeviceOrientationEvent` / `DeviceMotionEvent`. Mobile-only in practice; useful for tilt-controlled games and compass demos. **iOS Safari quirk:** must call `DeviceOrientationEvent.requestPermission()` from inside a user-gesture handler before listeners receive events — silent failure otherwise. Other browsers expose the events directly.

  ```js
  async function enableMotion() {
    // iOS gates motion behind an explicit prompt; other browsers
    // skip this and the listener attaches immediately.
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      const result = await DeviceOrientationEvent.requestPermission()
      if (result !== 'granted') return
    }
    window.addEventListener('deviceorientation', handler)
  }
  // Wire to a button click; `requestPermission` rejects when called
  // outside a user gesture, so an auto-on-mount approach won't work
  // on iOS.
  <button onClick={enableMotion}>Enable tilt</button>
  ```

- **geolocation** — `navigator.geolocation.getCurrentPosition()` / `.watchPosition()`. Map apps that center on the user, "what's nearby" tools, location-based games. User gets a one-time prompt; permission persists per their allow/block choice.
- **midi** — `navigator.requestMIDIAccess()`. Music apps with hardware controllers.
- **fullscreen** — `element.requestFullscreen()`. Immersive games, presentations.
- **autoplay** — `<audio>` / `<video>` `.play()` calls. Delegated to the iframe so post-permission media (e.g. a camera stream attached to a `<video>`, or audio playback after a "Speak" button) starts without being blocked by the browser's cross-origin autoplay policy. No user prompt for this one — it just unblocks the API.

Permission state is per-origin and persists per the user's allow/block choice. Code defensively:

```js
try {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  // ... use stream
} catch (e) {
  if (e.name === 'NotAllowedError') {
    // User declined — show a button to retry, or fall back to a different mode.
  } else {
    // No device, hardware error, etc.
  }
}
```

Things deliberately **not** delegated: `payment` (no plausible legitimate use in agent apps), `clipboard-read` (privacy boundary — `clipboard-write` works without it). If a user case needs one of these, the studio's iframe `allow=` list can be expanded.

## Quick Start (recommended: JSX + esbuild)

Write `app/index.jsx` with idiomatic React, then bundle to JS:

```jsx
// app/index.jsx
import { useState } from 'react'
import { createRoot } from 'react-dom/client'

function App() {
  const [count, setCount] = useState(0)
  return (
    <button onClick={() => setCount(c => c + 1)}>
      Clicked {count} times
    </button>
  )
}

createRoot(document.getElementById('app')).render(<App />)
```

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

Then bundle with esbuild from `terminal_action`:

```
esbuild app/index.jsx --outfile=app/index.js
```

Then test:

```python
await test_app()
```

**The build step.** `esbuild` is a registered terminal command. It:
- Bundles your local `app/*.jsx` + `helpers/*.{js,jsx,ts,tsx}` files together
- Transforms JSX → JS via the automatic runtime
- Leaves bare imports (`react`, `recharts`, `@radix-ui/...`) as native ES module imports — the iframe's import map resolves them at runtime, so the bundle stays small even when you use component libraries
- Required after every edit to `.jsx`/`.tsx` source — the iframe loads the *built* `app/index.js`, not the source

**`react` is aliased to Preact.** The iframe's import map maps `react` and `react-dom` (and `react-dom/client`, `react/jsx-runtime`) to `preact/compat`. You write idiomatic React; the runtime is ~12KB.

**Any other npm package is auto-resolved through esm.sh.** When the iframe is built, the studio scans your bundle for bare imports it doesn't already have a pinned entry for and adds `https://esm.sh/<pkg>` to the import map. So `import { Bar } from 'recharts'` just works — no studio-side config, no manual `<script>` tag. Versioned specifiers work too (`import { z } from 'zod@3.22'`), and esm.sh handles sub-path imports automatically.

## Component libraries

Use a bare import; the studio auto-resolves it to esm.sh at build time. Recommended:

- **Charts**: `recharts`, `visx`
- **Unstyled UI primitives**: `@radix-ui/react-*`, `react-aria-components`
- **Icons**: `lucide-react`
- **Forms**: `react-hook-form`
- **Tables / virtualization**: `@tanstack/react-table`, `@tanstack/react-virtual`

For CSS that ships with a library, link it from your `app/index.html`:

```html
<link rel="stylesheet" href="https://esm.sh/@radix-ui/themes/styles.css">
```

Heavy frameworks (MUI, Ant Design, Mantine) work but pull 300KB+ — only reach for them if their look-and-feel matters.

**Version pinning.** Bare imports resolve to whatever esm.sh's `latest` returns. For published gists where you want to lock in a known-good version, write the version into the import: `import { Bar } from 'recharts@2.15.0'`.

## End-to-end example: a small recharts dashboard

Putting the whole flow together — write source files, bundle, test, iterate.

**1. Write the entry HTML** (`app/index.html`):

```html
<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 1rem;
         background: #1a1a2e; color: #e0e0e0; }
  h1 { margin: 0 0 1rem; font-size: 1.5rem; }
</style>
</head>
<body>
<div id="app"></div>
<script type="module" src="./index.js"></script>
</body></html>
```

**2. Write the JSX** (`app/index.jsx`):

```jsx
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts'

const SAMPLE = [
  { month: 'Jan', revenue: 4200 },
  { month: 'Feb', revenue: 5100 },
  { month: 'Mar', revenue: 4800 },
  { month: 'Apr', revenue: 6300 },
  { month: 'May', revenue: 7200 },
]

function Dashboard() {
  const [data] = useState(SAMPLE)
  const total = data.reduce((s, d) => s + d.revenue, 0)
  return (
    <div>
      <h1>Revenue ({data.length} months — ${total.toLocaleString()} total)</h1>
      <div style={{ width: '100%', height: 320 }}>
        <ResponsiveContainer>
          <BarChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#333" />
            <XAxis dataKey="month" stroke="#aaa" />
            <YAxis stroke="#aaa" />
            <Tooltip contentStyle={{ background: '#222', border: 'none' }} />
            <Bar dataKey="revenue" fill="#7c5fe8" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

createRoot(document.getElementById('app')).render(<Dashboard />)
```

**3. Bundle** (in a `terminal_action`):

```
esbuild app/index.jsx --outfile=app/index.js
```

**4. Test** (in a `python_action`):

```python
results = await test_app(actions=[
    {"wait": 200},
    {"read": "h1"},               # confirm the heading rendered
    {"eval": "document.querySelectorAll('.recharts-bar-rectangle').length"},
])
```

If `test_app` reports the heading text and `5` bar rectangles, the dashboard works. Iterate by editing `app/index.jsx`, re-running `esbuild`, and re-running `test_app` — the build is fast (<500ms after the first call warms esbuild-wasm).

A few patterns this example demonstrates that you'll reuse in most apps:

- **`react` and `react-dom/client` are both available** — bare imports resolve to Preact/compat at runtime.
- **Local imports between files** (e.g., `import { Chart } from './components/Chart.jsx'`) get inlined by the bundler; only `react` / `recharts` / etc. stay external.
- **CSS via `<style>` in the HTML or external `<link>` tags** is the most reliable path — esbuild can also inline `import './styles.css'` from JSX.
- **Image assets via `import logo from './logo.png'`** work — esbuild encodes them as data URLs and inlines into the bundle. External `https://` image hosts also load, but VFS-resident assets are more reliable (no broken-link risk if the host disappears).

## Alternative: HTM for trivial apps

For very simple apps where you don't want a build step, HTM (tagged template literals) works directly without esbuild:

```html
<!-- app/index.html -->
<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
</head>
<body>
<div id="app"></div>
<script type="module">
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
</script>
</body></html>
```

HTM differs from JSX in syntax: `${expr}` instead of `{expr}`, `class=` instead of `className=`. Easy to get wrong if you're used to React; for anything beyond ~30 lines, prefer the JSX path above.

## Before You Finish

- **Test, then let the turn end** — call `test_app()` with `read`/`eval`
  actions to verify real content. Output auto-displays and lands in your
  next turn's observation; you do NOT need an explicit terminator. Never
  `task_success()` in the same turn as `test_app()` — you haven't seen
  the output yet.
- **Persist control state** — save filter selections, dates, and UI state
  to `localStorage` so they survive page reloads (see Persisting UI State)
- **Namespace storage keys** — prefix with a random compound name
  (e.g., `"coral-panda-startDate"`) to avoid collisions with other apps
  in the same session
- **For non-trivial iteration, commit checkpoints with `git`.** The VFS
  is git-tracked — `git init` (if not already), then `git commit -m
  "before swapping color scheme"` between rough edits.  Rolling back a
  bad CSS experiment becomes a single `git checkout` instead of
  hand-reverting from memory.  See `cat /skills/git/SKILL.md` for the
  available subcommands.
- **Iterating on first-load behavior?** Pass `fresh=True` to
  `test_app(...)` to skip the localStorage seed — useful when the
  previous run's saved state would mask bugs in the fresh-load path.

## Multi-File Apps

For larger apps, split code into separate files. JS files use standard
ES module imports — they're resolved automatically via the import map:

```
app/
  index.html          ← entry point
  App.js              ← main component
  components/Chart.js ← sub-component
  style.css           ← stylesheet
```

```html
<!-- app/index.html -->
<link rel="stylesheet" href="./style.css">
<script type="module" src="./App.js"></script>
```

```js
// app/App.js
import { Chart } from './components/Chart.js'
```

CSS `<link>` tags and `<script src>` references to local files are
inlined automatically. ES module imports between `app/` files work
via the import map — no build step needed.

## The query() Bridge

`query()` is a **global function** auto-injected into the iframe — just call
it directly, do **not** import it. It executes Python code in your sandbox
and returns results. Files on disk (helper modules, data files) are always
available.

**Always use the explicit form with `result`:**
```js
const { df } = await query({ code: '...python...', result: ['df'] })
```

**Parameters:**
- `code` (string): Python code to execute in the sandbox
- `result` (string[]): Variable names to return. **Always specify this** —
  omitting it returns the entire namespace which grows over time.

**Return value types:**

Results are recursively serialized — DataFrames and Figures are tagged
with `__type__` wherever they appear, even nested inside dicts or lists.

| Python type | Returned shape |
|---|---|
| `pd.DataFrame` | `{ __type__: 'dataframe', columns: [...], rows: [[...], ...] }` |
| `go.Figure` | `{ __type__: 'plotly', figure: { data: [...], layout: {...} } }` |
| dict | `{ key: <serialized value>, ... }` |
| list, tuple | `[<serialized value>, ...]` |
| str, int, float, bool, None | returned as-is |
| Anything else | `'<str repr>'` |

**Error handling:** `query()` rejects the promise on Python errors.
Always use try/catch:
```js
try {
  const { df } = await query({ code: 'df = load_data()', result: ['df'] })
} catch (err) {
  console.error('Python error:', err.message)
}
```

## CRITICAL: Avoiding JS/Python String Collisions

**Python code inside JS template literals (backticks) must not contain
`${...}`** — JavaScript will intercept it as its own interpolation, causing
`ReferenceError` or wrong values.

**BAD — JS eats the `${}`:**
```js
// WRONG: JS interpolates ${start} and ${end} before Python sees them
const { df } = await query({
  code: `df = load(at("${start}"):at("${end}"))`,
  result: ['df']
})
```

**GOOD — use string concatenation:**
```js
const { df } = await query({
  code: 'df = load(at("' + start + '"):at("' + end + '"))',
  result: ['df']
})
```

**BEST — write a helper module file, import and call it from query():**
```python
# helpers/events.py  ← written to disk, persists across turns
def get_events(start_str, end_str, tz):
    at = at_tz(tz)
    events = list(cal[at(start_str):at(end_str)])
    return to_dataframe(events, tz=tz)
```
```js
// In app JS — import the module and call it
const { df } = await query({
  code: 'from helpers.events import get_events; df = get_events("'
        + start + '", "' + end + '", "' + tz + '")',
  result: ['df']
})
```

This file-based module pattern is **strongly recommended** because:
1. No string escaping problems
2. Module files persist on disk — they survive across task turns
3. Modules are auto-reloaded on each import, so edits take effect immediately
4. Keeps app JS simple

## CRITICAL: query() Does Not See REPL State

**`query()` does not have access to functions or variables you defined in
your REPL.** It runs in a fresh namespace with only files on disk and
the agent's `cache` available.

Always put your data-fetching logic in a **helper module file** (e.g.
`helpers/my_app.py`). Functions defined in your REPL will cause
`NameError` when called from `query()`.

## Publishing Values to query() via cache

If you have a computed value the app should display — a fitted model, a
cleaned DataFrame, a derived configuration — store it in `cache[...]`
before `task_success()`.  Cache values **are visible to `query()`** while
REPL variables are not:

```python
# In your python_action: compute and stash
df = pd.read_csv("/downloads/sales.csv").dropna()
cache["sales_df"] = df
task_success(...)
```

```js
// In app JS: read it via query()
const { df } = await query({
  code: 'df = cache["sales_df"]',
  result: ['df']
})
```

**Reads are snapshots; writes are turn-local.**  The `cache` an app
sees via `query()` is a copy of the chat agent's cache taken at
query start — cache writes the *agent* makes during chat are visible
to later queries (after `task_success`).  Cache writes that
*query code* makes (`cache["x"] = ...`) succeed within that one
query call but are discarded when the query returns; later queries
re-fetch a fresh snapshot and don't see them.

This means: don't try to use `cache` as cross-query persistence from
the app side — use the JSON-file pattern below.  Use `cache[...]`
for ready-to-consume values pushed *from chat*; use a helper module
(`helpers/*.py`) when the app needs to *call a function* (e.g. to
re-derive on different parameters).  Keep JSON-file persistence for
app-internal state (filter selections, view modes, counters) — see
the next section.

## Module-Level Variables Don't Persist Across query() Calls

Because modules are auto-reloaded on each import, **module-level variables
reset on every `query()` call**. Do NOT store game state, session data, or
counters in module globals — they will be lost.

To persist state across `query()` calls, save it to a JSON file on the
virtual filesystem (which is in-memory and fast):

```python
# helpers/session.py
import json

_STATE_FILE = '_my_app_state.json'

def _save(state):
    with open(_STATE_FILE, 'w') as f:
        json.dump(state, f, separators=(',', ':'))

def _load():
    try:
        with open(_STATE_FILE, 'r') as f:
            return json.load(f)
    except Exception:
        return None
```

Use relative paths (not `/tmp/` which may not exist). The VFS is in-memory
so file I/O is fast.

## Registered Globals

`local_timezone()`, `google_token()`, and other registered functions are
only available in the **main sandbox scope**. They are NOT available inside
imported helper modules. Pass them as parameters:

```python
# WRONG — NameError inside imported module
# helpers/my_app.py
def load():
    tz = local_timezone()  # NameError!

# RIGHT — pass as argument
def load(tz):
    at = at_tz(tz)
    ...
```

**Tip:** Capture registered globals once on app mount, then reuse them:
```js
// On mount — capture globals
const { tz } = await query({
  code: 'tz = local_timezone()',
  result: ['tz']
})
// Then pass to subsequent calls
const { df } = await query({
  code: 'from helpers.events import get_events; df = get_events("'
        + start + '", "' + end + '", "' + tz.value + '")',
  result: ['df']
})
```

## Preact + HTM Patterns

HTM uses tagged template literals instead of JSX. Key syntax:

```js
import { h, render } from 'preact'
import { useState, useEffect, useRef, useCallback } from 'preact/hooks'
import htm from 'htm'
const html = htm.bind(h)

// Components
function MyComponent({ title }) {
  return html`<h1>${title}</h1>`
}

// Event handlers
html`<button onClick=${() => doSomething()}>Click</button>`
html`<input onInput=${e => setValue(e.target.value)} />`
html`<select onChange=${e => setSelected(e.target.value)}>
  ${options.map(o => html`<option value=${o}>${o}</option>`)}
</select>`

// Conditional rendering
html`${show ? html`<div>Visible</div>` : null}`

// Lists
html`<ul>${items.map(i => html`<li key=${i.id}>${i.name}</li>`)}</ul>`

// Render into DOM
render(html`<${App} />`, document.getElementById('app'))
```

## Markdown Rendering

[marked](https://github.com/markedjs/marked) is available via import map
for rendering Markdown as HTML:

```js
import { marked } from 'marked'
import DOMPurify from 'dompurify'

function Markdown({ text }) {
  const clean = DOMPurify.sanitize(marked(text))
  return html`<div dangerouslySetInnerHTML=${{ __html: clean }} />`
}
```

Supports the full CommonMark/GFM spec: tables, ordered/unordered lists,
code blocks, task lists, links, images, etc. Always sanitize with
DOMPurify when rendering user-provided content.

## HTML Sanitization

Use DOMPurify whenever rendering untrusted HTML (e.g. from marked or
email bodies):

```js
import DOMPurify from 'dompurify'
import { marked } from 'marked'

function Markdown({ text }) {
  const clean = DOMPurify.sanitize(marked(text))
  return html`<div dangerouslySetInnerHTML=${{ __html: clean }} />`
}
```

## Date Formatting

dayjs is available for date parsing, formatting, and relative time:

```js
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
dayjs.extend(relativeTime)

dayjs('2025-03-14').format('MMM D, YYYY')  // "Mar 14, 2025"
dayjs('2025-03-14T10:30:00').fromNow()     // "2 hours ago"
dayjs().subtract(7, 'day').format('YYYY-MM-DD')  // 7 days ago
```

## Plotly Integration

Plotly.js is available as a global (`window.Plotly`) — it is auto-injected
into the iframe, no `<script>` tag needed.

Use `Plotly.react()` (not `newPlot()`) for efficient updates:

```js
function Chart({ data }) {
  const ref = useRef(null)

  useEffect(() => {
    if (!ref.current || !data) return
    Plotly.react(ref.current, data.traces, data.layout, { responsive: true })
  }, [data])

  return html`<div ref=${ref} style="width:100%;height:50vh;min-height:250px;max-height:600px"></div>`
}
```

**Using Plotly figures from Python:**
```js
const { fig } = await query({ code: 'fig = create_chart()', result: ['fig'] })
// fig = { __type__: 'plotly', figure: { data: [...], layout: {...} } }
Plotly.react(div, fig.figure.data, fig.figure.layout)
```

**Maps:** the tile-fetching map traces (`scatter_mapbox`, `scattermap`,
`densitymap`, `densitymapbox`, `choropleth_mapbox`) don't render in
the app preview. The iframe is sandboxed with an opaque origin, and
tile servers (OSM, Mapbox, etc.) reject requests with `Origin: null`.
Use `scatter_geo` and `choropleth` instead — they ship with built-in
country / state / region geometries and don't fetch tiles.

## Persisting UI State

Use `localStorage` to save filter selections, date ranges, UI toggles,
and any other small state that should survive reloads. Pick a random
compound name (e.g., `"coral-panda"`) as the app's namespace prefix to
avoid collisions with other apps in the same session:

```js
const APP = 'coral-panda'
// Save
localStorage.setItem(APP + '-startDate', startDate)
// Restore
const [startDate, setStartDate] = useState(
  localStorage.getItem(APP + '-startDate') || '2025-01-01'
)
```

### Persistence contract (read this before building save/load)

`localStorage` inside the iframe is a shim backed by the current
session's storage. The API matches the standard
(`getItem/setItem/removeItem/clear/key/length`) but a few semantics
are worth knowing:

- **Scoped to the current session.** Each session has its own
  isolated storage; switching sessions shows that session's data.
- **Persists across your turns.** Data written in one turn is still
  there the next time the app loads.
- **Quota is ~5MB** (matches browser norms). `setItem` throws
  `QuotaExceededError` on overflow — be defensive for large blobs.
- **String values only.** `JSON.stringify` complex data yourself.

### What does NOT work

These APIs are available on the open web but are **not supported**
inside the iframe. Don't reach for them:

- **`indexedDB`** — throws with a clear error on any access. For
  structured or larger data, use the `query()` bridge to Python
  (DataFrames, JSON files under `helpers/`, etc.). Pyodide has a
  real filesystem and can handle anything `localStorage` can't.
- **Cookies** — blocked by the sandbox.
- **`OPFS`, `Cache API`, `FileSystem Access API`** — none available.
- **`sessionStorage`** — *does* work, but it's ephemeral: it resets
  every time the iframe reloads. Fine for in-tab state, bad for
  anything the user expects to survive.

### Schema migrations

Because stored data persists across turns, changing the shape of what
you save to `localStorage` can leave old data behind that the new code
can't read. Handle it explicitly on mount with a schema version:

```js
const APP = 'coral-panda'
const SCHEMA = 3

// Check schema version on app init — migrate or reset if out of date
const stored = Number(localStorage.getItem(APP + '-schema') || 0)
if (stored !== SCHEMA) {
  // Option A: migrate old keys forward if the mapping is simple
  // Option B: clear the namespace and start fresh
  Object.keys(localStorage)
    .filter(k => k.startsWith(APP + '-'))
    .forEach(k => localStorage.removeItem(k))
  localStorage.setItem(APP + '-schema', String(SCHEMA))
}
```

Bump `SCHEMA` whenever you change the on-disk shape so apps built in
earlier turns cleanly migrate or reset instead of crashing on stale
data.

### test_app sees real save data, read-only

`test_app()` seeds the hidden test iframe with the current session's
`localStorage` contents, so you can verify load-from-save paths work
correctly. Writes performed during `test_app()` are **discarded** — the
agent's speculative tests can't overwrite the user's live save data.
To test a cold-start path, either bump the schema version (the
migration branch above will wipe old keys) or add a ``?fresh=1`` flag
your app honors by clearing its own keys.

## Common Patterns

### Data Explorer with Filters

First, create a helper module with your data logic:
```python
# helpers/events.py  ← persists on disk across turns
def get_events(start_str, end_str, tz):
    from calgebra import at_tz
    at = at_tz(tz)
    events = list(cal[at(start_str):at(end_str)])
    return to_dataframe(events, tz=tz)
```

Then build the app UI:
```html
<script type="module">
import { h, render } from 'preact'
import { useState, useEffect, useRef } from 'preact/hooks'
import htm from 'htm'
const html = htm.bind(h)

function App() {
  const [startDate, setStartDate] = useState('2025-01-01')
  const [endDate, setEndDate] = useState('2025-02-01')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [tz, setTz] = useState(null)
  const chartRef = useRef(null)

  // Capture registered globals once on mount
  useEffect(() => {
    query({ code: 'tz = local_timezone()', result: ['tz'] })
      .then(r => setTz(r.tz.value))
      .catch(err => console.error(err))
  }, [])

  async function fetchData() {
    if (!tz) return
    setLoading(true)
    try {
      // Use string concatenation — NOT backtick interpolation
      const { df } = await query({
        code: 'from helpers.events import get_events; df = get_events("'
              + startDate + '", "' + endDate + '", "' + tz + '")',
        result: ['df']
      })
      setData(df)
    } catch (err) {
      console.error(err)
    }
    setLoading(false)
  }

  useEffect(() => { fetchData() }, [startDate, endDate, tz])

  useEffect(() => {
    if (!data || !chartRef.current) return
    const rows = data.rows
    Plotly.react(chartRef.current, [{
      x: rows.map(r => r[0]),
      y: rows.map(r => r[2]),
      type: 'bar',
    }], { margin: { t: 30 }, template: 'plotly_dark' }, { responsive: true })
  }, [data])

  return html`
    <div style="padding: 1rem; font-family: system-ui;">
      <div style="display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 1rem;">
        <input type="date" value=${startDate}
               onInput=${e => setStartDate(e.target.value)} />
        <input type="date" value=${endDate}
               onInput=${e => setEndDate(e.target.value)} />
      </div>
      ${loading ? html`<p>Loading...</p>` : null}
      <div ref=${chartRef} style="width:100%;height:50vh;min-height:250px;max-height:600px"></div>
    </div>
  `
}

render(html`<${App} />`, document.getElementById('app'))
</script>
```

### Styling

The iframe has a dark background by default (#1a1a2e). Style accordingly:

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
  font-size: 16px; /* prevents iOS zoom on focus */
  min-height: 44px; /* touch-friendly */
}
button { cursor: pointer; }
button:hover { background: #1a3a6e; }
```

Plotly charts: use `template: 'plotly_dark'` in layout for dark-themed charts:
```js
Plotly.react(div, traces, { template: 'plotly_dark', ...layout })
```

### Mobile-Friendly Layout

Apps run on both desktop and mobile. Follow these patterns:

**Always include the viewport meta tag** (shown in Quick Start):
```html
<meta name="viewport" content="width=device-width, initial-scale=1">
```

**Use flexible layouts that wrap on narrow screens:**
```css
.controls {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
```

**Use relative heights for charts** so they scale with the viewport:
```js
return html`<div ref=${ref} style="width:100%;height:50vh;min-height:250px;max-height:600px"></div>`
```

**Handle landscape mode on phones** — vertical space is very limited when
a phone is turned sideways. Use a media query to reduce heights and
tighten spacing so content fits without excessive scrolling:
```css
@media (orientation: landscape) and (max-height: 500px) {
  /* reduce tall elements, tighten margins */
}
```

**Touch targets must be at least 44px.** Inputs, buttons, and interactive
elements should have `min-height: 44px` and enough padding to be easily
tappable.

**Set `font-size: 16px` on inputs** to prevent iOS Safari from
auto-zooming when the user taps an input field.

## Testing and Inspecting Apps

Two functions let you test and interact with apps. Both share the same
actions vocabulary, return format, and **auto-display** behavior — results
are printed automatically and land in your next turn's observation just
by letting the `python_action` return normally. You can also capture the
return value if you need to branch on results.

**Important context:** File changes you make (writing or editing app files)
are not visible to the user or the live preview until after `task_success()`.
That's when your changes take effect in the user-facing app.

### test_app() — Test Your Current Changes

Builds the app from your **current file state** (including changes you just
made this turn) in a hidden iframe. Use this to verify your work before
finishing:

```python
# GOOD — interact with controls and verify the data updates.
# Let the python_action return without a terminator; results
# auto-display and land in your next turn's observation.
await test_app(actions=[
    {"select": "#date-range", "value": "last-7-days"},
    {"wait": 500},
    {"read": "#results-table"},
    {"eval": "document.querySelectorAll('#results-table tr').length"},
])
```

Use `{"screenshot": True}` to visually inspect the rendered app, or
target a specific element with `{"screenshot": "#selector"}`:

```python
# Screenshot the full app after interacting
await test_app(actions=[
    {"click": "#start-btn"},
    {"wait": 1000},
    {"screenshot": True},
])

# Screenshot just a specific component
await test_app(actions=[
    {"screenshot": "#game-canvas"},
    {"screenshot": ".score-panel"},
])
```

**Screenshots need self-contained CSS.** The screenshot tool serializes
the DOM into an SVG `<foreignObject>` and rasterizes it — the browser
performs no network fetches during that step, so all CSS must be
embedded inline at render time. The tool walks every `<link rel="stylesheet">`
and reads its rules to inline them, but **cross-origin stylesheets are
unreadable** unless loaded with `crossorigin="anonymous"` (the server
must also send `Access-Control-Allow-Origin`, which most CDNs do).
If a CDN sheet isn't CORS-loaded, screenshots fail with
"Screenshot encoder returned an unexpected data URL shape" — the app
still renders for the user, but you can't visually verify it.

Two safe options:
- Inline CSS via a `<style>` block in your HTML.
- Load external CSS with the crossorigin attribute:
  `<link rel="stylesheet" href="https://cdn..." crossorigin="anonymous">`

Same constraint applies to remote images / fonts referenced from CSS —
prefer bundled or data-URL assets when screenshots matter.

A bare `await test_app()` only checks for console errors — it does NOT
verify that data loaded, charts rendered, or controls work. **Always use
actions** to interact with your app and read back results before finishing.

**CRITICAL: never call `task_success()` in the same turn as
`test_app()`.** You cannot see the test results until the next turn —
output lands in your next turn's observation when the `python_action`
returns normally. If you finish the task in the same turn as the test,
you have no idea whether the app actually works. Let the turn end,
review the results next turn, and only then call `task_success()`.

```python
# Capture return value when you need to branch on results.
# No terminator — let the python_action return normally so the
# auto-displayed output lands in next turn's observation.
results = await test_app(actions=[{"read": "#count"}])
count = results[0]["value"]
if int(count) > 10:
    ...  # handle it
```

### live_app() — Interact with the User's Live Preview

Reads from or interacts with the live preview that the user sees. This
reflects the app as it was **before your current turn** — any file changes
you make won't appear here until after `task_success()`.

Use this to see what the user has selected or entered in the app, or to
programmatically interact with the UI on their behalf:

```python
# Read what the user has selected — auto-displayed.
# Let the python_action return; results land next turn.
await live_app(actions=[
    {"read": "#date-input", "prop": "value"},
    {"read": "#results-count"},
])

# See what the live app looks like right now
await live_app(actions=[{"screenshot": True}])
```

### Shared Actions

Both functions accept `actions` — a list of interactions to perform:

| Action | Description |
|---|---|
| `{"click": "#selector"}` | Click an element |
| `{"type": "#selector", "value": "text"}` | Type into an input field |
| `{"select": "#selector", "value": "opt"}` | Select a dropdown option |
| `{"wait": 500}` | Wait N milliseconds |
| `{"read": "#selector"}` | Read element text content |
| `{"read": "#selector", "prop": "value"}` | Read a specific property |
| `{"eval": "js expression"}` | Evaluate JS and capture result |
| `{"screenshot": True}` | Capture a full screenshot (sent via view_image) |
| `{"screenshot": "#selector"}` | Screenshot a specific element |

The app settles (query() calls, re-renders) after each action.

### Auto-Display Format

Results are printed automatically in a compact format:

```
[error] ReferenceError: x is not defined
[read #count] 42
[eval] 15
[test_app] clean
```

Both functions also return the list of result dicts if you need them:

```python
[
    {"type": "log", "level": "error", "message": "ReferenceError: x is not defined"},
    {"type": "read", "selector": "#count", "value": "42"},
    {"type": "eval", "expr": "document.querySelectorAll('tr').length", "value": "15"},
]
```

## Key Points

- Write `app/index.html` — preview panel appears automatically
- `query()` and `Plotly` are **globals** — do NOT import them, just use them directly
- `query()` is async — always `await` it, always wrap in try/catch
- **Always specify `result: [...]`** — don't rely on the shorthand form
- **Never use `${}` for Python code in JS backtick strings** — use `+` concatenation
- **Put data-fetching logic in helper module files** — `query()` can't see REPL-defined functions
- Modules are auto-reloaded on import, so edits take effect immediately
- Registered globals (`local_timezone()`, etc.) only work in the main sandbox scope — pass them as parameters
- Capture globals once on app mount with a setup `query()`, then reuse in subsequent calls
- Plotly.js, Preact+HTM, marked, DOMPurify, and dayjs are auto-injected — no CDN script tags needed
- Use `Plotly.react()` for efficient chart updates (not `Plotly.newPlot()`)
- Files are accessible via the sandbox filesystem
- The iframe is sandboxed — no access to parent page DOM
- Use `localStorage` with a compound-name prefix for persistent UI state — it's session-scoped and persists across turns. `indexedDB` is not supported — use `query()` for structured data. See Persisting UI State.
- `test_app()` tests uncommitted app files in a hidden iframe — use after writing/editing
- `live_app()` reads from or interacts with the live preview the user sees
- Both auto-display results and return them — capture the return value only when needed
- Both share the same actions vocabulary and return format
