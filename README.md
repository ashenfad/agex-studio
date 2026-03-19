# Agex Studio

**[agex.studio](https://agex.studio)** — AI agents in the browser. No server required.

A browser-based AI assistant powered by [Pyodide](https://pyodide.org/) (Python in WebAssembly). Everything runs client-side — your data, files, and sessions stay in your browser's local storage. Just bring your own [OpenRouter](https://openrouter.ai/) API key.

## What it can do

- **Data analysis** — pandas, NumPy, scikit-learn, SciPy, with Plotly charts
- **Calendar management** — Google Calendar integration via [calgebra](https://github.com/ashenfad/calgebra)
- **File handling** — read Google Drive files, PDFs, Excel, CSV
- **Interactive apps** — build custom dashboards and tools in the preview pane
- **Web search** — search the web via Perplexity Sonar
- **Persistent sessions** — each session has its own files, history, and state

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

Opens a local dev server at `http://localhost:5173`. On first load, Pyodide
bootstraps in a Web Worker and installs dependencies (~30s). PyPI wheels are
cached by a Service Worker on subsequent reloads.

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

- **Pyodide** runs Python in a Web Worker (WebAssembly)
- **IndexedDB** (via [kvgit](https://github.com/ashenfad/kvgit)) stores sessions, files, and event history
- **Service Worker** caches Pyodide and PyPI wheels for fast reloads
- **Google OAuth** (implicit flow) for Calendar and Drive access — tokens stay in localStorage

## Part of the agex stack

- [agex](https://github.com/ashenfad/agex) — agent orchestration
- [calgebra](https://github.com/ashenfad/calgebra) — calendar algebra
- [kvgit](https://github.com/ashenfad/kvgit) — versioned key-value store
- [monkeyfs](https://github.com/ashenfad/monkeyfs) — virtual filesystem
- [sandtrap](https://github.com/ashenfad/sandtrap) — code sandbox
- [termish](https://github.com/ashenfad/termish) — shell emulator
