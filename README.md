# Agex Studio

**[agex.studio](https://agex.studio)** — AI agents in the browser. No
server, no backend — your workspace lives in your browser, not on our
servers.

A browser-based AI assistant that combines a chat interface with a live
app preview, persistent versioned workspaces, and a tight code sandbox.
Bring your own [OpenRouter](https://openrouter.ai/) API key; computation
runs client-side. There's no agex backend: your files, code, and chat
history persist locally in IndexedDB. Agent turns send context to your
chosen LLM, and some features reach other origins on demand (see
[What leaves your browser](#what-leaves-your-browser)).

## What's different

- **Versioned workspaces.** Each session is a kvgit branch — files,
  chat history, and agent state move together. Fork at any point,
  undo across turns, export a session as a self-contained bundle.
  Other browser-based AI sandboxes don't have this.
- **No agex backend.** Computation runs in the browser and your
  workspace persists locally in IndexedDB — there's no server of ours
  storing your files, code, or conversations. Agent turns still send
  context to your LLM, and a few features fetch from third-party
  origins on demand (see [What leaves your
  browser](#what-leaves-your-browser)).
- **Live app preview.** Agents build interactive dashboards, tools,
  and games in a sandboxed iframe alongside the chat. JSX bundling
  via in-browser `esbuild`, or no-build HTM + Preact for a lighter
  path. The agent can `testApp` and `liveApp` to verify and
  interact with what they've built.
- **Tight code sandbox.** The primary [TypeScript
  kernel](https://github.com/ashenfad/agex-ts) runs agent code in a
  Web Worker — its own realm, with no DOM and no access to the host
  page's globals. Agent code sees only the names you've explicitly
  registered (injected as parameters), not whatever happens to be in
  scope. There's no `eval`; type annotations are stripped and the
  code is compiled with `new AsyncFunction`. Bare npm imports route
  through esm.sh on demand.

## What it can do

- **Interactive apps** — dashboards, games, tools, data explorers
  rendered in a live preview pane.
- **Tabular data** — Arrow + Arquero on the TS kernel; pandas /
  NumPy / SciPy on the Python kernel. Plotly charts on both.
- **PDFs** — page rendering + page count as image observations the
  agent can reason over.
- **Web search** — Perplexity Sonar; parallel `Promise.all` across
  several searches for multi-topic research.
- **Sub-agent fan-out** — the agent can `spawn` parallel LLM
  sub-tasks (multi-angle research, candidate generation), and apps it
  builds can call the LLM on a user action (an NPC's reply, an
  opponent's move). Runs on your same provider — no extra egress.
- **Google Drive import** — pick files via the Google Picker; their
  bytes download into the agent's workspace under `/downloads/`. The
  access token stays on the main thread and is dropped right after the
  download.
- **Session bundles** — export and import full sessions, including
  history, files, and app state.

### Note on the Python kernel

Python sessions are marked **experimental**. The
[agex-py](https://github.com/ashenfad/agex) sandbox
([sandtrap](https://github.com/ashenfad/sandtrap)) runs real Python
in the Pyodide WebAssembly runtime and filters API access at the
language level (AST rewriting plus runtime gates). The TypeScript
kernel takes a different tack: agent code runs in a separate Web
Worker realm and only receives the capabilities you inject, so it
can't reach host globals in the first place. Both are designed for
cooperative code, not adversarial input — use either for code you're
willing to run. New work is recommended on TypeScript sessions, which
are faster to boot and more actively developed.

## What leaves your browser

There's no agex backend, and your workspace (files, code, chat
history) persists locally in IndexedDB. But "client-side" doesn't mean
"airgapped" — a few things reach the network, all to endpoints you
control or opt into:

- **Your LLM provider** — every agent turn sends the conversation and
  task context to [OpenRouter](https://openrouter.ai/) (or whichever
  provider your key targets). This is the one unavoidable egress.
- **esm.sh** — when agent code imports a bare npm package, the module
  is fetched from esm.sh on demand.
- **Perplexity Sonar** — only when the agent uses web search.
- **GitHub Gists** — when you publish or open a shared session, and an
  occasional lightweight revision check for sessions you imported from a
  gist (so the studio can offer to update them when the source changes).
- **`apps.agex.studio`** — the cross-origin iframe that renders live
  app previews (static bootloader; your app HTML is posted to it
  locally, not uploaded).
- **Google Drive** — only when you import files via the Drive picker.

Nothing is persisted on a server we run; the items above are
per-feature network calls, most of them opt-in.

## Getting started

1. Visit **[agex.studio](https://agex.studio)**
2. Open Settings (gear icon) and enter your OpenRouter API key
3. Start chatting (import files from Google Drive on demand via the
   Drive picker — no upfront connection needed)

## Local development

Requires Node.js 20+.

```bash
npm install
npm run dev          # local dev server on http://localhost:5173
npm run build        # production build → dist/
npx vitest run       # full test suite (one-shot)
npm test             # watch mode
```

The TypeScript kernel boots cold in well under a second. The Python
kernel (Pyodide + PyPI wheels) takes ~30s on first load; subsequent
reloads are cached by a Service Worker.

## Architecture quick-take

Static SPA hosted on GitHub Pages. No backend. Two runtime kernels
share a `KernelAdapter` contract so the chat shell stays
kernel-agnostic: agex-ts (TypeScript, primary, agent code compiled
with `new AsyncFunction` and isolated in a Web Worker realm) and
Pyodide-hosted agex-py (Python, experimental, WebAssembly +
sandtrap). Persistent state lives in IndexedDB through
[kvgit](https://github.com/ashenfad/kvgit), with one branch per
session.

For implementation detail — kernel comparison, storage internals,
the app-preview pipeline, error / cancellation flows — see
[**docs/**](docs/). Forward-looking design proposals live in
[**roadmap/**](roadmap/).

## Part of the agex stack

- [agex-ts](https://github.com/ashenfad/agex-ts) — TypeScript agent
  orchestration (primary kernel for the studio)
- [agex](https://github.com/ashenfad/agex) — Python agent orchestration
- [calgebra](https://github.com/ashenfad/calgebra) — calendar algebra
- [kvgit](https://github.com/ashenfad/kvgit) — versioned key-value store
  (Python)
- [@agex-ts/kvgit](https://github.com/ashenfad/agex-ts) — same, TypeScript
  (lives in the agex-ts monorepo)
- [monkeyfs](https://github.com/ashenfad/monkeyfs) — virtual filesystem
- [sandtrap](https://github.com/ashenfad/sandtrap) — Python code sandbox
- [termish](https://github.com/ashenfad/termish) — shell emulator
