/**
 * KernelAdapter — protocol for kernel-specific operations.
 *
 * The studio shell talks to either a `Py` adapter (Pyodide / agex-py)
 * or a `Ts` adapter (Web Worker / agex-ts) via this protocol. ALL
 * methods are **branch-explicit** — the adapter manages whatever
 * "current branch" pointer its kernel needs internally. Callers don't
 * see that distinction; they just say "operate on branch X".
 *
 * Concrete adapters implement this as a plain JS object exporting
 * functions matching the typedef.  See `py-kernel-adapter.js` and
 * `ts-kernel-adapter.js`.
 *
 * Shell-only concerns deliberately NOT in this interface — these live
 * in shared shell modules and call into the adapter as needed:
 *
 *   - Branch enumeration union across kernels (cold-start drawer)
 *   - localStorage metadata write-through cache
 *   - App-storage (lives in a shell-managed dedicated IDB DB)
 *   - Bundle ZIP packaging (shell composes kernel payload + app-storage)
 *   - iframe bridge plumbing, gist publish, settings, OAuth, theme,
 *     chat shell rendering, app preview rendering
 *
 * This typedef plus its two implementations are the canonical truth
 * for the kernel boundary.
 */

// ---------------------------------------------------------------------------
// Settings (shared shell → adapter init)
// ---------------------------------------------------------------------------

/**
 * Settings the shell hands to an adapter at init time.  Subset of the
 * studio's global settings store, narrowed to fields the kernel needs
 * to construct its LLM client and configure its agent.
 *
 * @typedef {Object} KernelSettings
 * @property {string} apiKey
 * @property {string} model
 * @property {"openai" | "anthropic"} [provider]
 * @property {string} [baseUrl]
 * @property {number} [chapteringTrigger]
 * @property {boolean} [toolUseWireFormat]
 * @property {"low" | "medium" | "high"} [reasoningEffort]
 */

// ---------------------------------------------------------------------------
// Per-branch metadata
// ---------------------------------------------------------------------------

/**
 * Metadata stored alongside a branch (in the kernel's substrate).
 *
 * `kernel` is *not* in this shape — the adapter is per-kernel, so the
 * caller already knows.  The shell composes `BranchMeta` with the
 * adapter's `kernel` value when building the unified drawer state.
 *
 * @typedef {Object} BranchMeta
 * @property {string} title - Agent-generated session title.
 * @property {string} name - User-curated custom name (may be empty).
 * @property {string} description - User-curated description (may be empty).
 * @property {string} updated - ISO 8601 UTC timestamp of last activity.
 * @property {boolean} [external] - true when the session was imported from
 *   an external bundle (gates host-capability features the visitor might
 *   not want to lend to a stranger's artifact). Persists in branch metadata.
 * @property {boolean} [starred] - true when the user has "kept" this
 *   session as an app; drives the drawer's pinned "Apps" group. Ts-only
 *   (gated at toggle time). Persists in branch metadata.
 */

// ---------------------------------------------------------------------------
// Streaming + progress callbacks
// ---------------------------------------------------------------------------

/**
 * A chunk of streamed LLM text — the common case, one per delta.
 *
 * @typedef {Object} TextTokenChunk
 * @property {string} type
 * @property {string} content
 * @property {boolean} start
 * @property {boolean} done
 */

/**
 * A sub-agent activity chunk. Not LLM text: the Ts adapter synthesizes
 * these from a clone's tagged events so the chat can render a live
 * "spawn chip" (start → progress → end) without the caller subscribing
 * to the event stream separately. Rides the same `onToken` channel
 * because it updates the same in-flight turn.
 *
 * @typedef {Object} SpawnTokenChunk
 * @property {"spawn"} type
 * @property {"start" | "progress" | "end"} phase
 * @property {string|number} id - Clone identity, stable across phases.
 * @property {number} [steps] - Actions taken so far (progress / end).
 * @property {string} [inputsSummary] - Short label for the chip.
 * @property {string} [inputs] - Full input text for the drill-down.
 * @property {string} [content] - Clone stdout / error detail.
 * @property {string} [result] - Settled value, on `end`.
 * @property {string} [error] - Failure message, on `end`.
 * @property {number} [elapsedMs] - Wall time, on `end`.
 * @property {number} [startedAt] - Epoch ms the clone began, so the
 *   chip can tick a live elapsed counter without the shell tracking it.
 * @property {Array<Object>} [events] - Split output events for the
 *   drill-down panel.
 * @property {string} [status] - Terminal outcome on `end`
 *   (`success` / `fail` / `cancelled`).
 * @property {number} [durationMs] - Wall time the clone took, on `end`.
 * @property {string} [resultSummary] - Short label for the settled
 *   value, shown on the collapsed chip.
 */

/**
 * What `onToken` receives. The shell switches on `type`.
 *
 * @typedef {TextTokenChunk | SpawnTokenChunk} TokenChunk
 */

/**
 * @typedef {Object} ProgressUpdate
 * @property {string} phase
 * @property {number} done
 * @property {number} total
 */

/** A raw event from the agent's event log.  Shape varies by kernel —
 *  the shell treats the inner shape opaquely and lets each adapter
 *  expose its events.  History is normalized into `UiMessage` by the
 *  adapter, so downstream code mostly doesn't see this type.
 *
 * @typedef {Object} AgentEvent
 */

// ---------------------------------------------------------------------------
// Bundles (kernel-specific kvgit payload only — shell composes app-storage)
// ---------------------------------------------------------------------------

/**
 * Cheap stats preview for the export modal.  The adapter also fills in
 * branch-level metadata (title, name, description) so the shell can
 * render a complete preview without a separate readBranchMeta round-trip.
 *
 * @typedef {Object} BundleStats
 * @property {string} branch
 * @property {string} head
 * @property {number} commits
 * @property {string} title
 * @property {string} name
 * @property {string} description
 */

/**
 * Kernel-specific bundle payload.  The shell wraps this with
 * app-storage bytes (read from its own DB) and a kernel-agnostic
 * outer envelope to produce the final user-facing `.agex` archive.
 *
 * `manifest` is an open record — fields are kernel-agnostic where
 * possible (see `bundle.py` for the agex-py shape) and include at
 * minimum: `format_version`, `runtime_version`, `branch`, `head`,
 * `name`, `description`, `kernel`, `created_at`, `stats`.
 *
 * @typedef {Object} BundlePayload
 * @property {Uint8Array} bytes
 * @property {Object} manifest
 */

// ---------------------------------------------------------------------------
// History rendering (adapter normalizes to a uniform UI shape)
// ---------------------------------------------------------------------------

/**
 * One row in the chat shell's message list.  The adapter walks its
 * kernel's event log and produces these — language-flavor differences
 * (Py event types vs. TS event types) collapse here, so downstream
 * rendering code doesn't need to branch on kernel.
 *
 * `content` polymorphism by `role`:
 *   - `"user"` — `string` (plain text or markdown when isMarkdown is true)
 *   - `"agent"` — either a `string` (intermediate report) OR a
 *     structured object describing a multi-part Response
 *     (`{ type: "response", parts: ... }` or `{ type: "text", content: ... }`)
 *   - `"chaptering"` — accompanies a `chapters` field with the folded ranges
 *
 * @typedef {Object} UiMessage
 * @property {"user" | "agent" | "chaptering"} role
 * @property {string | Object} content
 * @property {Date} timestamp
 * @property {string} [commit_hash]
 * @property {Array<Object>} [events] - Action / output events for an agent message.
 * @property {boolean} [isReport] - True for intermediate-report messages from the agent.
 * @property {boolean} [isMarkdown] - True when content is markdown (e.g. file-event recaps).
 * @property {boolean} [cancelled] - True for an agent message produced from a CancelledEvent.
 * @property {Array<Object>} [chapters] - For chaptering rows: per-chapter detail.
 * @property {boolean} [streaming] - True while the row is a live
 *   streaming placeholder rather than a settled message. Set by
 *   `SessionRuntime`'s token accumulator and cleared when the turn
 *   lands; rows carrying it are filtered out before persisting.
 * @property {string} [errorStack] - Captured stack for an agent row
 *   representing a thrown error, surfaced behind the row's detail
 *   toggle. Absent on ordinary messages.
 */

// ---------------------------------------------------------------------------
// Method-level option types
// ---------------------------------------------------------------------------

/**
 * @typedef {'history-ready' | 'send-ready'} InitStage
 */

/**
 * @typedef {Object} InitOptions
 * @property {(stage: InitStage) => void | Promise<void>} [onStage]
 *   Fires at init lifecycle milestones so the shell can render
 *   progressively.  May return a Promise; the adapter awaits the
 *   callback before continuing.  Lets the shell gate the next stage
 *   on shell-side work — e.g., "load history before kicking Wave 3"
 *   keeps the existing serialized init UX (preventing Pyodide's
 *   Wave-3 install from competing with shell-side history reads).
 */

/**
 * @typedef {Object} CreateBranchOptions
 * @property {string} [from] - Source branch HEAD to fork from.  Omit to
 *   create a fresh branch off the kernel's initial commit.
 */

/**
 * @typedef {Object} SendMessageOptions
 * @property {AbortSignal} [signal] - Cancel the in-flight task.
 * @property {(t: TokenChunk) => void} [onToken] - LLM token streaming.
 * @property {(e: AgentEvent) => void} [onEvent] - Per-event live stream.
 */

/**
 * @typedef {Object} ExportBundleOptions
 * @property {(p: ProgressUpdate) => void} [onProgress]
 * @property {"full" | "flat" | "flat-downsample" | "flat-strip"} [shape]
 *   How much history and image weight to carry. `full` (default)
 *   exports the branch as-is; the `flat*` shapes snapshot the tip into
 *   a single commit first, optionally downsampling or stripping image
 *   parts. Ts-only — the py adapter ignores it.
 */

// ---------------------------------------------------------------------------
// Debug
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} SessionDebugInfo
 * @property {string} branch
 * @property {string | null} commit - Short hash, or null if branch is empty.
 * @property {number} commits
 * @property {number} keys_total
 * @property {Array<string>} keys
 * @property {number} bytes
 * @property {Array<{ key: string, bytes: number }>} top_keys
 */

// ---------------------------------------------------------------------------
// The protocol itself
// ---------------------------------------------------------------------------

/**
 * The kernel adapter protocol.
 *
 * @typedef {Object} KernelAdapter
 *
 * @property {"py" | "ts"} kernel
 *   Which kernel this adapter wraps.  Constant for the lifetime of the
 *   adapter; useful for assertions, log labels, and cache keys.
 *
 * --- Lifecycle -----------------------------------------------------------
 *
 * @property {(settings: KernelSettings, opts?: InitOptions) => Promise<void>} init
 *   Bring the kernel online.  Heavy work (Pyodide bootstrap, worker
 *   spawn) happens here — the shell calls this lazily, on the first
 *   user action that touches one of this kernel's sessions.
 *
 *   `opts.onStage(stage)` fires at lifecycle milestones so the shell
 *   can render progressively while init is still in flight:
 *
 *     - `'history-ready'` — branch list, metadata, file list, and
 *       history rendering are usable. Most read-only adapter methods
 *       work. Send doesn't yet.
 *     - `'send-ready'` — full capability. Send works.
 *
 *   For Py, these correspond to Pyodide's two-wave install (basics →
 *   rich); the shell uses the gap to load history while heavy
 *   library install continues. For Ts, both stages fire back-to-back
 *   at the end of init (single-phase setup; no gap to exploit).
 *
 *   The returned promise resolves when `'send-ready'` has fired.
 *
 *   May be called more than once to update settings (e.g., user
 *   changes model or API key in the settings drawer). The bootstrap
 *   work happens at most once; subsequent calls just propagate
 *   settings to the live agent.
 *
 * @property {() => Promise<void>} dispose
 *   Tear down.  After this resolves, no further calls should be made
 *   on this adapter instance.  The shell calls this on tab unload
 *   (best-effort) and may call it on idle-eviction in long sessions.
 *
 * --- Branch operations ---------------------------------------------------
 *
 * @property {() => Promise<string[]>} listBranches
 *   Return all chat-* branches in this kernel's substrate.  The shell
 *   uses this during cold-start verification (after first rendering
 *   the drawer from the localStorage cache, the shell reconciles
 *   against the live list to catch branches added in another tab).
 *
 * @property {() => Promise<Array<BranchMeta & { branch: string, external: boolean }>>} listBranchesWithMeta
 *   Like `listBranches` but each entry carries title / name /
 *   description / updated / external alongside the branch name.
 *   One kernel round-trip total — used by sessions.js's
 *   list-rebuild path so loading 50 sessions doesn't pay 50
 *   readBranchMeta round-trips.
 *
 * @property {(name: string, opts?: CreateBranchOptions) => Promise<void>} createBranch
 *   Create a new branch.  With `opts.from`, branches off that branch's
 *   HEAD; otherwise from the kernel's initial commit.  Stamps
 *   `__session_kernel__` (this adapter's kernel) and
 *   `__session_updated__` on the new branch and commits.
 *
 * @property {(name: string) => Promise<void>} deleteBranch
 *   Delete the named branch.  If it was active, the adapter falls back
 *   to another chat-* branch internally (creating one if none remain)
 *   so subsequent calls don't trip on a missing active branch.
 *   The shell is responsible for choosing what to render after this
 *   returns; the adapter's fallback is just a safety net.
 *
 * @property {(name: string) => Promise<BranchMeta>} readBranchMeta
 *   Read metadata for any branch.  Does not change the active branch.
 *   Missing fields default to empty strings (and `updated` defaults to
 *   `""` for un-stamped branches).
 *
 * @property {(name: string, patch: Partial<BranchMeta>) => Promise<void>} writeBranchMeta
 *   Update metadata fields on the named branch.  Adapter handles
 *   whatever activation dance the kernel requires.  Commits.
 *
 * --- Messaging -----------------------------------------------------------
 *
 * @property {(branch: string, message: string, opts?: SendMessageOptions) => Promise<{ result: any, events: AgentEvent[] }>} sendMessage
 *   Send a chat message and run the chat task on the named branch.
 *   Streams tokens via `opts.onToken` and per-event updates via
 *   `opts.onEvent`.  Honors `opts.signal` for cancellation.  Returns
 *   the parsed final result plus the action/output events from this
 *   turn for downstream UI rendering.
 *
 *   Cancellation: when `opts.signal.aborted` fires, the in-flight LLM
 *   call is aborted, agent execution halts, a `CancelledEvent` lands
 *   in the log, and this promise rejects with a cancellation error.
 *
 * @property {(branch: string) => Promise<void>} runChaptering
 *   Manually fire chaptering on the named branch's event log.  No-op
 *   if there's nothing foldable.
 *
 * --- State / commits -----------------------------------------------------
 *
 * @property {(branch: string) => Promise<string | null>} getCurrentCommit
 *   Branch HEAD hash, or `null` for an empty branch (rare).
 *
 * @property {(branch: string, hash: string) => Promise<void>} undoToCommit
 *   Reset the branch's HEAD to `hash`.  Drops any unflushed staged
 *   writes; the adapter ensures the kernel's read cache is invalidated
 *   so subsequent reads see the post-reset state.
 *
 * --- VFS -----------------------------------------------------------------
 *
 * @property {(branch: string) => Promise<string[]>} listFiles
 *   List all files (recursive) in the branch's VFS.  Returns full paths
 *   relative to the FS root (e.g., `"helpers/utils.py"`).
 *
 * @property {(branch: string, path: string) => Promise<Uint8Array>} readFile
 *   Read a file's bytes from the branch's VFS.  Shell decodes as needed.
 *
 * @property {(branch: string, path: string) => Promise<number>} fileSize
 *   Byte length of the file at `path`.  Cheaper than reading the
 *   full file just to count its size — used by FileModal to render
 *   the "binary file: NNN bytes" placeholder before any preview
 *   download.
 *
 * @property {(branch: string, files: Record<string, Uint8Array>) => Promise<void>} writeFiles
 *   Write multiple files to the branch's VFS in one atomic commit.  The
 *   adapter loops `fs.write(...)` per file; the buffered Staged batches
 *   them into a single kvgit commit.
 *
 * @property {(branch: string, paths: string[]) => Promise<void>} deleteFiles
 *   Remove multiple files atomically (one commit).
 *
 * @property {(branch: string) => Promise<Record<string, string>>} readAppFiles
 *   Read every text file under `app/` in one call, returning a
 *   path-to-string dict.  Used by AppPreview to build the iframe
 *   HTML.  UTF-8 decoded with `errors="replace"`; binary extensions
 *   (.png/.jpg/etc — see `app-assets.js` BINARY_EXTS) are skipped
 *   here and picked up by `readAppBinaries` instead.  Saves N
 *   JS↔kernel round-trips over per-file `readFile` for typical
 *   multi-file apps.
 *
 * @property {(branch: string) => Promise<Record<string, Uint8Array>>} readAppBinaries
 *   Read every binary asset file under `app/` (images, fonts,
 *   audio, etc.) as raw bytes.  `buildAppHtml` consumes these
 *   alongside the text-file map and inlines each as a data URL so
 *   `<img>`, CSS `url(...)`, and `fetch(...)` references resolve
 *   inside the sandboxed iframe.  Kernels without binary-asset
 *   support yet (currently py) return an empty map; the live
 *   preview just won't have image rewrites in that case.
 *
 * @property {(branch: string) => Promise<void>} wipeAgentMemory
 *   Drop the "agent memory" keys on `branch` — event log, cache,
 *   legacy sub-task keys — while leaving the VFS file blobs and
 *   session metadata intact.  Not currently consumed by fork (the
 *   fresh-chat fork mode now squashes by re-setting files onto a
 *   genesis-branch instead), but kept as a documented primitive
 *   for future "soft wipe in place" capabilities (reset chat on
 *   an existing branch without forking).  Kernels without a wipe
 *   path (currently py) throw.
 *
 * --- Bundle payloads (kvgit subgraph only — shell handles app-storage) ---
 *
 * @property {(branch: string, opts?: ExportBundleOptions) => Promise<BundlePayload>} exportBundlePayload
 *   Walk the kvgit subgraph reachable from `branch` HEAD; return bytes
 *   plus a manifest record (includes `kernel: this.kernel`).  The
 *   shell composes this with app-storage bytes and a kernel-agnostic
 *   outer manifest into the final `.agex` ZIP.
 *
 * @property {(payload: Uint8Array) => Promise<{ branch: string, manifest: Object }>} importBundlePayload
 *   Unpack and write the kvgit subgraph from `payload`; create a fresh
 *   branch pointing at the imported HEAD.  Returns the new branch name
 *   and the embedded manifest.  App-storage import is done separately
 *   by the shell against its own DB.
 *
 * @property {(branch: string) => Promise<BundleStats>} getBundleStats
 *   Cheap preview — commit count + branch metadata.  Used by the
 *   export modal before the user commits to the full export.
 *
 * @property {(branch: string) => Promise<{ profile: Object, estimates: Object } | null>} profilePublishSizes
 *   Per-category byte profile + approximate bundle sizes for each
 *   publish shape — drives the publish modal's shape options.
 *   Ts-kernel capability; the py adapter returns `null`, which tells
 *   the publish flow to skip the shape-options stage.
 *
 * @property {(sourceBranch: string, destBranch: string, opts?: { images?: "full" | "strip" | "downsample" }) => Promise<{ branch: string, keys: number, imagesTransformed: number }>} snapshotToBranch
 *   Persistent snapshot: copy `sourceBranch`'s tip into a single
 *   fresh commit on `destBranch` (the "compact copy" fork).  Resolves
 *   with the destination branch plus what the copy moved — key count
 *   and how many image parts the `images` mode rewrote.  Ts-only;
 *   the py adapter throws (the fork modal disables the option for py
 *   sessions before this could be reached).
 *
 * --- History rendering ---------------------------------------------------
 *
 * @property {(branch: string) => Promise<UiMessage[]>} loadHistory
 *   Walk the branch's event log and return UI-message rows.  Adapter
 *   handles chapter flattening (originals stay browseable via the
 *   `/chapters/<slug>/` overlay) and the language-flavor mapping from
 *   raw events to the uniform `UiMessage` shape.
 *
 * --- Query / cache bridges for iframe apps ------------------------------
 *
 * Two complementary affordances for app↔agent data passing — each
 * kernel implements one fully and stubs the other today:
 *
 *   - `runQuery`: py-side affordance (live code execution in agent space).
 *     TS adapter stubs this — agex-ts's worker runtime doesn't expose a
 *     namespace-capture API yet (separate concern from the chat task's
 *     `ts` emissions).
 *   - `getCacheValue`: TS-side affordance (read pre-stashed values from
 *     the agent's cache). Py adapter stubs this today — py apps use
 *     `runQuery` for app↔agent data passing instead. Could land later
 *     if py wants the same ergonomics.
 *
 * Both methods are in the typedef so the iframe bridge can call either
 * without per-kernel branching at the call site; the adapter throws a
 * clear "not implemented for this kernel" error when the wrong path is
 * exercised, telling the agent which alternative to use.
 *
 * @property {(branch: string, code: string, resultVars: string[] | null) => Promise<Record<string, unknown>>} runQuery
 *   Execute `code` in the branch's sandbox with a snapshot of the
 *   branch's `cache` and shared VFS access.  Returns the requested
 *   variables (when `resultVars` is an array), or the entire
 *   serializable namespace (when `null`).
 *
 *   The asymmetric-state contract both adapters honor identically —
 *   state sharing between the chat agent and a query is intentional
 *   and asymmetric per slice:
 *     - cache: SNAPSHOT — copied into scratch state at query start;
 *       apps read what the agent explicitly cached, but later chat
 *       writes don't appear until the next query.
 *     - VFS: shared LIVE — queries read whatever is currently on
 *       disk; helper/scratch files survive the round-trip.
 *     - query-side writes: discarded — they land in scratch state
 *       that never syncs back and never commits. Load-bearing: if
 *       queries persisted, app reads would leak into the chat event
 *       log and inflate prompt token costs; speculative writes would
 *       clobber live app state.
 *
 * @property {(branch: string, key: string) => Promise<unknown>} getCacheValue
 *   Read a value from the branch's agent cache (`cache.set(key, value)`
 *   in agent code stashes it; this method reads it back). Used by
 *   iframe apps to pull pre-computed results without round-tripping
 *   through `runQuery`. Returns `null` when the key isn't set —
 *   the iframe bridges (`app-control.js`, `AppPreview.svelte`) coerce
 *   `undefined` → `null` before posting back so in-app callers see a
 *   JSON-roundtrippable value uniformly.
 *   Values must be JSON-roundtrippable (strings, numbers, arrays,
 *   plain objects) so the iframe can deserialize them via postMessage.
 *
 * @property {(branch: string, spec: unknown, signal?: AbortSignal) => Promise<unknown>} spawn
 *   Run a `spawn` (an ephemeral agent clone fulfilling an inline
 *   SpawnSpec) on behalf of an embedded app — iframe-initiated, so it
 *   records nothing to the chat narrative. Returns the clone's result;
 *   rejects if it fails / is cancelled. `signal` lets the app cancel a
 *   long-running call. TS-side affordance (mirrors `getCacheValue`'s
 *   split); the Py adapter stubs it with a clear "not implemented"
 *   error.
 *
 * --- Token telemetry -----------------------------------------------------
 *
 * @property {(branch: string) => Promise<number>} estimateLogTokens
 *   Estimate of the branch's current LLM context size in tokens.
 *   Drives the chaptering-trigger meter in the chat shell.
 *
 * @property {(branch: string) => Promise<number[]>} getTokenHistory
 *   Per-`ActionEvent` `inputTokens` values in chronological order, for
 *   the context-growth chart.
 *
 * --- Debug ---------------------------------------------------------------
 *
 * @property {(branch: string) => Promise<SessionDebugInfo>} getSessionDebugInfo
 *   Walk the kvgit history; count commits, keys, top key sizes.  Used
 *   by the session drawer's debug panel.
 */

// This module is types-only.  The empty export marks it as an ES
// module so editor tooling treats the file consistently with the rest
// of the studio source.
export {};
