# Interactive Apps

Build interactive browser apps that render in a live preview pane.
Write files to `app/` and they appear automatically when
`app/index.html` exists.

## Architecture

Your app runs in a cross-origin iframe (`apps.agex.studio` in prod)
with a few injected globals. **Any bare npm specifier auto-resolves to
esm.sh** — `import { Bar } from 'recharts'` just works, no build step and
no studio-side config. The libraries below are *pinned and aliased*, so
prefer them when they fit; anything else resolves on demand (see "Other
packages" below).

### Pinned / aliased libraries (prefer these when they fit)

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
- `notify(title, body?)` — show a desktop notification (see
  "Powerful browser features" below).

**Other packages:** any other bare specifier (e.g. `import _ from
'lodash'`) auto-resolves to `https://esm.sh/<pkg>` at load time — no
config needed. Pin a version when it matters: `import { Bar } from
'recharts@2.10.0'` (esm.sh accepts the versioned fragment). Two caveats:
(1) esm.sh is a CDN — a network hop, plus the occasional CommonJS-interop
wrinkle — so for libraries already in the table above, prefer those;
(2) the resolver only scans *static* `import ... from '...'` statements,
so a fully dynamic `import(someVariable)` won't be picked up.

## Powerful browser features available

The iframe runs on a separate origin (`apps.agex.studio`) and the
studio delegates a generous `allow=` list, so your app can reach
APIs that are normally blocked in third-party iframes. Some prompt
the user on first use; some just unblock the API silently.

- **microphone** — `navigator.mediaDevices.getUserMedia({ audio: true })`. Tuners, voice apps, pitch detection.
- **camera** — `navigator.mediaDevices.getUserMedia({ video: true })`. Photo booths, QR readers, color pickers.
- **geolocation** — `navigator.geolocation.getCurrentPosition()` / `.watchPosition()`. Map-centering, "what's nearby."
- **motion sensors** — `DeviceOrientationEvent` / `DeviceMotionEvent`. Mobile-only in practice. **iOS Safari quirk:** call `DeviceOrientationEvent.requestPermission()` from inside a user-gesture handler first, otherwise the listener is silently dead.
- **midi** — `navigator.requestMIDIAccess()`.
- **fullscreen** — `element.requestFullscreen()`.
- **screen wake lock** — `navigator.wakeLock.request('screen')`. Keeps the screen on for tuners, timers, music players. **Gotcha:** auto-releases when the tab hides — re-acquire on `visibilitychange` or the lock won't survive a tab switch.
- **autoplay** — `<audio>` / `<video>` `.play()` works without the usual cross-origin block; useful for playing a captured stream back through a `<video>`.
- **web share** — `navigator.share({ title, text, url, files })`. Requires a user gesture (button click, not effect).
- **downloads** — `<a href={blobUrl} download="x.csv">` triggers the browser's save dialog.
- **clipboard write** — `navigator.clipboard.writeText(text)`. Call from a click handler (browser user-activation requirement). Use for "copy hex," "copy share link" buttons.
- **desktop notifications** — `await notify(title, body?)`. Host-mediated (the sandbox can't construct `Notification` itself), so use the `notify` global rather than the `Notification` API directly. First use prompts the user for permission; calls are rate-capped per session. Resolves to `true` if a notification was shown, `false` otherwise (permission denied, rate-limited, unsupported) — it **never throws**, so check the boolean and fall back to in-page UI when it's `false`. Best for timers, long async work, or turn-based games signalling the other player. Clicking the notification refocuses the studio tab. Example: `if (!(await notify('Timer done', '25:00 elapsed'))) showInPageBanner()`.

Permission state is per-origin and persists per the user's allow/block
choice. Wrap `getUserMedia` and friends in try/catch — `NotAllowedError`
means the user said no, and you should surface a "tap to enable" path
rather than silently failing.

**Not delegated:** `payment`, `clipboard-read` (privacy boundary — would expose whatever the user last copied).

## Users & shared state

Need real accounts, cross-device sync, or state shared between people
(not just per-browser localStorage)? Back the app with Supabase
(hosted Postgres + auth + row-level security). Sign-in — including
"Sign in with Google" — works through a **popup relay, not a redirect**:
a normal redirect would reload this iframe's bootloader and lose app
state. `cat /skills/supabase-auth/SKILL.md` before building it.

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

## Generating assets

Need an image, icon, or sprite? Generate one with `createImage(prompt)`
(returns PNG bytes) and write it under `app/` so it's inlined for the
sandbox:

```ts
const sprite = await createImage('pixel-art castle, transparent background')
await fs.write('app/assets/castle.png', sprite)
// then in app code:  <img src="assets/castle.png">
```

Pass `{ image: bytes }` to edit/recolor an existing asset, or fan out with
`Promise.all([...])` for a set. Full signature is in the `createImage`
description.

Music too — `createMusic(prompt)` returns MP3 bytes:

```ts
const bg = await createMusic('lo-fi hip hop, mellow, 80 BPM')
await fs.write('app/assets/bg.mp3', bg)
// then in app code:  <audio src="assets/bg.mp3" loop>
```

There's no exact-length or seamless-loop control — for a background loop,
prompt for ambient material (no hard downbeats) and rely on `<audio loop>`.

And `createSpeech(text, { voice })` for character dialog / narration (WAV) —
per-character voices with inline emotion tags. For prompt-craft, the full
voice catalog, the emotion-tag vocabulary, and dialog workflows, see the
`media` skill (`cat /skills/media/SKILL.md`).

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

The app picks up the new theme the next time the preview is rebuilt. To
apply it immediately, re-run the apply step against the live preview —
**don't** `location.reload()` (navigation tears the app down; see "Things
that don't work"):

```ts
await liveApp([{ eval: `(async () => {
  const t = (await getCacheValue('theme')) || {}
  const r = document.documentElement
  for (const [k, v] of Object.entries(t)) r.style.setProperty('--' + k, v)
})()` }])
```

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

**`eval` awaits Promises automatically.** If your expression returns
a Promise (or thenable), the action waits for it to resolve and
returns the resolved value. Use this for async work — image
generation, fetch, etc. — without resorting to globals + `{wait:N}`
+ separate-eval-to-read patterns:

```ts
// Async work in one shot. The action takes as long as the Promise
// takes; rejected Promises surface as an error on the result entry.
const r = await testApp([
  { eval: `Promise.all([
      Plotly.toImage('#chart-1', { format: 'png', width: 1800, height: 800 }),
      Plotly.toImage('#chart-2', { format: 'png', width: 1800, height: 800 }),
      Plotly.toImage('#chart-3', { format: 'png', width: 1800, height: 800 }),
  ])` },
])
const [img1, img2, img3] = r[0].value
```

The `actions` argument (shared by `testApp` and `liveApp`) is a **flat
array of plain objects** — NOT a Playwright/Puppeteer callback API,
there is no `page`. Each entry is one of:

- `{ click: '#sel' }` — click an element
- `{ type: '#sel', value: 'text' }` — set an input's value
- `{ select: '#sel', value: 'opt' }` — pick a `<select>` option
- `{ wait: 500 }` — wait N milliseconds
- `{ read: '#sel' }` or `{ read: '#sel', prop: 'value' }` — read `textContent` (or a property)
- `{ eval: '<expr>' }` — evaluate a JS expression in the iframe and capture the result (awaits Promises — see above)
- `{ assert: '<expr>', message?: '...' }` — truthy/falsy gate; a failing assert throws from `testApp` (see the assert section below)
- `{ screenshot: true }` or `{ screenshot: '#sel' }` — capture a PNG (see the screenshot section below)
- `{ viewport: 'mobile' }` or `{ viewport: { width, height } }` — resize the test iframe mid-run so following actions/screenshots see a new shape (`testApp` only; see the responsive section below)

All values must be JSON-serializable (functions/closures fail with
`DataCloneError` — use `eval` for in-iframe JS). Results return as a
flat array mixing `{ type: 'log', level, message }` and per-action
entries — `{ type: 'eval', expr, value }`, `{ type: 'read', selector,
value }`, `{ type: 'screenshot', data }`; eval/read carry the result on
`value`. Keep result reads narrow (`querySelector` + textContent /
getAttribute) so you don't return giant blobs — DOM nodes / functions /
circular refs come back as descriptive strings, so don't try to return
an `Element` and click it from the agent side.

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

#### ⚠ A screenshot's `data` is a base64 string, NOT raw bytes

The `{ type: 'screenshot', data }` entry carries `data` as a **base64
PNG string** (no `data:` prefix) — plain text, not a `Uint8Array`.
That matters because `fs`, `renderPdf`, and the image response part's
`Uint8Array` path all speak **raw bytes**. Mixing the two silently
corrupts the image.

To embed a captured shot in your `taskSuccess` response, pass the
base64 string straight through — the image part wraps a bare base64
string for you:

```ts
const r = await testApp([{ screenshot: true }]);
const shot = r.find(x => x.type === 'screenshot')?.data;   // base64 string
taskSuccess(['Here it is:', { type: 'image', data: shot, alt: '...' }]);
```

**Don't `fs.write` the base64 string to a `.png`** — that stores the
*text* of the base64 (bytes `i`, `V`, `B`, `O`, `R`…), not a PNG. The
file viewer can't preview it, and reading it back as `Uint8Array` and
embedding it double-encodes into a broken image. If you want the shot
on disk, `atob`-decode to bytes first:

```ts
const bytes = Uint8Array.from(atob(shot), c => c.charCodeAt(0));
await fs.write('/scratch/shot.png', bytes);          // real PNG on disk
const back = await fs.read('/scratch/shot.png');     // Uint8Array, PNG magic
taskSuccess([{ type: 'image', data: back }]);        // renders fine
```

#### Responsive testing — viewport sizes

You can verify a responsive layout at desktop, tablet, and mobile
shapes. The size you choose is what the app's CSS media queries and
`window.innerWidth` see, and what any screenshot captures at. Sizes are
a preset name — `'desktop'` (1280×800), `'tablet'` (768×1024),
`'mobile'` (390×844) — or an explicit `{ width, height }`.

**Best for checking several breakpoints in one go: the `viewport`
action.** It resizes the live test iframe between actions, so a single
`testApp` boot can shoot every shape:

```ts
// One boot, three screenshots — look at all three next turn.
await testApp([
  { viewport: 'desktop' }, { screenshot: true },
  { viewport: 'tablet' },  { screenshot: true },
  { viewport: 'mobile' },  { screenshot: true },
])
```

After each resize the app relays out and settles before the next action
runs. **Caveat:** this fires a real `resize`, so apps that read
`window.innerWidth` *only once at init* (and don't listen for resize)
won't relayout. For those, boot fresh at each size instead — the third
`testApp` argument sets the **initial** viewport:

```ts
await testApp([{ screenshot: true }], false, 'mobile')
await testApp([{ screenshot: true }], false, { width: 1440, height: 900 })
```

The default (no action, no argument) is 800×600. The `fresh` argument is
positional, so pass it — usually `false` — to reach the `viewport` arg.

#### Canvas / animated apps

`testApp` paints a fresh animation frame right before each
screenshot, so a `<canvas>` or `requestAnimationFrame`-driven app
captures its *current* state — you don't need to call your draw()
manually first.

Two caveats for time-based apps (games, physics, anything whose
state advances inside a rAF loop):

- If the studio tab is backgrounded mid-test, the browser pauses
  rAF; the loop stops advancing and the screenshot shows the last
  painted frame. This is environmental, not a code bug.
- The frame pump *paints* — it doesn't *advance time*. To drive a
  time-based sequence deterministically (e.g. march a state machine
  through its phases), expose a plain `tick(dtSeconds)` on your app
  that runs one update step, then step it from the test:

  ```ts
  await testApp([
    { eval: 'window.engine.tick(0.6)' },   // advance state, no real frames needed
    { eval: 'window.engine.tick(0.6)' },
    { screenshot: true },                  // pump + capture the result
  ])
  ```

  This sidesteps rAF entirely and makes timing-dependent verification
  reproducible regardless of tab focus.

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

## Web Workers (off-thread compute)

For heavy work that would otherwise freeze the UI — big loops,
parsing, simulations, audio/image crunching, a WASM module — put it
in a worker. Name the file `*.worker.js` anywhere under `app/`; the
studio bundles it into a self-contained module worker and exposes a
`appWorker(name)` launcher. Pair it with Comlink so you call worker
functions like normal async functions instead of hand-rolling
`postMessage`:

```js
// app/sim.worker.js
import * as Comlink from 'comlink'        // resolved for you, same as anywhere else
Comlink.expose({
  step(state, n) { /* heavy loop over n */ return state },   // sync or async
})

// app/index.js
import * as Comlink from 'comlink'
const sim = Comlink.wrap(appWorker('sim.worker.js'))
const next = await sim.step(state, 1000)   // runs off the UI thread; returns a Promise
```

Notes:

- **Compute only — no agent capabilities inside a worker.** `query()`,
  `getCacheValue()`, `spawn()`, `notify()`, and the storage shim live on
  the main thread. A worker can't see them. Do the compute in the
  worker, return the result, and let the main thread call those.
- Args and return values must be **structured-cloneable** (objects,
  arrays, typed arrays, `ArrayBuffer` — not functions or DOM nodes).
  Large `ArrayBuffer`s can be transferred zero-copy via
  `Comlink.transfer(buf, [buf])`.
- The worker is a **persistent context** — module-level state survives
  across calls, so load a dataset/model once and call it many times.
- Every call is async (it's another thread), even if the worker
  function is synchronous.

## Things that don't work

- **JSX / TSX without a build step** — run `esbuild` (see the
  "JSX path" section above) to bundle to a runnable `.js`, or use
  HTM for the no-build path.
- **Agent calls (`query`/`getCacheValue`/`spawn`/`notify`) or storage
  inside a Web Worker** — those are main-thread only. Return compute
  results to the main thread and call them from there.
- **`SharedArrayBuffer` / threaded WASM in workers** — the app isn't
  cross-origin-isolated, so `SharedArrayBuffer` and shared-memory
  threads are unavailable. Plain workers and message-passing only.
- **`npm install` / `node_modules`** — there's no install step or
  bundler manifest. Bare specifiers resolve via esm.sh at runtime, so
  pure-ESM browser packages just work (`import _ from 'lodash'`), but
  anything needing native bindings, a build step, or Node-only APIs
  won't.
- **Same-origin `fetch('/api/...')`** — there's no server. Use
  `getCacheValue` for agent-side data, hardcode external URLs (CORS
  permitting) for third-party APIs.
- **`location.reload()` / navigation** (`location.href = ...`, link/form
  navigation) — your app is injected into the sandbox host, not served at
  a URL, so navigating reloads an empty bootloader shell and tears the app
  (and the test bridge) down. In `testApp` / `liveApp` this surfaces as a
  `NavigationError` and stops the action sequence. To "reload," reset your
  in-app state and re-render instead. To re-apply agent-pushed data (e.g.
  a new theme), re-run the apply step via `eval` rather than reloading.

## Static image / font assets

Drop binary files (images, fonts) into `app/` alongside your
source. Reference them by relative filename in HTML, CSS, or
runtime `fetch` — the iframe inlines them as data URLs at build
time, so all three forms work:

```html
<!-- app/index.html -->
<img src="logo.png" alt="logo">
<link rel="icon" href="favicon.png">
```

```css
/* app/style.css */
.hero { background: url('hero.jpg'); }
@font-face { font-family: x; src: url('x.woff2'); }
```

```js
// app/index.js — fetch() of relative paths works too
const r = await fetch('chart-data.csv')
const text = await r.text()
```

Supported extensions: png, jpg, jpeg, gif, webp, bmp, ico, svg,
avif, woff, woff2, ttf, otf, eot, mp3, mp4, webm, ogg, wav, pdf.
Nested paths work too — `app/icons/star.svg` is referenced as
`icons/star.svg`. `window.appAssets` exposes the full
`{ 'relative/path': 'data:...' }` map if you need to enumerate.

Don't use this for *agent-generated* data — use `getCacheValue`
for that. The asset pipeline is for files the agent (or user)
wrote to the VFS that the iframe needs to display.
- **`document.write`** — wipes the running app. Use DOM mutation.
- **`window.parent.location`** — cross-origin; reads blocked outright, writes gated by user activation and won't go where you want. Just don't.

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
