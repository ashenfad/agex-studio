# The site-filter extension

An agent, running inside the extension, writes a filter for each site
the person submits a page from: the clutter and native ads that filter
lists miss. The person previews it, accepts it, and turns it on or off.
The design, and what's built so far, are in
[`roadmap/site-filters.md`](../../roadmap/site-filters.md).

It is a separate extension from the browsing one (`extension/`): its
permissions differ (no `debugger`; sites asked for one at a time), and
neither widens the other's.

## Layout

- `src/`: what runs in the extension. Bundled, since it imports
  packages (agex-ts):
  - `background.js`: the service worker. It answers the extension's own
    pages only, and makes the offscreen document when the agent is
    needed.
  - `offscreen.js`: the offscreen document. It keeps the agent's store
    (kvgit on the extension's IndexedDB) and frames the sandbox.
  - `sandbox.js`: the sandboxed page (the manifest's `sandbox`), the one
    page that may eval, where agex-ts runs: a session per site, the
    world's kernel in a worker. Its origin is opaque and it has no
    `chrome.*`, so it asks the offscreen document for its store
    (`host/kv.js`). Its CSP (`SANDBOX_CSP` in `build.mjs`) allows no
    connections: neither it nor the agent's code can send anything
    anywhere.
  - `host/`: what crosses the sandbox's wall: the store (`kv.js`) and
    the model (`provider.js`: a stand-in in the sandbox, the real
    provider in the offscreen document, built from the person's
    settings, so the key never enters the sandbox); a session per site
    (`sessions.js`, `site-reddit_com` for `reddit.com`); and the
    kernel's worker started as a classic one (`worker.js`: a module
    worker from a blob can't start in an opaque origin; the build refuses
    a kernel worker that needs one). One turn runs at a time, across all
    sites.
  - `filter/`: the filter format, its guards, and the engine that
    applies a filter to a page or tests it on a capture.
  - `capture/`: a page as the person sees it, and its rebuild for
    testing filters away from the live page.
  - `app/`: the extension's own page (its options page, and for now
    what the toolbar button opens): the person's model and key, with
    the studio's `ModelSettings` and styles, saved in the extension's
    `localStorage` (the offscreen document reads them again when they
    change), and the sites with a session. Built with Vite and Svelte.
  - `ids.js`: the fixed ids of the builds that load unpacked.
- `test/`: end to end, each build loaded into Playwright's Chromium;
  `model-server.mjs` is a model service of the tests' own, in the
  OpenAI-compatible shape, so a turn on the person's-model path needs no
  key.
- `build.mjs`, `dev-key.pub`, `site-key.pub`: the builds (below).

## Building

```bash
pnpm filters:build            # dist/prod: the store's
pnpm filters:build --site     # dist/site: the studio's download, a fixed id
pnpm filters:build --dev      # dist/dev: a fixed id, for local work and the tests
```

Scripts are bundled with esbuild (the version the repo's Vite brings),
minified except in the dev build, which also has the tests' ops
(`__DEV__`: a turn on a scripted model, the offscreen document closed).
The site and dev builds each carry a public key, which fixes the id an
unpacked copy has (`src/ids.js`). Neither needs its private key, and
neither's is kept. The icons are the browsing extension's.

To try it: `chrome://extensions`, Developer mode, **Load unpacked**, and
choose `extensions/filters/dist/dev`.

## Testing

```bash
npx vitest run extensions/filters   # the units
pnpm filters:test                   # end to end, in Chromium (HEADED=1 shows it)
```
