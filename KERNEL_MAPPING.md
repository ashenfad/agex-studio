# Kernel Mapping (Phase 2)

The studio is moving toward a unified shell hosting two kernels — Pyodide
(`agex-py`) and Web Worker (`agex-ts`) — discriminated per session via
`session.kernel`. This doc catalogs every place the studio's JS shell
currently calls into the kernel, maps each to the equivalent surface in
`agex-ts`, and flags the divergences. It's the empirical input to Phase 3
(designing the `KernelAdapter` interface).

This is a working document. Once `KernelAdapter` lands (Phase 3) and
both adapters exist (Phases 4 and 5), this file can be deleted — the
canonical truth will be the interface and its two implementations.

---

## How to read this doc

The studio's kernel-touching surface lives across three files:

- **`src/lib/agent.js`** — agent lifecycle, registration, message
  send/receive, file ops on the VFS, app preview's query bridge.
- **`src/lib/sessions.js`** — session lifecycle (kvgit branches today),
  history rendering, undo/fork, app storage, bundle import/export.
- **`src/lib/pyodide.js`** + `public/worker.js` — the Pyodide worker
  itself: bootstrap, RPC, streaming, cancellation.

For each entry point we ask three questions:

1. **What is it actually doing** at the agent / state / runtime layer?
2. **Where's the equivalent in `agex-ts`?** (or: is it kernel-shell
   plumbing that doesn't need a kernel surface at all?)
3. **What's the divergence?** Same shape (rename), different shape
   (semantics differ), missing on `agex-ts`, or shell-only.

Category labels:

| Tag | Meaning |
|---|---|
| ✅ same shape | TS has a near-direct equivalent; adapter translates 1:1. |
| 🔄 different shape | Both sides have it, but the API or semantics differ. Adapter mediates. |
| ➕ missing on TS | No equivalent yet; needs adding to `agex-ts` (or worked around in the studio). |
| 🏠 shell-only | Not kernel work. Lives in the shared shell; both kernels participate via thin per-kernel adapters. |

---

## Big-picture context (read these first)

Six architectural facts shape almost every entry point below.

### 1. Session model is uniform across both kernels

Earlier iterations of this doc treated session model as a divergence. It
isn't. Both kernels expose the same primitives, and the studio's "branches
as user-facing sessions within a single substrate" pattern works on both:

- **agex-py and agex-ts both define "session = independent substrate"**
  at the `agent.state(session)` API level. agex-ts's `connectState`
  comment is explicit: "Each framework session gets its own KV-store
  namespace … Mirrors agex-py's `host/local.py` model."
- **The studio doesn't actually use that.** It pins everything to
  `session="default"` and reaches *under* the agex API to use kvgit's
  branch primitives directly. UI sessions = kvgit branches within the
  default substrate. This is a studio-level choice (cheap forking,
  content-addressed dedup across UI sessions, single store to manage),
  not part of agex's contract.
- **kvgit-ts has the same branch primitives as kvgit-py.** Confirmed in
  `kvgit-ts/src/types.ts`: `listBranches()`, `createBranch(name, { at? })`,
  `switchBranch(name)`, `deleteBranch(name)`, `peek(key, { branch })`,
  `checkout(commitHash, { branch? })`, `resetTo(commitHash)`.
- **Reachable from agex-ts:** `(await agent.state(session)).staged.versioned`
  exposes the underlying `Versioned`. `KvgitState`'s `staged` getter is
  documented as being there for "callers that need kvgit-specific surface
  (branches, history walks, etc.)".

So the studio's `_state.list_branches() / create_branch / switch_branch /
peek(key, branch=...)` pattern translates near-1:1 to agex-ts. No
divergence, no shell-side session enumeration, no special primitives in
the adapter. The branch model stays.

### 2. Different substrates, format-incompatible

The two kernels persist to **different browser storage layers**:

- **Py (Pyodide path):** kvgit-py's disk backend over **OPFS**, mounted
  at `/persist` inside Pyodide. The studio configures
  `connect_state(type="versioned", storage="disk", path="/persist")`,
  and `worker.js` sets up `mountNativeFS('/persist', ...)` against the
  `agex_persist` OPFS directory. kvgit-py's IDB backend exists, but the
  studio doesn't use it — Safari/Firefox don't support all the IDB
  features kvgit-py's IDB backend relies on.
- **Ts:** kvgit-ts's IDB backend, default `dbName="kvgit-ts"`, with
  `connectState({ storage: 'indexeddb' })` opening `kvgit/<session>`
  (for our pinned `session="default"` that's `"kvgit/default"`).

The encoders are also different — kvgit-py uses
`kvgit.encoding.dumps` (Python pickle-extended), kvgit-ts uses the
polymorphic encoder from `termish-ts/fs/kvgit`. Even if you forced
both onto the same substrate, the same logical content would produce
different hashes on each side. Bytes are not interoperable.

Implication: the studio has two **parallel, asymmetric substrates**.
Cross-kernel migration ("convert a py session to ts") isn't a
substrate-level operation; it'd require replaying through the target
kernel's API. Bundles produced by the two kernels are likewise
distinct (the manifest carries a `kernel` field — see Phase 1 work).

### 3. Cold-start: localStorage cache is the source of truth

The unified UI's drawer has to render before any kernel is running, so
the user can browse / pick / open without paying Pyodide / Worker boot
cost up front. **The cache is authoritative for the cold-start path.**

How it stays current:

- **Adapter writes through to cache on every branch / metadata
  mutation.** `createBranch`, `deleteBranch`, `writeBranchMeta`,
  `loadHistory`, etc. update the localStorage cache as a side effect
  of their kernel call. A new session is visible in the cold-start
  drawer the moment it's created — no first-boot priming needed beyond
  the action that created it.
- **Cache survives across page reloads** (localStorage), shares across
  tabs at the same origin (so multi-tab session creates show up after
  the next read in the other tab), and works identically for both
  kernels — the substrate asymmetry stops being visible at this layer.

What the cache holds: `(kernel, branch)` keys; per-record title, name,
description, updated, external. Bare branch names alone aren't
enough; the drawer wants meta to render usefully.

What we deliberately **don't** do:

- **No IDB enumeration as a primary read.** Earlier drafts of this doc
  proposed `indexedDB.databases()` + branch-HEAD scans across both
  stores as a recovery layer. That's TS-only at the substrate level
  (Py is in OPFS, not IDB), and the cache covers the typical case;
  reaching into IDB to second-guess the cache adds complexity without
  buying much. `session-index.js` keeps the enum helpers but doesn't
  use them in the cold-start path; they remain available as a future
  TS-only recovery hook for "cache cleared but TS data exists" if
  that case ever needs handling.
- **No OPFS-side enumeration for Py.** Diskcache stores keys as opaque
  sqlite blobs; reading them without booting Pyodide isn't worth the
  effort.

Edge cases the design accepts:

- Cache cleared (devtools "Clear site data") → drawer empty until the
  user creates a new session (which boots a kernel and re-populates
  the cache). Agent state isn't lost — it lives in OPFS / IDB — only
  the index over it.
- Tab-close mid-write → cache may not reflect the last action; next
  read after the storage settles picks it up.

So **kernels boot on user intent to engage**, not on "does that
kernel's data exist." A user with only TS sessions never pays the
Pyodide cost; a user with only Py sessions never pays the TS worker
cost; mixed-kernel users only warm a kernel when they touch one of
its sessions.

### 4. Init flow: 2-wave Pyodide bootstrap vs. `createAgent` + register

- **`agex-py` / studio today:** `initAgentBasics()` then `initAgentRich()`
  — Pyodide-specific. Wave 2 installs a bridge LLM module from
  `/bridge_llm.py`, constructs the LLM client, builds the `Agent`,
  registers IO. Wave 3 installs `agent_modules.py` (pandas / numpy /
  sklearn / etc.) and `agent_helpers.py`, attaches skills, defines the
  `chat` task.
- **`agex-ts`:** `createAgent({...})` returns a ready-to-use agent;
  registration is method calls on the agent (`.fn`, `.cls`, `.namespace`,
  `.skill`, `.terminal`). Worker is spun up by `workerRuntime({
  workerUrl })`. No URL-based module installer.

The two-wave structure exists because Pyodide needs to download wheels
and bridge code from URLs *after* the worker is running. agex-ts has no
equivalent need — worker bundle ships with the framework.

**Adapter implication:** `KernelAdapter.init(settings)` is fundamentally
different work on each side. Both end with "ready to receive messages,"
but the steps in between are non-uniform. The interface should be
opaque: `await adapter.init(settings)` returns when ready.

### 5. Streaming + cancellation

- **`agex-py` / studio today:** Custom plumbing. `_post_token(_run_id,
  payload)` writes to a side channel; `runPythonStreaming(code,
  onToken)` listens. Cancellation flag at `__main__.__agex_cancel_<task>`
  polled by a monkey-patched `check_cancellation` inside the agex loop;
  asyncio-cancel recovery in `streaming.run_chat_task` because some
  cancel paths bypass the loop. (See `STATE.md` § "Cancellation bridge".)
- **`agex-ts`:** Native. `TaskCallOptions.signal: AbortSignal` for
  cancel; `onToken: (chunk) => void` and `onEvent: (event) => void` for
  streaming. The agent loop checks `signal.aborted` at iteration
  boundaries; `workerRuntime` terminates the worker on abort.

The TS surface is genuinely cleaner — the Python side has accumulated
workarounds because Pyodide + asyncio + sandboxed code don't compose
elegantly with cancel.

**Adapter implication:** the abstract `KernelAdapter.sendMessage()`
should take `{ signal, onToken, onEvent }` per the TS shape. The Py
adapter wraps the studio's existing plumbing to honor those callbacks.

### 6. App-preview specifics: `test_app` / `live_app` / `query()`

- **`agex-py` / studio today:** registered as `agent.fn`s on the chat
  agent (`agent_helpers.py`). They cross into JS via `_js_test_app` /
  `_js_live_app` globals on `__main__`, set by `worker.js` at boot.
- **`agex-ts`:** these would be `agent.fn(...)` calls on the TS side,
  bridging into the same iframe via the same JS-host functions. The
  shape is identical; only the registration call differs.

The iframe bridge itself (`iframe-bridge.js`) is shell code — it doesn't
care which kernel called it. Each kernel adapter just needs to register
its language-specific `test_app` / `live_app` / `query()` shim that
ultimately calls the same JS bridge.

The `query()` bridge inside the app iframe **does** need to dispatch to
the right kernel — but since only one kernel is active per session, and
the iframe is session-scoped, the dispatch is implicit (the active
adapter is the one the bridge talks to).

---

## Architectural change: app-storage moves to a shell-managed store

Today, app-storage (the per-session non-versioned key-bag for the iframe
`localStorage` shim) lives in the kvgit-py IDB DB under prefixed keys
`__app_storage__<branch>`, accessed via raw KV reads in `app_storage.py`.

For the unified studio, **app-storage becomes a shell concern, not a
kernel concern.** Reasons:

- agex-ts doesn't expose raw-KV access on its versioned backends
  (`Versioned` doesn't surface its underlying `KVStore`). Reaching it
  would require either a new API on agex-ts or an escape-hatch in
  kvgit-ts. Neither is necessary.
- App-storage was always a shell-level conceptual layer (it backs the
  iframe's `localStorage` shim, which is shell-driven). Putting it in
  the kvgit DB was implementation convenience, not architecture.
- One uniform implementation across both kernels — no per-kernel
  wiring for app-storage.

**Plan:**

- The shell opens its own dedicated IDB database (e.g.,
  `agex-studio-app-storage`) keyed by `<kernel>:<branch>`.
- `getAppStorage` / `flushAppStorage` / `resetAppStorage` /
  `getAppStorageSize` move to the shell's `app-storage.js` module —
  pure JS, no kernel involvement.
- The iframe `localStorage` shim posts to the shell, which reads/writes
  the shared DB. The active kernel's adapter only knows about
  app-storage at bundle export/import time (described next).
- **Bundle export:** the shell composes `kernel-bundle (kvgit
  subgraph)` + `app-storage-bytes (from shell DB)` into the final ZIP.
  Bundle manifest format stays kernel-agnostic and includes app-storage
  alongside the kernel-specific kvgit payload.
- **Bundle import:** reverse. Shell writes app-storage to its DB;
  kernel adapter writes the kvgit payload to its store.
- **One-time migration:** on first run after the studio upgrade, read
  existing `__app_storage__<branch>` entries from the kvgit-py IDB and
  copy them to the new shell DB; delete the originals from the kvgit
  store.

This refactor is shell-side and doesn't depend on either kernel's
adapter. It can land before, alongside, or after Phase 4 — but landing
before makes the adapter cleaner (no app-storage methods on the
adapter at all).

---

## Entry-point inventory

For each studio function, where it lives now → where it'd live in TS,
and the divergence tag.

### `agent.js`

| Studio call | Does what (kernel-level) | TS equivalent | Tag |
|---|---|---|---|
| `initAgentBasics(settings)` | Boot Pyodide, install bridge_llm, construct LLM, construct Agent, register IO. | `createAgent({ name, llm, runtime, state, fs, chapteringTrigger, ... })` returns a ready Agent. | 🔄 different shape — single async init replaces 2 waves. See Big-picture §4. |
| `initAgentRich(settings)` | Install agent_modules.py + agent_helpers.py from URLs, register skills, define `chat` task. | `agent.fn(...)`, `agent.namespace(...)`, `agent.skill(...)`, `agent.task({...})` calls in TS code. | 🔄 different shape — registration via method calls, not module installation. |
| `initAgent(settings)` | Test wrapper: basics + rich. | Just the `createAgent` call (everything's atomic). | 🔄 different shape (see above). |
| `listFiles()` | List all VFS files (recursive). | `(await agent.fs(session)).list(undefined, { recursive: true })`. | ✅ same shape. |
| `readFile(path)` | Read VFS file as UTF-8. | `(await agent.fs(session)).read(path)` → `Uint8Array`; decode. | ✅ same shape. |
| `fileSize(path)` | Byte length of VFS file. | `(await agent.fs(session)).stat(path).size`. | ✅ same shape. |
| `uploadFiles(files)` | Write multiple base64-decoded files into VFS, then `_state.commit()`. | Per-file `fs.write(...)` loop, then `agent.commit(session)`. The buffered `Staged` flushes all writes in one IDB transaction — atomicity matches agex-py's `write_many`. | 🔄 different shape (loop vs. bulk call); ✅ same atomicity. |
| `deleteFiles(paths)` | Remove multiple files, then commit. | Per-file `fs.remove(...)` loop, then `agent.commit(session)`. Same atomicity story. | 🔄 different shape; ✅ same atomicity. |
| `downloadFile(path)` | Read VFS file, base64-encode. | `(await agent.fs(session)).read(path)` then `b64`. | ✅ same shape. |
| `readAppFiles()` | Read every file under `app/`. | `fs.list('app/', { recursive: true })` + `fs.read` loop. | ✅ same shape. |
| `runQuery(code, resultVars)` | Execute scratch TS in agent's sandbox; return serialized vars. | `agent.runtime` is a public getter, `RuntimeAdapter` + `ExecuteContext` are exported. The TS adapter composes: build `ExecuteContext { fs, cache, signal, emissionId }` from per-session host APIs, call `agent.runtime!.execute(code, ctx)`. The snapshot-cache + result-serialization logic stays in the studio's adapter (same shape as agex-py's `queries.py`). | ✅ same shape (composable from existing public surface). |
| `disableQueries()` / `enableQueries()` | JS-side gate on the bridge. | Shell concern. | 🏠 shell-only. |
| `sendMessage(message, onToken)` | Invoke `chat` task with token streaming. | `await chatTask(message, { session, onToken, onEvent, signal })`. | 🔄 different shape — TS uses callback options on the call site. |
| `runChaptering()` | Manually fire chaptering. | `agent.runChaptering(session, opts?)` exists on `Agent` (signature mirrors agex-py). | ✅ same shape. |
| `estimateLogTokens()` | Sum `input_tokens` from latest action. | Iterate `agent.events(session).iter()` → find latest `ActionEvent` → `inputTokens`. | ✅ same shape, slightly different access path. |
| `getTokenHistory()` | Per-action input tokens for charting. | Iterate `agent.events(session).iter()` → collect `ActionEvent.inputTokens`. | ✅ same shape. |

### `sessions.js`

| Studio call | Does what (kernel-level) | TS equivalent | Tag |
|---|---|---|---|
| `initSessions()` | List branches, build session metadata list, set current. | Both kernels: `(await agent.state("default")).staged.versioned.listBranches()`. The shell composes the union from both stores' enumerations + the localStorage cache (see Big-picture §3). | ✅ same shape on each kernel; shell composes the union. |
| `initSessionsFromUrl()` | Parse `/run/?gist=...` and import. | Same shell logic; the import side dispatches to the right adapter based on bundle manifest's `kernel` field. | 🏠 shell-only. |
| `createSession({ kernel })` | Create new branch, write metadata. | TS: `versioned.createBranch(name, { at: initialCommit })`, then write metadata via `staged.set(...)` + `agent.commit(session)`. | ✅ same shape. |
| `switchSession(branch)` | Update current-branch pointer. | TS: `versioned.switchBranch(name)`. Plus shell-level "active session" pointer. | ✅ same shape. |
| `deleteSession(branch)` | Delete branch + app_storage; rebuild list. | TS: `versioned.deleteBranch(name)`; app-storage deletion is shell-side (per refactor). | ✅ same shape. |
| `loadHistory()` | Walk events, flatten chapters, build UI message list. | Walk `agent.events(session).iter()`; same logic — different event type shapes (TS event types are documented in `agex-ts/docs/api/events.md`, mostly mirror Py shapes). | ✅ same shape — JS-side rendering code can be largely shared with two thin event-flavor adapters. |
| `loadHistoryChunked()` | Pure JS pagination over `loadHistory()`. | Identical. | 🏠 shell-only. |
| `getCurrentCommit()` | Branch HEAD hash. | `(await agent.state(session)).currentCommit`. | ✅ same shape. |
| `undoToCommit(commitHash)` | `_state.reset_to(hash)`. | `(await agent.state(session)).staged.versioned.resetTo(hash)`. The Staged buffer probably needs a refresh after reset to drop stale cached reads — adapter implementation detail. | ✅ same shape. |
| `forkSession()` | Create new branch from current HEAD; copy app_storage. | TS: `versioned.createBranch(newName, { at: head })`. App-storage copy is shell-side. | ✅ same shape. |
| `getAppStorage` / `flushAppStorage` / `resetAppStorage` / `getAppStorageSize` | Per-branch non-versioned key-bag. | Moves to a shell-managed dedicated IDB DB (see § "App-storage moves to a shell-managed store"). | 🏠 shell-only after refactor. |
| `getBundleStats(branch)` | Walk reachable kvgit subgraph; cheap preview. | TS: needs an equivalent walking kvgit-ts. | ➕ TS-side port of `bundle.py` (Phase 5). |
| `exportBundle(branch, onProgress)` | Full ZIP export of reachable subgraph + manifest + app_storage. | TS: same logic, ported to TS, walking kvgit-ts. App-storage is read from the shell DB and composed into the same ZIP format. | ➕ TS-side port (Phase 5). |
| `importBundle(bytes)` | Unpack ZIP, write commits/nodes/blobs to kvgit, point a new branch at HEAD. | TS: same logic, against kvgit-ts. App-storage portion goes to the shell DB. | ➕ TS-side port (Phase 5). |
| `openExternalBundle(url)` | Fetch + import. | Shell-level, but the import dispatcher routes based on manifest `kernel`. | 🏠 mostly shell-only; depends on `importBundle` per kernel. |
| `inspectBundle(bytes)` | Read manifest from ZIP. | Pure data — works for both kernels via the shared bundle manifest format. | 🏠 shell-only. |
| `persistSessionMeta(title)` | Update `__session_title__` + `__session_updated__` + commit. | TS: write via `staged.set(...)`, commit. | ✅ same shape. |
| `setSessionMeta(branch, name, description)` | Update name + description on a non-current branch. | Both kernels: read via `versioned.peek(key, { branch })`, write via switch+set+commit OR (cleaner if exposed) direct branch-targeted write. | ✅ same shape. |
| `getSessionDebugInfo(branch)` | Walk kvgit history, count keys/bytes. | TS: same logic against kvgit-ts. | ✅ same shape, different substrate. |

### `pyodide.js` + `worker.js`

| Studio call | Does what | TS equivalent | Tag |
|---|---|---|---|
| `startWorker()` | Boot Pyodide worker. | `workerRuntime({ workerUrl })` — spun up by `createAgent`, not by the shell directly. Lazy-boot belongs at the adapter level (don't construct `KernelAdapter` until session activation). | 🔄 different shape — see Phase 4 lazy-boot. |
| `runPython(code)` | RPC call into worker (used by the shell to drive the agent). | None — agex-ts hosts don't have a "run arbitrary TS in the worker" backdoor; everything goes through agent APIs. The studio's existing `runPython` calls become method calls on the Py adapter, mediated by `agent.executeRaw` where applicable. | 🏠 shell-shaped concern; studio's many `runPython(...)` invocations get translated to adapter methods. |
| `runPythonStreaming(code, onToken)` | RPC + streaming. | Same — no public equivalent; the streaming surface lives in `TaskCallOptions.{onEvent, onToken}`. | 🏠 / 🔄. |
| `setQueryHandler(fn)` | Register iframe `query()` handler. | Same shell concern; the handler dispatches to the active adapter. | 🏠 shell-only. |
| `setLiveIframe(...)` | Register live iframe element. | Same. | 🏠 shell-only. |
| `preloadPlotly()` | Pre-fetch Plotly bytes for sandboxed iframes. | Pure shell concern (the iframe is the same regardless of kernel). | 🏠 shell-only. |

### `worker.js` (the Python-bootstrap side)

This file's whole reason to exist is Pyodide. The TS kernel doesn't need
a sibling — `@agex-ts/runtime-worker` ships its own worker bundle, and
the host doesn't author the worker entry point. The studio's worker.js
becomes Py-specific code under the Py adapter; the TS adapter has no
worker.js to maintain.

🏠 **kernel-specific bootstrap; not a shared concern.**

---

## What `KernelAdapter` likely needs

Synthesizing the inventory, the adapter's surface clusters into ~7 areas.
Sketches below are TypeScript-flavored — the actual interface gets
designed in Phase 3, this is just the input to that design.

```ts
interface KernelAdapter {
  // === Lifecycle ===
  init(settings: KernelSettings): Promise<void>
  dispose(): Promise<void>

  // === Session model (branch ops on this kernel's substrate) ===
  listBranches(): Promise<string[]>
  createBranch(name: string, opts?: { atInitial?: boolean; from?: string }): Promise<void>
  switchBranch(name: string): Promise<void>
  deleteBranch(name: string): Promise<void>
  // Read metadata for a branch without switching to it. Caller (the
  // shell) batches these into the localStorage cache.
  readBranchMeta(name: string): Promise<BranchMeta>
  writeBranchMeta(name: string, patch: Partial<BranchMeta>): Promise<void>

  // === Messaging ===
  sendMessage(
    branch: string,
    message: string,
    opts: { signal?: AbortSignal; onToken?: TokenCallback; onEvent?: EventCallback },
  ): Promise<{ result: ResponsePayload; events: AgentEvent[] }>
  runChaptering(branch: string): Promise<void>

  // === State / commits ===
  getCurrentCommit(branch: string): Promise<string | null>
  undoToCommit(branch: string, hash: string): Promise<void>

  // === VFS ===
  // The adapter owns the per-file-then-commit dance; uploadFiles / deleteFiles
  // surface as bulk methods even though both kernels implement them as a loop.
  listFiles(branch: string): Promise<string[]>
  readFile(branch: string, path: string): Promise<Uint8Array>
  writeFiles(branch: string, files: Record<string, Uint8Array>): Promise<void>
  deleteFiles(branch: string, paths: string[]): Promise<void>

  // === Bundle import/export (kernel-specific kvgit graph walk) ===
  exportBundlePayload(branch: string, opts: { onProgress?: ProgressCallback }): Promise<{
    bytes: Uint8Array
    manifest: KernelBundleManifest
  }>
  importBundlePayload(payload: Uint8Array): Promise<{ branch: string; manifest: KernelBundleManifest }>
  getBundleStats(branch: string): Promise<BundleStats>

  // === History rendering ===
  // Returns events in the shell's UI-message-friendly shape, NOT the
  // raw kernel events — keeps language-flavor differences inside the
  // adapter. Phase 3 designs the exact shape.
  loadHistory(branch: string): Promise<UiMessage[]>

  // === Query bridge for iframe apps ===
  // Snapshot-cache + serialize-result orchestration is studio-side in
  // both adapters; the underlying primitive is `agent.executeRaw` on
  // TS or the existing `queries.py` flow on Py.
  runQuery(branch: string, code: string, resultVars: string[] | null): Promise<Record<string, unknown>>

  // === Token telemetry ===
  estimateLogTokens(branch: string): Promise<number>
  getTokenHistory(branch: string): Promise<number[]>

  // === Debug ===
  getSessionDebugInfo(branch: string): Promise<SessionDebugInfo>
}
```

Things deliberately **not** in the adapter:

- **Branch enumeration union, localStorage cache, kernel detection.**
  Shell concern (see Big-picture §3). The shell builds the unified
  drawer state from per-kernel `listBranches()` + cache.
- **App-storage.** Shell-managed dedicated IDB DB (see § "App-storage
  moves to a shell-managed store"). Adapters only see app-storage at
  bundle export/import time, where the shell composes/decomposes the
  combined ZIP.
- **Gist publish / fetch.** Pure shell concern.
- **iframe bridge plumbing.** Shell concern; the bridge calls
  `adapter.runQuery(...)` / `adapter.test_app(...)` / etc.
- **Drive picker + OAuth.** Shell concern; on import, bytes go through
  `adapter.writeFiles(...)`.
- **Settings drawer.** Settings are global; only `adapter.init(settings)`
  needs them.
- **App preview rendering.** Shell concern.
- **Theme, header, chat input, message rendering.** Shell.

---

## agex-ts: no additions needed

The verification list (tracked in earlier drafts of this doc) is fully
closed. Everything resolves with no agex-ts API changes.

**Resolved without changes:**

- ✅ Branch primitives in kvgit-ts — confirmed all there (`listBranches`,
  `createBranch({ at })`, `switchBranch`, `deleteBranch`, `peek(key,
  { branch })`, `checkout`, `resetTo`).
- ✅ Session model is uniform across both kernels (Big-picture §1).
- ✅ Reset-to-commit — `Versioned.resetTo(commitHash)` exists.
- ✅ Bulk file ops — atomicity comes from `Staged` buffering + single
  `commit`; per-file loop matches agex-py semantics.
- ✅ Raw KV access for app-storage — sidestepped by moving app-storage
  to a shell-managed IDB DB.
- ✅ Manual chaptering trigger — `agent.runChaptering(session, opts?)`
  exists on `Agent`, signature mirrors agex-py.
- ✅ Runtime adapter for `runQuery` — `agent.runtime` is a public
  getter; `RuntimeAdapter` and `ExecuteContext` are exported from
  `types.ts`. The TS adapter composes directly without needing an
  agex-ts wrapper.

**Genuine TS-side new code (Phase 5 work, not agex-ts additions):**

- **Bundle export/import port.** The graph walk in `bundle.py`
  (`_walk_reachable`, `export_bundle`, `import_bundle`) needs porting
  to TS, walking kvgit-ts's HAMT and commit chain. Manifest format
  stays kernel-agnostic JSON — both bundles produce comparable
  manifests; the difference is the kvgit-py-encoded vs kvgit-ts-encoded
  payload bytes.

---

## What this implies for the work order

- **Phase 3** designs the `KernelAdapter` interface. The big-picture
  facts (#1–6 above) and the agex-ts additions list (just two small
  APIs) are the input. Lower-stakes than the original sketch suggested
  — most of the surface is "same shape, branch-scoped methods on each
  kernel."
- **Phase 4** refactors the studio against the adapter, with the Py
  adapter implementing it. Three threads of work, mostly orthogonal:
  - Implement `PyKernelAdapter` against the new interface (mostly
    repackaging existing studio code).
  - Build the shell-side cold-start machinery: pure-JS IDB
    enumeration union + localStorage metadata cache (Big-picture §3).
  - Refactor app-storage out of the kernel substrate into a
    shell-managed dedicated IDB DB. One-time migration of existing
    `__app_storage__<branch>` entries from the kvgit-py store.
- **Phase 5** implements the Ts adapter. Concentrated risk:
  - Bundle export/import — the only genuinely new TS-side code (the
    rest is calls into existing agex-ts APIs).
  - `runQuery` — composed from `agent.runtime.execute(code, ctx)` plus
    the studio-side snapshot/serialize orchestration ported from
    `queries.py`.
  - Chat task primer + minimal TS skill set (different language,
    different interactive-app idioms, much smaller `interactive-app`
    skill since the cross-language `query()` complexity collapses).

The session-as-DB-vs-branch divergence I worried about earlier turned
out to be illusory. The actual divergence (two parallel IDB stores,
format-incompatible) is mediated cleanly by the shell-level cold-start
machinery — and works *better* than a unified store would (no risk of
one kernel corrupting the other's data, no encoder-version coupling
across kernels).
