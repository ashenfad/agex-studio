# Deploy

How the studio gets from `git push` to `agex.studio`, and the checklist
for a deploy: the switch to the rebuild first of all.

## Where it lives

GitHub Pages serves the static `dist/` from `main`; the custom domain is
`public/CNAME` (`agex.studio`). There's no backend.

The preview's apps run on a second origin, `apps.agex.studio`, served by
GitHub Pages from [agex-studio-apps](https://github.com/ashenfad/agex-studio-apps):
a static bootloader (and the OAuth relay page) the studio's preview
iframe loads, then posts the built app to. It deploys on its own; the
studio only needs it up. The bootloader takes an app only from a studio
at `agex.studio`, or from `localhost` on port 5173 or 4173 (dev and
`vite preview`).

## Build

```
git push origin main
    ▼
GitHub Actions: .github/workflows/deploy.yml
    ▼
install, then vite build → dist/   (Google ids from repo secrets)
    ▼
actions/deploy-pages publishes dist/
    ▼
agex.studio
```

What `vite.config.js` adds to a plain Vite build:

- **`dist/run/index.html`**, a copy of `dist/index.html`. A published
  session's link is `/run/?gist=…`; Vite's dev server answers any path
  with the page, GitHub Pages doesn't, so the page has to exist there.
  Assets load by absolute path (`/assets/…`), so it works from `run/`.
- **The world's worker**, imported as
  `@agex-ts/world/worker?worker&url` and bundled as a worker entry
  (`dist/assets/worker-*.js`), its URL passed in each session's
  profile.
- **Chunks:** the entry (`index-*.js`, about 390 KB gzipped) loads
  first; the TypeScript type stripper and its compiler (about 1 MB
  gzipped) come in a chunk of their own on the first code run, and
  esbuild-wasm on the first `esbuild`.

`deploy.yml` installs with pnpm (`pnpm install --frozen-lockfile`)
and runs `pnpm build`, taking agex-ts's packages from npm.
`.github/workflows/test.yml` runs the same install, then the typecheck,
the tests and the build, on pushes and pull requests to `main` and
`rebuild`, so a pull request's checks build what the deploy would.

The Google ids stay as they are: `VITE_GOOGLE_CLIENT_ID` and
`VITE_GOOGLE_API_KEY`, from the repo's secrets.

## The switch to the rebuild

Before merging:

- [ ] `pnpm build` locally: `dist/run/index.html` is there, and
      `dist/assets/` has the entry, the type-stripper chunk and the
      worker.
- [ ] `pnpm preview` (port 4173, which the bootloader accepts): a turn
      on a real model works, and the preview shows an app.
- [ ] The pull request's Tests run passes: its build is the deploy's
      (above).

Then `rebuild` becomes `main` (merge or fast-forward), Pages deploys,
and on **agex.studio**, in a fresh browser profile:

- [ ] **First load.** The network panel: the entry chunk about 390 KB
      gzipped; the type-stripper chunk not loaded until the first code
      run.
- [ ] **A turn** on a real model (OpenRouter key; Muse Spark or the
      default model): it streams, runs code, writes files, and a reload
      shows it again.
- [ ] **The preview**, through `apps.agex.studio`: ask for a small app;
      it renders beside the chat and rebuilds as its files change.
- [ ] **`test_app`**: the agent checks the app it built; with vision on,
      its screenshot comes back.
- [ ] **Rich replies**: ask for a chart and a table; both render in the
      reply.
- [ ] **Sync** with a real fine-grained token: a private repo with a
      README, a token with Contents read and write on it alone, connect
      in settings, then two browsers: a session made in one appears in
      the other, a turn in either syncs, and an app's saved data
      follows. *Not verified before the switch: every live run used a
      classic token.*
- [ ] **Publish** a session with an app to a gist, then open its
      `/run/?gist=…&play=1` link in a fresh browser with no model key:
      the app alone shows; "how it was made" shows the conversation.
      *Not verified before the switch on the real host: `/run/` was
      checked in dev only.*
- [ ] **An app that calls an agent**: publish an app using `agex.task`;
      in a fresh browser with a model key, its first call asks ("This
      app asks to use your model…"), and allowing it runs the task.
- [ ] **Google Drive import** (the Files tab, "From Drive"): sign-in, the
      Picker, a file lands in `uploads/`. The OAuth client must list
      `https://agex.studio` among its JavaScript origins. *Not verified
      before the switch: sign-in can't run headless.*
- [ ] **The leave warning**: with a turn running, closing the tab asks
      first.

## Watching, and rolling back

There's no telemetry: what goes wrong shows in the browser's console
and the chat's error line. After a deploy, watch the console on the
checks above, and the Actions run.

Roll back by reverting and pushing:

```bash
git revert <bad-commit>
git push origin main
```

Pages redeploys in a couple of minutes. For the switch itself, the old
studio stays in `main`'s history (and its packages on npm): reverting
the switch brings it back. Sessions don't move between the two: each
keeps its own IndexedDB data (the rebuild's database is
`agex-studio`), so rolling back leaves the rebuild's sessions in place
for when it returns.

Hashed asset names make a new deploy's files new URLs; a tab open
across a deploy keeps its old code until it reloads.

## Conventions

`main` deploys on every push; there's no staging. Larger changes go
through a pull request (Codex reviews it); during the rebuild, pull
requests target `rebuild`, one per step.

## Design notes

**Why GitHub Pages?** Free, fast for a static app, the custom domain
works without a paid tier, and Vite's output fits it as it is.

**Why a second origin for apps?** An app's code runs in a page that
can't reach the studio's storage, its keys or its DOM: the preview's
iframe loads from `apps.agex.studio`, and the two talk only by
`postMessage`, each checking the other's origin.
