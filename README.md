# Agex Studio

**[agex.studio](https://agex.studio)**: a person and an agent working
together in the browser. No server, no backend: your sessions live in
your browser, and the agent runs on your own model key.

Each session is a workspace of its own: files under `/workspace`, a
shell, and TypeScript the agent runs in a sandboxed worker. Everything
in it is versioned, so any turn can be undone, and any point forked.
Bring a key for [OpenRouter](https://openrouter.ai/) (the default), a
direct provider, or an endpoint of your own (a local proxy, say).

## What it does

- **Apps in a live preview.** Ask for a tool, a dashboard or a game and
  the agent builds it under `/workspace/app`; it renders beside the
  chat as its files change, in a separate origin. The agent checks what
  it built with `test_app`, in a hidden page of its own, clicking,
  reading and taking screenshots. JSX bundles in the browser with
  `esbuild`.
- **Rich replies.** The agent puts what it wants shown in `ui` (a Plotly
  chart, a table, a row of cards, an image) and embeds it in its reply.
  Each artifact is a file, so it is versioned with the rest.
- **Tools for the agent's code:** `web` (search and page reading),
  `media` (images, speech, music, written into the workspace) and `pdf`
  (text and pages as images). `web` and `media` run on an OpenRouter
  key.
- **Sessions that fork, undo and sync.** Fork with the conversation,
  with only the files, or as the session is now without its history.
  Undo a turn and everything after it, and redo it. With a private
  GitHub repo of your own, sessions sync between devices, an app's
  saved data with them.
- **Delegation.** The agent hands separable work to delegates, forks of
  itself that run in the page beside it; their answers wake it, and it
  merges their work with `ws-git`, its own git.
- **Apps that call agents.** An app defines its own agent tasks
  (`agex.task`) and calls them; they run on the viewer's model, within a
  per-visit budget, and an app from someone else asks before its first
  call.
- **Sharing.** Export a session as a bundle (`.agex`), or publish it as
  a secret gist: the link opens it in anyone's browser, the app alone
  with `&play=1`, and publishing again updates it in place.
- **Google Drive import**, and uploads from the device, into
  `/workspace/uploads`.

## What leaves your browser

Nothing is stored on a server of ours. A few features reach other
origins:

- **Your model's endpoint**, for every turn: OpenRouter, or the one you
  set. `web` and `media` call OpenRouter too.
- **esm.sh**, when code or an app imports a bare npm package.
- **`apps.agex.studio`**, the origin the preview's iframe loads from (a
  static bootloader; the app's HTML is posted to it in the page, not
  uploaded).
- **GitHub**, only if you connect sync (your repo) or publish (your
  gists), and to open a published link (its gist).
- **Google Drive**, only when you import from it.

## Getting started

1. Visit **[agex.studio](https://agex.studio)**.
2. Open settings (⚙) and enter your OpenRouter key and a model.
3. Ask for something.

The in-app docs (`public/docs/`) cover sessions, sharing and the agent.

## Running it locally

The studio is built on [agex-ts](https://github.com/ashenfad/agex-ts)'s
packages from npm (`agex-ts`, `@agex-ts/world`, `@agex-ts/kvgit`,
`@agex-ts/kvsql`, `@agex-ts/termish`). Node 22 and pnpm 11.

```bash
pnpm install
pnpm dev                # http://localhost:5173
```

- **Port 5173.** The preview's bootloader (at `apps.agex.studio`) takes
  its app only from a studio on port 5173 or 4173, so the preview
  doesn't work on another one.
- **Settings (⚙):** an OpenRouter key and a model
  (`meta/muse-spark-1.3-contributor` is cheap and works end to end), or
  an endpoint of your own: its URL, its shape (Anthropic or
  OpenAI-compatible) and a key if it needs one. Sync and publishing
  take tokens of their own, in the same dialog.
- **Google Drive import** needs `VITE_GOOGLE_CLIENT_ID` and
  `VITE_GOOGLE_API_KEY` in `.env`; without them, "From Drive" isn't
  offered.
- **The preview's origin.** By default the preview loads its bootloader
  from `https://apps.agex.studio`. To use a local copy of
  [agex-studio-apps](https://github.com/ashenfad/agex-studio-apps),
  serve it and point the studio at it:
  `VITE_APPS_ORIGIN=http://localhost:8090 pnpm dev`.
- **Against a local agex-ts:** to try an unreleased change, point the
  packages at a built clone (`pnpm -r build` in it) with
  `"link:../agex-ts/packages/<dir>"` in `package.json` and a
  `pnpm install`, and don't commit that change.
- **The production build:** `pnpm build && pnpm preview`
  (http://localhost:4173). The build copies the page to
  `dist/run/index.html`, so a published link's `/run/` path is served
  by a static host.

Your local sessions live in IndexedDB for `localhost:5173`, apart from
agex.studio's.

### Checks

```bash
pnpm vitest run         # the tests
pnpm typecheck
```

**Driving the studio** from a terminal: `scripts/drive.mjs` opens it in
headless Chromium, sends each prompt as a turn through a dev-only hook
(`window.__studio`), and prints the tool calls, results, reply and
files. The model comes from the environment, and the key is never
printed.

```bash
OPENROUTER_API_KEY=… pnpm drive "Write a haiku about rivers to /workspace/haiku.txt"
pnpm drive --scripted steps.json "go"            # a scripted model: no model call
pnpm drive --profile .drive-profile --reload     # keep the browser's data; the record after a reload
pnpm drive "build a counter" --exec "s.files()" --shot out.png
```

- `DRIVE_MODE` (`openrouter`, `custom` or `scripted`), `DRIVE_MODEL`,
  `OPENROUTER_API_KEY`; for a custom endpoint `DRIVE_BASE_URL`,
  `DRIVE_WIRE`, `DRIVE_API_KEY`.
- `DRIVE_SYNC_REPO` and `DRIVE_SYNC_TOKEN` connect sync;
  `DRIVE_PUBLISH_TOKEN` lets it publish.
- `--url` (a studio already running), `--apps <dir>` (serve a local
  agex-studio-apps as the preview's origin), `--open <path>` (open a
  path first, a `/run/?gist=…` link say), `--quiet`, `--requests`.
- It needs Playwright's Chromium; set `CHROME` to a Chromium binary if
  that isn't installed.

## Docs

- [**docs/**](docs/): how the studio is built: sessions and storage,
  the agent's turns, the app preview, sync and sharing, delegation.
- [docs/operations/deploy.md](docs/operations/deploy.md): how it
  deploys, and the checklist for a deploy.
- [roadmap/rebuild.md](roadmap/rebuild.md): the rebuild on agex-ts,
  step by step, and what is deferred.

## Part of the agex stack

- [agex-ts](https://github.com/ashenfad/agex-ts): the agent loop
  (`agex-ts`), the world it works in (`@agex-ts/world`), versioned
  storage (`@agex-ts/kvgit`) and the shell (`@agex-ts/termish`)
- [agex](https://github.com/ashenfad/agex): agent orchestration, in Python
- [nontainer](https://github.com/ashenfad/nontainer): the Python world
  `@agex-ts/world` follows
- [kvgit](https://github.com/ashenfad/kvgit): versioned key-value
  store, in Python
- [monkeyfs](https://github.com/ashenfad/monkeyfs): virtual filesystem
- [sandtrap](https://github.com/ashenfad/sandtrap): Python code sandbox
- [termish](https://github.com/ashenfad/termish): shell emulator, in
  Python
