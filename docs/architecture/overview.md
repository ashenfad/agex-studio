# Overview

Agex Studio is a single-page Svelte app that runs entirely in the
browser. A person chats with an agent in a session; the agent works in
the session's own workspace (files, a shell, TypeScript it runs) and
can build an app that renders in a sandboxed preview beside the chat.
There is no backend: models are called from the page with the
person's key, and storage is the browser's IndexedDB, with GitHub (a
repo for sync, gists for publishing) as the only shared place.

## The pieces

```
agex.studio (static SPA)                         apps.agex.studio
┌──────────────────────────────────────────┐    ┌──────────────────┐
│ App.svelte                               │    │ bootloader       │
│  SessionList · Chat · SplitPane ·        │    │ (the app's page, │
│  Workbench (AppPreview ──────────────────┼───►│  another origin) │
│   · FilesPanel) · SettingsDialog         │◄───┤                  │
│                                          │    └──────────────────┘
│ studio.svelte.js                         │
│  Studio: the sessions, the one shown     │
│ session.svelte.js                        │
│  ChatSession: one session's workspace,   │
│   its turns, its delegates               │
│        │ agex-ts: Agent, Session         │──► model provider
│        ▼                                 │    (OpenRouter, Anthropic-
│ @agex-ts/world: Store, Workspace,        │     or OpenAI-shaped)
│  the tools, the kernel's worker          │
│        │ @agex-ts/kvgit                  │──► GitHub: sync repo
│        ▼                                 │    (PackRemote), gists
│ IndexedDB ("agex-studio")  localStorage  │
└──────────────────────────────────────────┘
```

## The packages

The studio is built on four agex-ts packages:

- **`@agex-ts/kvgit`**: a versioned key-value store (branches,
  commits, merges) over a KV backend (IndexedDB here), and its GitHub
  transport, `PackRemote`.
- **`@agex-ts/termish`**: the shell the agent's `terminal` tool runs.
- **`@agex-ts/world`**: sessions and workspaces on kvgit (a `Store`
  of sessions, each a branch), the agent's tools with their names and
  result text, the kernel that runs TypeScript in a worker, host
  objects, skills, `ui` artifacts, ws-git, and delegation's `Sessions`.
- **`agex-ts`**: the agent loop: `Agent` and `Session`, the run
  record, AI SDK models as providers, folding, delegation's runner,
  and tasks.

The studio takes them from npm; a change there reaches the studio as a
release and a version bump here.

## A session and a turn

A session is one branch of the store (`openStore()` in `store.js`:
`Store.open` over `IndexedDB.open({dbName: "agex-studio"})`).
`ChatSession` (`session.svelte.js`) holds one open `Workspace` for it,
opened with `PROFILE` (`profile.js`: the kernel's worker, esm.sh for
bare imports, `ui` artifacts, the host objects, the `esbuild` and
`ws-git` commands, the skills).

Each turn builds a new agex-ts `Agent` from the settings (an `Agent`
holds nothing, so the settings can change between turns) and runs an
agex-ts `Session` over the workspace (`ChatSession.#session`). The chat
renders the `TurnEvent`s the turn streams, then, when it ends, the run
record agex-ts stored in the workspace (`reader.runs()`). Every tool
call commits; the history is the session's branch.

What the studio keeps of its own (a title, undo points, where an
import came from, delegate records) is on the session's `studio` plane
(`ws.plane("studio")`), so it rewinds with a checkout, comes along on
a fork, and syncs with the session. See
[sessions-and-storage.md](sessions-and-storage.md).

## The app preview

An app is files under `/workspace/app`. `AppPreview.svelte` builds
them into one HTML page (`buildAppPage`) and posts it to a bootloader
served from a separate origin (`APPS_ORIGIN`, `apps.agex.studio` in
production), so an app's code can't reach the studio's storage, DOM or
keys. The app talks back to the studio by `postMessage`: its storage,
cached values, notifications, and agent tasks. `test_app` builds the
same page in a hidden iframe. See [app-preview.md](app-preview.md).

## Around the chat

- **SessionList**: the sessions, newest first; a double-click renames
  one, and its hover tray forks it (⑂) or opens its **SessionDialog**
  (⋯: name, fork full / files only / as it is now, export, publish,
  delete); import a bundle; with sync on, each session's sync state, the
  repo's other sessions, and its trash. A dot before a title is the
  session's status (`status.js`): the accent, pulsing, while a turn or
  a fold runs; amber when a turn ended failed or interrupted while the
  person wasn't looking; green when one finished then. The tab's icon
  carries the most pressing of them (working, then amber, then green)
  as a dot of the same color (`favicon.js`: the shipped `/favicon.svg`
  with a circle spliced in, its href put back when there's nothing to
  say).
- **The transcript's embeds**: charts, tables, images, HTML and
  Mermaid diagrams are read and drawn only once they come within
  1500px of the chat's view (`lazy.js`: one `Nearby` per chat, an
  `IntersectionObserver` and a `ResizeObserver`), a box of about their
  size holding their place until then (`Deferred.svelte`; a height once
  drawn is remembered). The chat keeps its own place as they grow: at
  the end it follows them, and one wholly above what's being read
  scrolls the list by as much, so the reader's view stays still (one
  they're partway into keeps its top, as the browser's anchoring would). A new kind of
  embed gets the same by being wrapped in `Deferred` with its
  placeholder's height. At a turn's end only the runs that changed are
  new objects (`runs.js`), so the rest aren't drawn again, and an
  earlier reply's embeds, fixed at its commit, aren't read again.
- **Composer**: the message box: files attached as chips (+, a drop on
  the chat, a pasted image), and Send, which is Stop while a turn runs
  with nothing written.
- **The layout**: the session list folds away (☰ or ⌘B; a drawer on a
  narrow screen); the chat and the workbench split where the person
  drags the divider, kept between visits, and dragging it past the left
  edge hides the chat; on a narrow screen one pane shows at a time, a
  round button switching them.
- **Workbench**: beside the chat, two tabs under one bar. App: the
  preview, rebuilt on request, its agent meter, and full screen (Esc
  back). Files: the session's files as a tree, each opening in a modal
  to read, download or delete; upload from the device or Google Drive
  into `uploads/`.
- **SettingsDialog**: three tabs, anchored near the top of the window
  so it grows and shrinks downward, its header and buttons fixed while
  a tab's content scrolls; Escape closes it from anywhere (an open
  list's Escape closes the list first). **Model**: the service (a
  toggle: OpenRouter or an endpoint of the person's own, each keeping
  its own model), its key and model (OpenRouter's picked from its
  catalog with `ModelPicker`), and thinking up front; under the
  OpenRouter key, whether OpenRouter accepts it and what it has spent
  today and this month, with a "more" toggle for a limit, the free
  tier and spending through the person's own provider keys
  (`RouterKeyCheck`, asking OpenRouter's `/key` as the dialog opens and
  once typing pauses, a stale answer dropped; the link to make a key
  only while there's none or a rejected one). The rest is under
  **Advanced**, collapsed, its header summing up what's set: provider
  routing and privacy (OpenRouter), whether the model takes images (when
  OpenRouter's catalog doesn't say: an endpoint's model, or an unlisted
  one), the fold budget (presets), and an endpoint's optional
  OpenRouter key for web search and media. The scripted model has no
  control here: the dev driver sets it. **Notifications**: turn
  notifications. **Sync & sharing**: a repo and a token (Connect acts
  at once), and a token for publishing. Settings live in
  `localStorage` (`settings.js`), never in a session.
- **A delegate's view**: a delegate's session (a dotted name) opens
  read-only, live while it runs.
- **Play mode**: `/run/?gist=…&play=1` shows a published app alone.
- **An empty session** (`EmptyState`): before a model is chosen, what
  the studio is and a button to choose one; after, things to ask for.
- **Names** (`titles.js`): the model names a session from its
  conversation's tail after the first exchange and every 5 of the
  person's turns, one small side request on their model (thinking at
  most low), until they rename it.
- **The docs**: `/docs/` renders `public/docs/*.md` (`Docs.svelte`;
  `main.js` picks it by the path, and the build copies `index.html` to
  `docs/` as it does to `run/`); the header's ? opens it.

## Dev builds

`dev-hook.js` installs `window.__studio` in dev builds: the calls
`scripts/drive.mjs` uses to run the studio headless (sessions, `say`,
the record, files, sync, publishing, the live preview), and a scripted
model (`accessMode: "scripted"`) so a check needs no model call.
