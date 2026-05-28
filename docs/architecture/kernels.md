# Kernels

The studio supports two runtime kernels — TypeScript and Python.
The chat UI talks to a `KernelAdapter` contract; the implementations
live in `ts-kernel-adapter.js` and `py-kernel-adapter.js`. Sessions
are kernel-bound (you can't switch a session's kernel after
creation), but the UI treats them uniformly.

## TL;DR

| | TypeScript (primary) | Python (experimental) |
|---|---|---|
| **Runtime** | Web Worker | Web Worker + Pyodide (WASM) |
| **Interpreter** | agex-ts AST interp (no `eval`) | CPython on Pyodide |
| **Sandbox model** | Structural — agent code only sees registered names | Filtering — sandtrap watches API calls on real Python |
| **Cold boot** | <1s | ~30s (cached after first load) |
| **Bare npm imports** | Routed through esm.sh by `namespaceResolver` | Limited to wheels pre-bundled in the worker |
| **File I/O** | termish-ts kvgit-fs (`f:` / `d:` keys) | agex-py fs API (same kvgit backend) |
| **State persistence** | `evt/` + `cache/` + `__subtasks__` keys | `evt/` + `cache.PREFIX/` keys |
| **Action emissions** | `ts_action`, `terminal_action`, `write_file`, `edit_file` | py action emission |
| **Cancellation** | `AbortSignal` honored natively by agex-ts | Cooperative-flag machinery (`__agex_cancel_chat`) exists in the worker, but the adapter doesn't yet plumb the signal through (`py-kernel-adapter.js:367`) — cancel is TS-only today |
| **App preview support** | Full (`testApp`, `liveApp`, asset inlining) | Full (older path through worker postMessage) |

## The KernelAdapter contract

Defined as a JSDoc typedef in `src/lib/kernel-adapter.js`. The
shell never imports a kernel-specific module — it calls
`getActiveAdapter()` which returns the adapter for the active
session's kernel. Both adapters export the same shape; mismatches
are caught at test time by the shape suite (see
`ts-kernel-adapter.test.js` + `py-kernel-adapter.test.js`).

Conceptual groups (each typedef-block in `kernel-adapter.js`):

- **Lifecycle** — `init(settings)`, `dispose()`
- **Branch ops** — `listBranches*`, `createBranch`, `deleteBranch`,
  `readBranchMeta`, `writeBranchMeta`
- **Messaging** — `sendMessage(branch, message, opts)`,
  `runChaptering(branch)`
- **State / commits** — `getCurrentCommit`, `undoToCommit`,
  `wipeAgentMemory` (kept as a primitive, currently only TS
  implements; py throws)
- **VFS** — `listFiles`, `readFile`, `fileSize`, `writeFiles`,
  `deleteFiles`, `readAppFiles`, `readAppBinaries`
- **Bundle payloads** — `exportBundlePayload`, `importBundlePayload`,
  `getBundleStats`
- **History rendering** — `loadHistory(branch)` returns the chat
  message rows
- **Query bridge** — `runQuery`, `getCacheValue` (only py
  implements `runQuery`; ts adapter throws "not yet implemented")
- **Token telemetry** — `estimateLogTokens`, `getTokenHistory`
- **Debug** — `getSessionDebugInfo`

The two test files `*-kernel-adapter.test.js` each carry an
`EXPECTED_METHODS` array — if you add a method to one adapter
without the other, the cross-adapter shape-equivalence test
fails loudly.

## TS kernel internals

`src/lib/ts-agent.js` is the studio's wiring layer over agex-ts:

- `initAgent(settings)` constructs the `Agent` instance with the
  studio's LLM client, the `workerRuntime`, an IndexedDB-backed
  kvgit state config, and `chapteringTrigger` from settings.
- Host-fn registrations (`_agent.fn(...)`) for `testApp`,
  `liveApp`, `search`, `renderPdf`, `pdfPageCount`. Each registers
  with an explicit `name:` field because vite's prod build
  minifies function names — relying on `fn.name` silently breaks
  in deployed bundles (see commit log).
- Namespace registrations (`_agent.namespace(...)`) for
  `arquero` / `apache-arrow` against esm.sh URLs.
- `_agent.terminal(...)` for the `esbuild` command.
- Skills registered: `numerical.md`, `interactive-app.md` (in
  `src/lib/skills/`).

`src/lib/ts-kernel-adapter.js` is a thin layer turning the
agex-ts API into the `KernelAdapter` shape — mostly straight
forwards from `ts-agent.js` exports, plus the token translator
(`ts-event-translator.js`) that converts `TokenChunk`s into the
studio's shell-shape token vocabulary.

### Worker bundling

The agex-runtime-worker comes with a `worker.js` that imports
`agex-ts/wrap-fs` and a sibling chunk. Vite's default behavior
is to copy that worker file verbatim into `dist/` — leaving the
bare imports unresolved at runtime in production builds (works
in dev because vite's dev server resolves on the fly).

`ts-agent.js` imports the worker through vite's `?worker&url`
modifier so vite compiles it as a worker entry point, bundling
all imports inline and emitting a self-contained URL. That URL
is passed explicitly to `workerRuntime({ workerUrl })`. See
commit `536602b`.

## Py kernel internals

`src/lib/agent.js` is the py-side analog of `ts-agent.js`. Most
state plumbing on the py side lives in `public/python/*.py`
modules served as text and `runPython`-ed into the worker at
init time. Per-session host fns are registered via the agent
helpers in `public/python/agent_helpers.py`.

The studio communicates with the py worker through the bridge in
`src/lib/pyodide.js` — postMessage protocol with `pdf-render`,
`pdf-page-count`, `test-app`, `live-app`, `llm-fetch` and so on
as message types. LLM fetches go through a host-thread bridge so
the API key never enters the worker.

### Worker startup phases

The py kernel has a noticeable cold-boot wave — visible to the
user via the boot modal in `ChatShell`. Order:

1. **`idle`** — no worker spawned yet. First chat send creates it.
2. **`loading`** — Pyodide downloads (cached via service worker
   after first run), agex-py + sandtrap initialize.
3. **`ready`** — agent constructed, primer loaded.

`pyodide.js` exposes `pyodideStore` with `status` field; the boot
modal gates on `$pyodideStore.status === 'loading'`.

## What's shared between kernels

- **LLM client.** Both kernels' agents share an LLMClient
  instance built from the studio's settings. The host-side
  bridge to `/v1/messages` is identical (same auth, same model,
  same routing).
- **kvgit IndexedDB.** Branches from both kernels live in the
  same kvgit database. A TS session and a py session are just
  two branches that happen to be kernel-stamped via the
  `__session_kernel__` meta key.
- **App preview infra.** `buildAppHtml`, the iframe sandbox,
  the asset inlining pipeline, and the postMessage bridge are
  kernel-agnostic.
- **Settings store, sessions list, drawers, modals.** All
  Svelte UI is kernel-agnostic; only the active-adapter dispatch
  changes per session.

## Design notes

### Why two kernels at all?

Historically py shipped first. The TS kernel was added when
agex-ts matured because:

- The TS interpreter sandbox is structurally tighter (can't
  see unregistered names) — appropriate for an LLM whose
  intentions you can't verify.
- TS cold-boot is ~30× faster than Pyodide cold-boot.
- The TS bundle is much smaller — no WASM, no PyPI wheels.

Py stays because:

- The Python data-science stack (pandas / scikit-learn / Plotly
  with proper backends) is hard to match in TS.
- `calgebra` and the Google Calendar integration are
  Python-only for now.

### Kernel feature gating

The UI gates kernel-specific features by checking
`session.kernel === 'ts'` or `'py'`. For features that haven't
landed on both sides yet (e.g. `wipeAgentMemory`, certain app
preview details), the adapter contract requires the method to
exist but kernels can throw if not implemented. The UI is
expected to gate the call so the throw never fires; if it does,
that's a UI bug to be fixed by hiding the affordance.
