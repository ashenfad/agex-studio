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
    pages only.
  - `filter/`: the filter format, its guards, and the engine that
    applies a filter to a page or tests it on a capture.
  - `capture/`: a page as the person sees it, and its rebuild for
    testing filters away from the live page.
  - `ids.js`: the fixed ids of the builds that load unpacked.
- `test/`: end to end, each build loaded into Playwright's Chromium.
- `build.mjs`, `dev-key.pub`, `site-key.pub`: the builds (below).

## Building

```bash
pnpm filters:build            # dist/prod: the store's
pnpm filters:build --site     # dist/site: the studio's download, a fixed id
pnpm filters:build --dev      # dist/dev: a fixed id, for local work and the tests
```

Scripts are bundled with esbuild (the version the repo's Vite brings).
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
