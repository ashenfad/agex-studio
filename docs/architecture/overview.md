# Overview

Agex Studio is a single-page application that runs entirely in the
browser. The user types in a chat panel; an LLM-driven agent answers
in the same panel and can optionally render a live app in a
sandboxed iframe alongside the chat. No backend, no shared
infrastructure, no server.

## The pieces

```
┌──────────────────────────────────────────────────────────┐
│ agex.studio (static SPA, GitHub Pages)                   │
│                                                          │
│  ┌──────────────┐  ┌──────────────────┐  ┌────────────┐  │
│  │  ChatShell   │  │  AppPreview      │  │  Drawers   │  │
│  │  (Svelte)    │  │  (sandboxed      │  │  Sessions  │  │
│  │              │  │   iframe)        │  │  Files     │  │
│  │              │◄─┤  bridge over     │  │  Settings  │  │
│  └──────┬───────┘  │  postMessage     │  └────────────┘  │
│         │          └──────────────────┘                  │
│         │                                                │
│         ▼ KernelAdapter (kernel-agnostic contract)       │
│  ┌──────────────────────────────────────────────┐        │
│  │  TS kernel              Py kernel            │        │
│  │  (Web Worker)           (Pyodide / WASM)     │        │
│  │  agex-ts interpreter    agex-py + sandtrap   │        │
│  └──────────┬───────────────────────────────────┘        │
│             │                                            │
│             ▼ kvgit (per-session branch, both kernels)   │
│  ┌──────────────────────────────────────────────┐        │
│  │  IndexedDB              localStorage         │        │
│  │  - event log            - API key            │        │
│  │  - agent cache          - settings           │        │
│  │  - VFS file blobs       - active session id  │        │
│  └──────────────────────────────────────────────┘        │
└──────────────────────────────────────────────────────────┘
            │ (only outbound)
            ▼
   OpenRouter / Anthropic / Google APIs
```

## Top-level invariants

These shape almost every design decision:

1. **No backend.** There is no `agex.studio` server beyond
   GitHub Pages serving static files. Every byte of computation,
   storage, and state lives in the user's browser. The only
   network calls go to the user-configured LLM endpoint (and
   optionally Google for Calendar/Drive).
2. **Kernel-agnostic shell.** The chat UI talks to a
   `KernelAdapter` (see [kernels.md](kernels.md)) — it doesn't
   know whether the active session is running TS or Py underneath.
3. **One kvgit branch per session.** Files, events, cache, and
   metadata are all on the same branch and move together (see
   [sessions-and-storage.md](sessions-and-storage.md)).
4. **The TS kernel is primary.** Py is supported but marked
   experimental in the UI. New features land TS-first; py-side
   parity is best-effort.

## Tour by directory

- `src/lib/ChatShell.svelte`, `MessageList.svelte`,
  `ChatInput.svelte` — the chat panel.
- `src/lib/AppPreview.svelte`, `app-control.js`, `iframe-bridge.js`,
  `pyodide.js` (also hosts `buildAppHtml`) — the live preview.
  See [app-preview.md](app-preview.md).
- `src/lib/kernel-adapter.js` (contract), `ts-kernel-adapter.js`,
  `py-kernel-adapter.js`, `kernel-registry.js` — the kernel
  layer. See [kernels.md](kernels.md).
- `src/lib/ts-agent.js`, `agent.js` (py) — per-kernel agent
  wiring and host-fn registrations.
- `src/lib/sessions.js`, `SessionDrawer.svelte` — session
  lifecycle. See [sessions-and-storage.md](sessions-and-storage.md).
- `src/lib/ts-event-translator.js`, the agex-ts→shell token
  translation layer. See
  [agent-loop-and-tokens.md](agent-loop-and-tokens.md).
- `src/lib/primers/`, `src/lib/skills/` — markdown content fed
  to the agent at task time. Treated as source-of-truth for
  what the LLM is told about the environment.

## What's outside the studio

The studio is a thin host. The heavy lifting is owned upstream
in agex-ts, agex-py, kvgit, etc. — and is documented in those
projects' own docs. The bar for content in this repo's `docs/`:
"would a refactor here be riskier if this section were missing?"
If the answer is no, the right place is upstream.
