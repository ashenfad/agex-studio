---
name: interactive-app
description: Build interactive browser apps with Preact, HTM, and Plotly. Use when the user wants dashboards, data explorers, filter widgets, or any interactive UI beyond static charts.
user-invocable: true
---

# Interactive Apps

Build interactive browser apps that run in a live preview panel. Write files
to the `app/` directory and they appear instantly.

## Architecture

Your app runs in a sandboxed iframe with:
- **Preact + HTM** for reactive UI (via import map, no build step)
- **Plotly.js** for charts (global `Plotly` — auto-injected, no `<script>` tag needed)
- **query()** bridge to call Python in your sandbox (global `query` — auto-injected, no import needed)

The preview panel appears automatically when `app/index.html` exists.

## Quick Start

Write a single `app/index.html` file:

```html
<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
<div id="app"></div>
<script type="module">
import { h, render } from 'preact'
import { useState, useEffect } from 'preact/hooks'
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

| Python type | Returned shape |
|---|---|
| `pd.DataFrame` | `{ type: 'dataframe', columns: [...], rows: [[...], ...] }` |
| `go.Figure` | `{ type: 'plotly', figure: { data: [...], layout: {...} } }` |
| str, int, float, bool, None, list, dict | `{ type: 'value', value: ... }` |
| Anything else | `{ type: 'value', value: '<str repr>' }` |

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
your REPL.** It runs in a fresh namespace with only files on disk available.

Always put your data-fetching logic in a **helper module file** (e.g.
`helpers/my_app.py`). Functions defined in your REPL will cause
`NameError` when called from `query()`.

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
// fig = { type: 'plotly', figure: { data: [...], layout: {...} } }
Plotly.react(div, fig.figure.data, fig.figure.layout)
```

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
are printed automatically so you just need `task_continue()` to see them.
You can also capture the return value if you need to branch on results.

**Important context:** File changes you make (writing or editing app files)
are not visible to the user or the live preview until after `task_success()`.
That's when your changes take effect in the user-facing app.

### test_app() — Test Your Current Changes

Builds the app from your **current file state** (including changes you just
made this turn) in a hidden iframe. Use this to verify your work before
finishing:

```python
# Simple — results are auto-displayed
await test_app()
task_continue()
```

```python
# With actions — interact and inspect
await test_app(actions=[
    {"click": "#load-btn"},
    {"read": "#results-count"},
])
task_continue()
```

```python
# Capture return value when you need to branch on results
results = await test_app(actions=[{"read": "#count"}])
count = results[0]["value"]
if int(count) > 10:
    ...  # handle it
task_continue()
```

**Important:** Call `task_continue()` after `test_app()` so you can see
the auto-displayed output and fix any errors in the next iteration.

### live_app() — Interact with the User's Live Preview

Reads from or interacts with the live preview that the user sees. This
reflects the app as it was **before your current turn** — any file changes
you make won't appear here until after `task_success()`.

Use this to see what the user has selected or entered in the app, or to
programmatically interact with the UI on their behalf:

```python
# Read what the user has selected — auto-displayed
await live_app(actions=[
    {"read": "#date-input", "prop": "value"},
    {"read": "#results-count"},
])
task_continue()
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
- Plotly.js and Preact+HTM are auto-injected — no CDN script tags needed
- Use `Plotly.react()` for efficient chart updates (not `Plotly.newPlot()`)
- Files are accessible via the sandbox filesystem
- The iframe is sandboxed — no access to parent page DOM
- `test_app()` tests uncommitted app files in a hidden iframe — use after writing/editing
- `live_app()` reads from or interacts with the live preview the user sees
- Both auto-display results and return them — capture the return value only when needed
- Both share the same actions vocabulary and return format
