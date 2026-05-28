# Deploy

How the studio gets from `git push` to `agex.studio`. Plus the
pre-deploy smoke checks that have saved us from "works in dev,
broken in prod" surprises.

## Where it lives

GitHub Pages serves the static `dist/` from `main`. Custom
domain is set via `public/CNAME` (currently `agex.studio`).
The Pages workflow rebuilds on every push to main.

There's no backend; no other infrastructure to maintain.

## Build pipeline

```
git push origin main
    ▼
GitHub Actions (Pages workflow)
    ▼
npm install        ← installs @agex-ts/* from the npm registry
npm run build      ← vite build → dist/
    ▼
Pages publishes dist/ to <gh-pages branch / Pages bucket>
    ▼
agex.studio (custom domain via CNAME)
```

The vite config (`vite.config.js`) does a couple of
agex-studio-specific things:

- **`copyRunEntryPoint` plugin** — copies `dist/index.html` to
  `dist/run/index.html`. Why: the SPA serves a published-artifact
  entry point at `/run/?gist=...` (see `initSessionsFromUrl`).
  Vite's dev server has SPA fallback so any path locally returns
  index.html, but GitHub Pages doesn't. Without a real file at
  `/run/index.html`, the deployed `agex.studio/run/?gist=X` URL
  returns 404. Copying the entry point keeps the status code
  correct (200, not 404) without forcing a multi-entry vite
  config.
- **Standard Svelte + worker handling** — vite handles `?worker`
  / `?worker&url` / `?url` query suffixes for asset URL imports.

## Pre-deploy smoke checklist

The TS kernel work surfaced two classes of "works in dev,
breaks in prod" bugs that the test suite + dev server didn't
catch. Both relate to vite's prod-only transforms. Run through
this before pushing changes that touch worker setup, agent
registrations, or LLM-client wiring:

### 1. Function-name minification

Symptom in deploy: `agent.fn(): no name available — the value
has no usable .name property (anonymous / arrow / bound
function?)`. Pass `{ name: '...' }` explicitly.

Why dev didn't catch it: dev builds don't minify, so `fn.name`
returned the source-name (`"testApp"`, etc.). Prod builds
strip names to single chars, so `fn.name === ""` and the check
in agex-ts throws.

Defense: every `_agent.fn(fn, opts)` call in `ts-agent.js`
passes an explicit `name:` field. Hardcoded — independent of
whatever the minifier does. New host-fn registrations should
do the same.

To verify: `npm run build && grep "agent\.fn(): no name" dist/`
shouldn't match. (The agex-ts error string is in the bundle as
a literal; a grep for it just confirms the message text is
present — the actual check is at runtime.)

### 2. Worker bundling

Symptom in deploy: `worker failed during boot` the first time
the agent tries to emit. Dev works fine.

Why: the `@agex-ts/runtime-worker` package's `dist/worker.js`
has bare imports (`agex-ts/wrap-fs`, sibling chunks). Vite's default
behavior in prod is to copy the worker file verbatim into
`dist/`, leaving the bare imports unresolved (works in dev
because vite's dev server resolves them on the fly).

Defense: `ts-agent.js` imports the worker via
`agex-runtime-worker/worker?worker&url` so vite compiles it
as a worker entry point and bundles all imports inline. The
URL is passed explicitly to `workerRuntime({ workerUrl })`.

To verify after a build:

```bash
npm run build
grep -E "^import|from ['\"]" dist/assets/worker-*.js | head
```

The bundled worker should have **no bare imports** — only the
file's own minified body. If `agex-ts/wrap-fs` or similar
bare specifiers show up, the worker bundling regressed.

### 3. Smoke test on the built bundle

The cheapest end-to-end check that catches both classes plus
anything else prod-only:

```bash
npm run build
npx http-server dist/ -p 5174 --silent
# Open http://localhost:5174, send one chat message, watch console
```

Anything that errors in the browser console here would error
on the real deploy. Worth ~30 seconds before pushing major
changes.

## Cache invalidation post-deploy

The service worker (`src/sw.js` — caches Pyodide + the studio
bundle) does cache-busting via the bundle's hashed asset names.
A new deploy gets new hashes; the SW picks up the new
`index.html`, sees different asset refs, fetches them.

In practice users sometimes hit the *old* SW serving the old
bundle. Symptoms:

- "Site is broken since the last deploy" — but only for some
  users
- New features missing in the chat UI but old features still
  work

Workaround (user-side): hard refresh (Cmd-Shift-R) or
devtools → Application → Service Workers → Update.

We could add a "new version available" toast in the SW
`updatefound` event; not done yet because the symptom is rare
enough that hard-refresh is acceptable as a manual escape.

## Rolling back

`main` is the deploy branch. Roll back = revert the offending
commit + push:

```bash
git revert <bad-commit>
git push origin main
```

Pages picks up the revert and redeploys in a couple of minutes.
The cache-invalidation caveat above applies.

## Local-dev quirks

- **TS kernel cold-boot is fast** (~1s) and uses no service
  worker. Iterate freely.
- **Py kernel cold-boot is slow** (~30s for Pyodide + wheels)
  the first time per session. Subsequent reloads cached. If
  you're iterating on py-side code, run with the service
  worker registered so the cache hits.
- **`?gist=` URLs** require a real GitHub gist or a local mock.
  For testing the published-artifact flow without publishing,
  the simplest path is to manually save a `.agex.b64` payload
  to a local file and load it via the file drawer's import.

## Branch / PR conventions

`main` is the deploy branch — every push deploys. There's no
staging environment.

For larger changes that warrant review:

- Open a PR against `main`
- The gemini-code-assist bot leaves review comments
- After landing, push to main → deploy

For routine work (the bulk of this codebase's history), commits
land directly on main. Tests + the smoke checklist above are
the gate.

## What we don't do

- **Pre-deploy CI tests**. Tests run locally before commit. No
  GitHub Actions test step gates the deploy. If you want to add
  one, the existing `npm run build` already exercises most of
  the integration; a `npx vitest run` step would be additive.
- **Multi-environment deploys**. There's no `staging.agex.studio`.
  If you want to share a WIP, use the bundle export → secret
  gist flow.
- **Analytics / observability**. No telemetry collected from
  user sessions. Errors that escape to the chat are visible to
  the user (via the error bubble + stack trace) but not phoned
  home anywhere.

## Design notes

### Why GitHub Pages and not Vercel / Cloudflare?

Free, fast for static SPAs, no signup beyond the GitHub account.
The custom domain works without a paid tier. The vite-build
output is naturally Pages-compatible.

### Why no CI test gate?

The studio is a personal project; a missing-by-one-commit deploy
isn't a production incident. Adding CI tests is fine if you
prefer them — the existing test suite is fast (<2s).

### Why a CNAME and not a subdomain?

The custom domain (agex.studio) is the user-facing brand. Pages
supports it cleanly via CNAME + DNS. Subdomain on the
`*.github.io` namespace would work too, just less
brand-recognizable.
