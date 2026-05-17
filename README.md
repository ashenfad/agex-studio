# Agex Studio

**[agex.studio](https://agex.studio)** — AI agents in the browser. No
server, no backend, no data leaves your laptop.

A browser-based AI assistant that combines a chat interface with a live
app preview, persistent versioned workspaces, and a tight code sandbox.
Bring your own [OpenRouter](https://openrouter.ai/) API key; everything
else runs client-side.

## What's different

- **Versioned workspaces.** Each session is a kvgit branch — files,
  chat history, and agent state move together. Fork at any point,
  undo across turns, export a session as a self-contained bundle.
  Other browser-based AI sandboxes don't have this.
- **No server.** All computation runs in the browser. The LLM is the
  only network dependency. Your files, code, and conversations
  stay in your browser's IndexedDB.
- **Live app preview.** Agents build interactive dashboards, tools,
  and games in a sandboxed iframe alongside the chat. JSX bundling
  via in-browser `esbuild`, or no-build HTM + Preact for a lighter
  path. The agent can `testApp` and `liveApp` to verify and
  interact with what they've built.
- **Tight code sandbox.** The primary [TypeScript
  kernel](https://github.com/ashenfad/agex-ts) runs agent code in
  a Web Worker through a custom AST interpreter (no `eval`) that
  restricts agent code to explicitly-registered names. Bare npm
  imports route through esm.sh on demand.

## What it can do

- **Interactive apps** — dashboards, games, tools, data explorers
  rendered in a live preview pane.
- **Tabular data** — Arrow + Arquero on the TS kernel; pandas /
  NumPy / SciPy on the Python kernel. Plotly charts on both.
- **PDFs** — page rendering + page count as image observations the
  agent can reason over.
- **Web search** — Perplexity Sonar; parallel `Promise.all` across
  several searches for multi-topic research.
- **Calendar + Drive** — Google integration via
  [calgebra](https://github.com/ashenfad/calgebra) (Python kernel
  for now).
- **Session bundles** — export and import full sessions, including
  history, files, and app state.

### Note on the Python kernel

Python sessions are marked **experimental**. The
[agex-py](https://github.com/ashenfad/agex) sandbox
([sandtrap](https://github.com/ashenfad/sandtrap)) filters API
access on real Python — a softer boundary than the TypeScript
interpreter sandbox, which restricts what agent code can even
*see*. Use Python kernels for code you trust; new work is
recommended on TypeScript sessions.

## Getting started

1. Visit **[agex.studio](https://agex.studio)**
2. Open Settings (gear icon) and enter your OpenRouter API key
3. Optionally connect Google for calendar and Drive access
4. Start chatting

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
kernel-agnostic: agex-ts (TypeScript, primary, Worker-sandboxed AST
interpreter) and Pyodide-hosted agex-py (Python, experimental,
WebAssembly + sandtrap). Persistent state lives in IndexedDB
through [kvgit](https://github.com/ashenfad/kvgit), with one branch
per session.

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
- [kvgit-ts](https://github.com/ashenfad/agex-ts) — same, TypeScript
  (lives in the agex-ts monorepo)
- [monkeyfs](https://github.com/ashenfad/monkeyfs) — virtual filesystem
- [sandtrap](https://github.com/ashenfad/sandtrap) — Python code sandbox
- [termish](https://github.com/ashenfad/termish) — shell emulator
