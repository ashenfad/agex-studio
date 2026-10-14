# The rebuild

The studio rebuilt on the new agex-ts: one TypeScript kernel, the
world's sessions and tools, and agex-ts's loop, tasks and delegation.
agex-ts's [`plan.md`](https://github.com/ashenfad/agex-ts/blob/main/plan.md)
holds the foundation's decisions; this is the studio's half.

## Ground rules

- **A clean break.** The new studio starts empty: no migration of
  sessions, synced repos, bundles or gists in the old format. An app
  worth keeping is brought over by hand, as source.
- **One branch, `src/` replaced.** The rebuild lands on a `rebuild`
  branch: the old `src/` is deleted at its start, and each step brings
  back the modules it salvages. The old code stays in git history, and
  agex.studio keeps serving `main` until the switch.
- **agex-ts by link, not by release.** During the rebuild the studio
  depends on the four agex-ts packages by pnpm `link:`, to a built
  clone, so an agex-ts fix is a PR there and a `pnpm -r build`, with no
  publish in between. The studio moves from npm to pnpm for it. At the
  switch the links become released versions.
- **One step is one PR,** into `rebuild`, usable from S1 on.

## Decided

- **One kernel.** The Python kernel goes, with Pyodide and its bridge,
  as agex-ts's plan decided. So does the `KernelAdapter` layer: with one
  kernel it has no job.
- **The chat reads agex-ts directly.** A turn is an agex-ts `Session`
  turn: the UI renders the `TurnEvent`s it streams and the run record
  it stores (`text`, `thinking`, `tool_call` and `tool_result` parts),
  with no translation into another shape.
- **Rich replies are `ui` artifacts,** nontainer-studio's pattern. Agent
  code assigns `ui.revenue = figure` in `run_ts`; when the run ends,
  each entry is written to `ui/<name>.<ext>` by kind (a Plotly spec, a
  table as records, image bytes or a data URL, card rows), and the
  result names the paths. The reply embeds one as
  `![revenue](/workspace/ui/revenue.plotly.json)`, and the studio
  renders it inline by kind, those the reply doesn't name after it. An
  artifact is a file, so it is versioned, rewinds with the rest, and a
  reply is rebuilt from the record alone. The convention is the world's
  (a port of `nontainer.ui`); the rendering is the studio's.
- **Publishing stays on gists, and gains version tags.** With no server,
  a gist stays the host: publishing PATCHes or POSTs it, `/run/?gist=`
  opens it, and revision polling offers updates. What is new is the
  bookkeeping: each publish tags the session commit it came from in the
  store, `@store/published/<slug>/<version>`, with the gist's id and
  revision in the tag's info. So the agent can list what the human has
  published (`sessions published`) and start from one
  (`sessions ask fork_from=<tag>`, `ws-git checkout <tag> -- app/`),
  offline and whatever became of the gist.
- **Delegation as nontainer-studio has it.** The `sessions` tool and
  `ws-git` are the world's, and agex-ts runs the delegates. The studio
  adds what nontainer-studio's server adds: waking an idle parent when
  an answer lands, on a budget the human's next message refills (10); a
  depth cap on nesting (2) and a tool-call cap per delegate turn; the
  delegates strip above the composer, the rail badge, and each
  delegate's transcript, live; a rewind past an ask unsays the
  delegate; and `sessions published`.
- **Folding replaces chaptering.** A session folds past its budget
  (agex-ts's `Policy`), shown as a band from its `Compacted` events.
  Chapters come back later as ranged folds.
- **Agent-defined tasks replace `spawn`,** in the agent's code
  (`agex.task`) and, through the bridge, in apps.

## What goes, what stays, what is rewritten

| | modules |
|---|---|
| **goes** | the Python kernel (`agent.js`, `py-kernel-adapter.js`, `pyodide.js`, `PyWarningModal`, `public/worker.js`, `public/python/`), the kernel layer (`kernel-adapter.js`, `kernel-registry.js`, `active-adapter.js`, `ts-kernel-adapter.js`), `ts-agent.js`, the event translation (`ts-event-translator.js`, the py-shaped half of `event-utils.js`), `ts-chat-response.js`, chaptering's UI (`ChapterModal`, `ChapteringBand`, the "chapter now" button), `spawn` and its chips, the app-side `query()` bridge |
| **stays, close to as is** | the app pipeline (`app-html`, `iframe-bridge`, `app-control`, `app-assets`, `apps-origin`, `app-storage`, `esbuild-bridge`, `AppPreview`), the utilities (markdown, highlight, search, media, pdf-render, notify, presence, favicon, wake-lock, bytes, format-time, Drive import, image-downsample), the UI parts (`SplitPane`, `Modal`, `ProgressBar`, `Header`, `ChatInput`, the file drawer and modal, `DataTable`, `PlotlyChart`, the cards, `Gallery`, `Docs`, `SessionRow`, `DrawerFooter`, the app launcher and mobile switcher), and their tests |
| **rewritten** | sessions (`sessions.js`, `session-index`, `session-runtime`) on the world's `Store` and agex-ts's `Session`; the chat view (`MessageList`, `EventDetail`, the activity panels, `ChatShell`) on `TurnEvent`s and the record; the studio's tools (`testApp`/`liveApp` as a `test_app` tool, search, media and PDF as typed host objects, esbuild as a profile command); settings and models on AI SDK providers; sync, bundles, snapshots and gists on kvgit v4 and the world's branches; the primers and the `interactive-app` skill |

`sync-engine`'s logic (the debounce, the divergence states and their
UI, trash, the app-state sidecar) is kept; what it stands on is new.

## Steps

**S0. The skeleton.** The `rebuild` branch with `src/` cleared; pnpm,
and `link:` dependencies on agex-ts's four packages; Vite with the
world's worker bundled (`import workerUrl from
'@agex-ts/world/worker?worker&url'`, passed as each profile's
`code.worker`); settings with a key and a model, on the AI SDK's
OpenRouter provider and a direct one; one session on an IndexedDB store,
streaming. Exit: a conversation with a real model writes files, and a
reload shows it again from the record.

**S1. Sessions.** The session list from the store, with its metadata;
create, switch, delete; fork, full and keeping only the files
(`inherit: 'fresh'`); undo as a checkout; cancel, resume, and a note
queued mid-turn (the inbox); the file drawer and modal; folding, with
its band. Exit: sessions survive a reload, and fork, undo and cancel
behave as today's.

**S2. Apps.** The preview pipeline salvaged; `test_app` (today's
`testApp`/`liveApp`, as a tool) with screenshots for a model that sees
them; esbuild as a terminal command; app storage and assets; the
`interactive-app` skill rewritten for the world's tools. Exit: the
agent builds an app, tests it, and the human uses it in the preview.

**S3. The studio's tools and rich replies.** `ui` artifacts (a world PR
first) and their rendering, with the rich components salvaged; search,
media, PDF and Drive import as typed host objects; the primers. Exit: a
reply with a table, a chart and cards renders inline, and a reload
renders it the same.

**S4. Sync, bundles and gists.** The sync engine on the store's kvgit v4
repository and its GitHub remote; bundle export and import, and the
compact fork, on kvgit v4; gist publishing, opening and update checks;
the published-version tags. Exit: a session syncs between two
browsers, and a published app opens from its gist link in a fresh one.

**S5. Agents from apps, and delegation.** The bridge: an app's
agent-defined tasks on the viewer's own key, with a per-page budget;
the `sessions` tool and `ws-git` on, with waking, the caps, the strip,
the rail and the drill-down, and `sessions published`. Exit: an app
calls an agent on a click within its budget, and a session delegates,
is woken by the answer, and merges it.

**S6. Variables, secrets and services.** The settings screen for both,
into the world's profile; `curl` as a host command; the skills for
fetching while building, stand-ins for live services and `multiplayer`,
and `supabase-auth` brought up to date. Exit: an app built against a
Supabase project with a variable and a secret, tested against its
stand-in.

**S7. Docs and the switch.** `docs/` rewritten for the new shape; the
README and the in-app docs; agex-ts released, and the links replaced by
its versions; agex.studio switched to the new build. Exit: the
deploy-day checklist passes on agex.studio.

## Needed upstream

- **`ui` artifacts** in the world's kernel (S3).
- **A worker bundlers find on their own:** the world picks its worker's
  file at run time, which a bundler can't follow, hence `?worker&url`.
  A literal `new Worker(new URL('./worker.js', import.meta.url))` for
  the browser target would make that line unnecessary.
- **A lighter first load.** Stripping types loads the TypeScript
  compiler (most of a ~4 MB bundle); the studio loads the kernel
  lazily, and a lighter stripper is worth a look.

Each of these is an agex-ts PR, used through the links before any
release.

## Open

- **The per-page budget** for an app's agent calls: what it counts
  (calls, tokens or cost), and where the viewer sees and resets it.
- **OpenRouter's forced-tool fallback** (`openrouter.js`): whether the
  AI SDK provider still needs it.
- **Model presets:** which providers the settings offer directly, beside
  OpenRouter.
