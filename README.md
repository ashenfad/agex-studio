# Agex Studio

**[agex.studio](https://agex.studio)** — AI agents in the browser. No server required.

A browser-based AI assistant with two runtime kernels: **TypeScript** (the
primary kernel — [agex-ts](https://github.com/ashenfad/agex-ts) running in a
Web Worker, with a structurally tight sandbox) and **Python** (experimental
— [agex-py](https://github.com/ashenfad/agex) on Pyodide for data-science
workloads). Everything runs client-side — your data, files, and sessions
stay in your browser's local storage. Just bring your own
[OpenRouter](https://openrouter.ai/) API key.

## What it can do

- **Interactive apps** — agents build custom dashboards, games, and tools
  in a live preview pane. JSX bundling via `esbuild`, or no-build HTM +
  Preact for a lighter path.
- **Web search** — Perplexity Sonar, with parallel `Promise.all([search(a),
  search(b), ...])` for multi-topic research.
- **Tabular data** — Arrow + Arquero for tabular work and Plotly for charts
  on the TS kernel; pandas / NumPy / SciPy / Plotly for the full numeric
  stack on the Python kernel.
- **Calendar + Drive** — Google integration via [calgebra](https://github.com/ashenfad/calgebra)
  (Python kernel only for now).
- **Persistent sessions** — each session has its own files, history, and
  state, with kvgit-backed versioning + undo.
- **Session bundles** — export and import full sessions, including history
  and files.

### Note on the Python kernel

Python sessions are marked **experimental**. The agex-py sandbox (sandtrap)
filters API access on real Python — a softer boundary than the TypeScript
interpreter sandbox, which restricts what agent code can even *see*.
Use Python kernels for code you trust; new work is recommended on
TypeScript sessions.

## Getting started

1. Visit **[agex.studio](https://agex.studio)**
2. Open Settings (gear icon) and enter your OpenRouter API key
3. Optionally connect Google for calendar and Drive access
4. Start chatting

## Development

### Prerequisites

- Node.js 20+

### Setup

```bash
npm install
npm run dev
```

Opens a local dev server at `http://localhost:5173`. The TypeScript kernel
boots cold in well under a second. The Python kernel (Pyodide + PyPI
wheels) takes ~30s on first load; subsequent reloads are cached by a
Service Worker.

### Build

```bash
npm run build
```

Output goes to `dist/`, deployed to GitHub Pages on push to main.

### Tests

```bash
npm test          # watch mode
npx vitest run    # single run
```

## Architecture

Static SPA hosted on GitHub Pages. No backend — all computation runs in the browser:

- **agex-ts** runs the TypeScript kernel in a Web Worker — a custom AST
  interpreter (no `eval`) that restricts agent code to explicitly
  registered names. This is the primary kernel.
- **Pyodide** runs the Python kernel in a Web Worker (WebAssembly). The
  agex-py sandbox (sandtrap) filters API access at runtime. Experimental.
- **IndexedDB** (via [kvgit](https://github.com/ashenfad/kvgit)) stores
  sessions, files, and event history.
- **Service Worker** caches Pyodide and PyPI wheels for fast reloads.
- **Google OAuth** (implicit flow) for Calendar and Drive access — tokens
  stay in localStorage.

## Part of the agex stack

- [agex-ts](https://github.com/ashenfad/agex-ts) — TypeScript agent
  orchestration (primary kernel)
- [agex](https://github.com/ashenfad/agex) — Python agent orchestration
- [calgebra](https://github.com/ashenfad/calgebra) — calendar algebra
- [kvgit](https://github.com/ashenfad/kvgit) — versioned key-value store
  (Python)
- [kvgit-ts](https://github.com/ashenfad/agex-ts) — same, TypeScript
  (lives in the agex-ts monorepo)
- [monkeyfs](https://github.com/ashenfad/monkeyfs) — virtual filesystem
- [sandtrap](https://github.com/ashenfad/sandtrap) — Python code sandbox
- [termish](https://github.com/ashenfad/termish) — shell emulator
