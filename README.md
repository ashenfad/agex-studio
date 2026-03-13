# Agex Studio

Agex agents in the browser. No server required — static hosting, user provides their own API key.

The full [agex](https://github.com/ashenfad/agex) stack (agex, sandtrap, monkeyfs, kvgit) running client-side via Pyodide, with persistent state in IndexedDB and interactive app building in the preview pane.

## Prerequisites

- Node.js 20+

## Setup

```bash
npm install
```

## Development

```bash
npm run dev
```

Opens a local dev server at `http://localhost:5173`. On first load, Pyodide
bootstraps in a Web Worker and installs dependencies (~30s). PyPI wheels are
cached by a Service Worker on subsequent reloads.

## Build

```bash
npm run build
```

Output goes to `dist/`, deployed to GitHub Pages on push to main.

## Tests

```bash
npm test          # watch mode
npx vitest run    # single run
```

## Part of the agex stack

- [agex](https://github.com/ashenfad/agex) — agent orchestration
- [kvgit](https://github.com/ashenfad/kvgit) — versioned key-value store
- [monkeyfs](https://github.com/ashenfad/monkeyfs) — virtual filesystem
- [sandtrap](https://github.com/ashenfad/sandtrap) — code sandbox
- [termish](https://github.com/ashenfad/termish) — shell emulator
