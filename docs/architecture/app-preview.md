# App preview

The live preview pane renders agent-built apps in a sandboxed
iframe alongside the chat. Two execution paths feed it: the iframe
that the user actually sees (driven by `liveApp`), and headless
iframes the agent spawns for verification (driven by `testApp`).
Both share `buildAppHtml` for assembly.

## Iframe isolation: cross-origin host

`AppPreview.svelte` (and `app-control.js`'s test_app iframes)
load a bootloader page from `https://apps.agex.studio/` — a
separate origin served from the [`agex-studio-apps`](https://github.com/ashenfad/agex-studio-apps)
repo. The studio posts the actual app HTML to the bootloader
over `postMessage`; the bootloader receives the HTML and
replaces its document with it via `document.open()` /
`document.write()` / `document.close()`.

The agent's app then runs at `apps.agex.studio`'s origin.
Cross-origin same-origin policy gives us:

- Agent code can't reach `agex.studio`'s `localStorage`,
  IndexedDB, cookies, settings, or any other origin-scoped
  resource.
- Agent code can't read the parent window's DOM.
- The parent can't reach into the iframe's document either.

Communication between parent and iframe is strictly
`postMessage` with origin validation on both sides.

### What the bootloader URL looks like

`{APPS_ORIGIN}/?t={timestamp}`. The timestamp cache-busts so
re-renders force the bootloader to reload (same-URL navigation
would be a no-op). `APPS_ORIGIN` is exported from
`src/lib/apps-origin.js` and defaults to `https://apps.agex.studio`;
override via `VITE_APPS_ORIGIN` for local dev against a
locally-served copy of agex-studio-apps.

### Why cross-origin and not sandbox-opaque

Earlier versions of the studio used `sandbox="allow-scripts"`
on a same-origin blob URL — the iframe ran with an **opaque
origin**, which provided the isolation but came with real
limitations: opaque origins can't accept persistent permissions
(`getUserMedia` failed for kalimba tuners and similar), can't
read cross-origin stylesheet rules (Leaflet/MarkerCluster CSS
introspection broke), and hit a long tail of services that
filter requests by `Referer` (Plotly tile providers returned
nothing). Cross-origin sandboxing via a separate domain
provides equivalent isolation without any of these issues.

The iframe drops the `sandbox` attribute entirely and uses an
`allow=` permissions-policy list to delegate features
(microphone, camera, geolocation, etc.) down to the apps origin.

## `buildAppHtml` pipeline

Located in `src/lib/pyodide.js` (the name is historical — the
function is kernel-agnostic). Inputs: a `Record<string, string>`
of text files under `app/`, an optional `Record<string, Uint8Array>`
of binary assets, and an `appStorage` config. Output: a complete
HTML document string the studio sends to the iframe's
bootloader via `postMessage` (see "Iframe isolation: cross-origin
host" above).

What it does, in order:

1. **Pick the entry HTML.** `appFiles['app/index.html']` or
   `appFiles['index.html']`. If neither exists, synthesize a
   minimal scaffold with `<div id="app"></div>` and inline
   `main.js`.
2. **Build the binary asset map.** For each entry in
   `appBinaries`, encode bytes → base64 → `data:<mime>;base64,...`
   data URL (see `app-assets.js`).
3. **Inline CSS files.** Each `<link href="style.css">` reference
   gets replaced with `<style>{contents}</style>`. CSS content
   has its `url(...)` references rewritten to data URLs first
   (so background images / fonts work).
4. **Build an import map.** Each JS file under `app/` becomes a
   `data:text/javascript,...` URI in an import map; bare
   imports route through the iframe's CDN entries (preact,
   plotly, marked, dayjs, etc.).
5. **Rewrite local imports.** `import './foo.js'` inside JS files
   becomes `import 'app:foo.js'` so the import map resolves it
   to the data URI.
6. **Rewrite `<script type="module" src="...">` tags** to
   import-via-import-map.
7. **Inject** in order: console interceptor, app-storage shim,
   asset-map + fetch monkey-patch, query bridge, agent control
   bridge, CDN script tags.
8. **HTML-level asset rewrites.** `<img src="logo.png">`,
   `<link rel="icon" href="favicon.png">`, etc. — `src` / `href` /
   `poster` attrs matching a known asset path get swapped for
   their data URLs.

Implementation note: the rewrite passes happen *after* CSS
inlining so the just-inlined `<style>` blocks also get their
`url(...)` references rewritten. See
`_resolveAppModules` in `pyodide.js` and `app-assets.js`'s
`rewriteHtmlAssetRefs` / `rewriteCssAssetRefs`.

## The asset pipeline (binary files in `app/`)

Sub-system that lets agents drop images/fonts/etc. into `app/`
and reference them naturally:

```html
<img src="logo.png">
<link rel="icon" href="favicon.png">
```

```css
.hero { background: url('hero.jpg'); }
@font-face { src: url('font.woff2'); }
```

```js
const r = await fetch('chart-data.csv');
```

Three of these (HTML attrs, CSS `url(...)`, runtime `fetch`)
each need a different rewrite strategy:

| Reference type | Handled by |
|---|---|
| `<img src="x">`, `<link href="x">`, `<source>`, `<video poster>` | `rewriteHtmlAssetRefs` — pre-build attribute rewrite |
| CSS `url(...)` in `<style>` blocks (inline or inlined-from-file) | `rewriteCssAssetRefs` — body rewrite |
| Runtime `fetch('x')` | `buildAssetsScript` injects a `window.fetch` monkey-patch that checks `window.appAssets` first |

What's NOT covered: imperatively-set `<img>.src = "x.png"` after
page load. Browsers route those through the image loader, not
`fetch`, and the HTML-rewrite pass ran before that JS executed.
For full coverage we'd need a service worker scoped to the
iframe; deferred until a real use case demands it.

`isBinaryAppFile(path)` is the canonical predicate for "is this
a binary asset?" — extension allowlist in `app-assets.js`. The
adapter's `readAppFiles` / `readAppBinaries` split text vs
binary by this predicate.

## `testApp` vs `liveApp`

Two host fns, two iframes, two state semantics. Agents reach for
the wrong one all the time without prompting — the skill doc
calls it out explicitly.

### `testApp(actions?, fresh?)`

Headless iframe the agent spawns to verify their work *before*
committing. Loads from `app/` files currently in the VFS,
including uncommitted writes from this turn.

- Iframe is created hidden (in-viewport but `opacity: 0`,
  `pointer-events: none`, `z-index: -1`). In-viewport on purpose
  — the classic "iframe at `left: -9999px`" trick triggers
  Chromium's animation-throttle and breaks CSS keyframe
  animations.
- App-storage is seeded from the persisted entry (so tests see
  real user state) but writes during the test are **discarded**.
- `actions` execute against the iframe's DOM via the bridge.
- Returns an array mixing `{type: 'log', ...}` log entries from
  the iframe's `__agex_logs` buffer and per-action result entries
  (`{type: 'eval', value}`, `{type: 'screenshot', data}`, etc.).

### `liveApp(actions?)`

Drives the iframe the *user* is looking at. Reflects the
**last-committed** `app/` files — uncommitted writes from this
turn aren't visible until `taskSuccess` fires the commit.

- No iframe creation; uses the already-mounted preview iframe via
  `appControlGetLiveIframe()`.
- Same action shape as `testApp`.

This last invariant ("uncommitted writes invisible") is the
source of the most common confusion in the skill — "I edited the
app but `liveApp` doesn't see it." The chat task primer warns
about it; the skill (`interactive-app.md`) is more explicit.

If a refactor adds optimistic-write previews, that warning
becomes a lie and apps render with inconsistent state. Don't.

## Action vocabulary

Defined in `iframe-bridge.js`. The agent passes an array of
plain-object actions; each gets dispatched against the iframe's
document.

| Action | Behavior | Returns |
|---|---|---|
| `{click: '#sel'}` | Click the element | `null` (no result entry) |
| `{type: '#sel', value: '...'}` | Set input value + fire input + change | `null` |
| `{select: '#sel', value: 'opt'}` | Set select value + fire change | `null` |
| `{wait: N}` | Sleep N ms | `null` |
| `{read: '#sel'[, prop]}` | Read `el.textContent` (or `el[prop]`) | `{type: 'read', selector, value}` |
| `{eval: 'expr'}` | Indirect-eval, auto-await Promises | `{type: 'eval', expr, value}` (value is JSON-encoded) |
| `{assert: 'expr', message?}` | Eval as truthy/falsy; throws on falsy | `null` on pass; throws on fail |
| `{screenshot: true \| '#sel'}` | Capture DOM as PNG | `{type: 'screenshot', data}` — bytes emitted as image observation between turns |

Critical UX detail on `screenshot`: the returned `data` field is
a sentinel string — the actual base64 has already been emitted as
an `image` observation that lands in the agent's *next-turn*
context (not this turn). The agent must not call `taskSuccess`
immediately after a screenshot if they want to reason about its
contents; they need to commit + wait for the next turn. The
skill explains this with a worked example.

## Size caps

Several layers cap result sizes so a runaway action doesn't blow
the next turn's prompt. From inner to outer:

| Cap | Where | What it stops |
|---|---|---|
| 50 KB | `iframe-bridge.js` `_jsonifyEvalResult` | Big eval return values |
| 50 KB | `iframe-bridge.js` `_capString` | Big read-action property readbacks |
| 50 KB/msg | `pyodide.js` `CONSOLE_INTERCEPTOR` | In-iframe `console.log(bigObj)` |
| 256 KB total | `app-control.js` `collectResults` | Backstop on combined return — drops earliest entries (logs first; action results survive) and prepends a synthetic warning |

50 KB is generous for honest debug data, tight enough that
pathological dumps (data-URI floods, full-page HTML, embedded
binaries) trip the truncation notice. When capped, the agent
sees a parse-safe JSON-encoded notice string carrying the
original size — they can adapt their next call.

Independent of these, agex-ts has its own per-arg cap in
`safeStringify` (50 KB / arg) so `console.log(bigThing)` from
the *agent's own TS code* (not the iframe's JS) is bounded
upstream of the studio.

## The control bridge protocol

Parent ↔ iframe communication uses `window.postMessage` with a
typed envelope. Defined in `iframe-bridge.js`'s
`handleControlMessage` and `sendControl`.

Outbound (parent → iframe):

```ts
{ type: 'agex-control', id: <number>, action: <ActionDict> }
```

Inbound (iframe → parent):

```ts
{ type: 'agex-control-result', id: <number>, data: ..., error: null }
{ type: 'agex-control-result', id: <number>, data: null, error: <string> }
```

Parent matches inbound replies by `id`. Multiple in-flight
actions (e.g., the agent's `liveApp` while their `testApp` is
also running in a different iframe) are independently routed.

The iframe also pushes some unsolicited messages:

- `__agex_query` — the py kernel's app↔agent query bridge
  (TS-side currently throws "not yet implemented"; queries route
  through agex-py's `runQuery`).
- `__agex_cache_get` — the asset-bridge / `getCacheValue`
  helper agents reach for to read agent-stashed data.
- `__agex_app_storage_*` — shim for the per-session iframe
  localStorage.

## Design notes

### Why the iframe runs at a cross-origin host

Tight: an agent's app can't read the parent window's data
(same-origin policy gates DOM access cross-origin), can't reach
the studio's localStorage / IndexedDB / cookies, and can only
communicate via the postMessage bridge with explicit origin
validation. The cost is the bootloader handshake + asset-
inlining acrobatics — worth it because the agent is an unknown
actor running unverified code, AND because the cross-origin
approach unlocks browser features the sandbox model blocked
(persistent permissions, cross-origin stylesheet introspection,
Referer-aware services).

### Why `buildAppHtml` lives in `pyodide.js`

Historical. The function was original to the py kernel's
worker bridge. It's kernel-agnostic now, and the file naming is
misleading. A future refactor could split it out as
`build-app-html.js` — the existing tests in
`pyodide.test.js` already exercise it through the kernel
boundaries.

### Why `?worker&url` for the agex-runtime-worker import

See [vendoring-agex-ts.md](../operations/vendoring-agex-ts.md)
and the prod-build comment in `ts-agent.js`. tl;dr: the
vendored worker file has bare imports vite doesn't resolve
by default in prod builds; `?worker&url` tells vite to compile
it as a worker entry point and bundle its imports inline.
