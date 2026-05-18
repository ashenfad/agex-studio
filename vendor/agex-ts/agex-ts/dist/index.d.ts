import { E as EventLog, A as AgentEvent, C as ChapterEvent, L as LLMClient, R as RuntimeAdapter, S as StateConfig, F as FSConfig, N as NamespaceResolver, P as Policy, M as MemberFilter, a as MemberConfig, T as TerminalCommandHandler, b as TaskDefinition, c as TaskCallOptions, d as TaskFn, e as Chapter, V as VirtualFileSystem, f as Cache, g as TokenChunk } from './types-BdbZoJfu.js';
export { h as ActionEvent, i as CancelledEvent, j as Emission, k as ErrorEvent, l as EventBase, m as ExecResult, n as ExecuteContext, o as FailEvent, p as FileEditEmission, q as FileEvent, r as FileWriteEmission, H as HostFnContext, I as ImageFormat, s as LLMConfig, t as LLMRequest, u as LLMResponse, O as OutputEvent, v as OutputPart, w as RegisteredCls, x as RegisteredFn, y as RegisteredNs, z as RegisteredSkill, B as RegisteredTerminal, D as RegistrationCommon, G as RuntimeInitOptions, J as SuccessEvent, K as SystemNoteEvent, Q as TaskOutcome, U as TaskStartEvent, W as TerminalEmission, X as TextEmission, Y as ThinkingEmission, Z as TokenChunkType, _ as TsEmission } from './types-BdbZoJfu.js';
import * as _standard_schema_spec from '@standard-schema/spec';
import { CommitInfo } from 'kvgit-ts';
import { S as StateBackend, a as StateResolver } from './connect-DDn4Adrl.js';
import { memberAllowed } from './policy.js';
export { AgentError, BrandedTaskError, CancelledError, FatalError, RegistrationError, SchemaError, TASK_CONTROL_BRAND, TaskFailError, TransientError, isTaskControlError } from './errors.js';
import 'termish-ts';

/**
 * `EventLogImpl` — append-only log of `AgentEvent`s, organized as
 * an explicit ordered index over a `StateBackend`.
 *
 * Storage layout (within the per-session state):
 *   `__event_log__`            — ordered array of event refs (state
 *                                keys), defines the active log shape
 *   `evt/<ISO ts>/<seq>`       — one entry per event, holds the value
 *
 * The `StateBackend` handed in is already session-scoped (one
 * `VersionedKV` per session at the substrate layer), so this log
 * uses plain keys with no session prefix. Sessions are isolated below
 * this layer.
 *
 * `iter()` walks the index, batch-fetching values. The prefix scan
 * the prior implementation used returns inactive keys post-chaptering;
 * walking the index naturally yields chapters in place of the events
 * they replaced.
 *
 * `replaceRange(eventRefs, chapterEvent)` is the chaptering primitive
 * that mirrors agex-py's `replace_events_with_chapters`: writes the
 * chapter event at its own state key, rewrites the index to splice
 * the chapter ref in at the position of the first removed event, and
 * removes the chaptered refs from the index. The originals stay at
 * their state keys so callers can browse them via
 * `ChapterEvent.eventRefs` (the upcoming `/chapters/<slug>/` VFS
 * overlay reads them from there).
 */

declare class EventLogImpl implements EventLog {
    #private;
    constructor(state: StateBackend, session?: string);
    /** Session id this log is scoped to. */
    get session(): string;
    add(event: AgentEvent): Promise<string>;
    iter(): AsyncIterable<AgentEvent>;
    /** Read an event by its state key. The chaptering primitive
     *  (`replaceRange`) leaves the originals at their keys when it
     *  rewrites the active index — callers holding a
     *  `ChapterEvent.eventRefs` array can resolve them via this. */
    byKey(stateKey: string): Promise<AgentEvent | null>;
    at(commitHash: string): Promise<EventLog | null>;
    /** Read the index of active event refs in chronological order.
     *  Used by chaptering to map numbered positions back to state
     *  keys; not part of the public `EventLog` interface. */
    refs(): Promise<ReadonlyArray<string>>;
    /** Replace a contiguous run of event refs with a single
     *  `ChapterEvent`. The originals stay at their state keys (so
     *  `chapterEvent.eventRefs` can resolve them) but are removed
     *  from the active index. Subsequent `iter()` yields the chapter
     *  in their place.
     *
     *  Mirrors agex-py's `replace_events_with_chapters`. Returns the
     *  state key the chapter event was written to. */
    replaceRange(eventRefs: ReadonlyArray<string>, chapterEvent: ChapterEvent): Promise<string>;
}

interface AgentOptions {
    /** Display name. Used in event logs and error messages. */
    readonly name: string;
    /** System-prompt addendum (the "agent's voice"). Optional. */
    readonly primer?: string;
    /** LLM driver. Required for any task that calls the model. v1 ships
     *  the `Dummy` client for tests; production agents bring their own. */
    readonly llm?: LLMClient;
    /** Runtime that executes `ts` emissions. The default v1 runtime
     *  ships separately as `@agex-ts/runtime-worker`; tests can use the
     *  in-process eval runtime in `agex-ts/runtime-eval`. */
    readonly runtime?: RuntimeAdapter;
    /** Persistent state. Defaults to in-process `Live`. */
    readonly state?: StateConfig;
    /** Virtual filesystem. Defaults to per-session in-memory. */
    readonly fs?: FSConfig;
    /** Max iterations per task (turn cap). Default `10`. */
    readonly maxIterations?: number;
    /** Threshold (in input tokens, as reported by the latest
     *  `ActionEvent`) at which chaptering fires. When set, the
     *  framework auto-registers a chapter task with the default
     *  primer (override via `chapterPrimer`). Without this option,
     *  no chapter task is registered and chaptering never runs. */
    readonly chapteringTrigger?: number | undefined;
    /** Override the default primer the auto-registered chapter task
     *  uses. Most embedders should leave this undefined —
     *  `DEFAULT_CHAPTER_PRIMER` describes the boundary-based
     *  contract the framework expects. Supply a custom one if you
     *  want different framing or domain-specific guidance. Ignored
     *  when `chapteringTrigger` is undefined. */
    readonly chapterPrimer?: string;
    /** Replace the agex-ts `BUILTIN_PRIMER` entirely. Use only if
     *  you really mean to override agex's environment description —
     *  the agent loses the conventions explanation and best
     *  practices. Most users want `primer` (their own voice) or
     *  `capabilitiesPrimer` (curated tools list) instead. */
    readonly agexPrimerOverride?: string;
    /** Replace the auto-rendered "Registered Resources" section with
     *  curated prose. Useful when you want to organize tools
     *  thematically or surface only some of them. The auto-renderer
     *  still runs against the policy table (so the runtime adapter
     *  injects everything that's registered) — this only affects
     *  what the agent SEES in the system prompt. */
    readonly capabilitiesPrimer?: string;
    /** When set, unregistered import specifiers in the agent's
     *  emitted code are passed to this function. Returning a URL
     *  imports that module; returning null (or throwing) denies the
     *  import (agent sees a `Cannot find module 'X'` error on its
     *  next turn). May be sync or async. Resolver doesn't appear in
     *  the system message — agents discover availability by trying
     *  the import. See `NamespaceResolver` in `agex-ts/types`. */
    readonly namespaceResolver?: NamespaceResolver;
}
/**
 * Subset of `AgentOptions` that's safe to hot-swap on a constructed
 * `Agent` via `reconfigure(...)`. Each field replaces its current
 * value on the next read (next LLM call / next task boundary, see
 * `Agent.reconfigure` for per-field timing).
 *
 * Excluded: `name`, `state`, `runtime`, `fs`. Mutating those mid-
 * session would orphan per-session resources or break invariants
 * the substrate depends on. To change them, dispose and recreate.
 */
interface ReconfigurableOptions {
    readonly llm?: LLMClient;
    readonly primer?: string;
    readonly agexPrimerOverride?: string;
    readonly capabilitiesPrimer?: string;
    readonly chapteringTrigger?: number | undefined;
    readonly chapterPrimer?: string;
    readonly maxIterations?: number;
}
/** Async factory — handles the awaitable parts of state setup. */
declare function createAgent(opts: AgentOptions): Promise<Agent>;
/** Options accepted by `agent.fn()`. The function is the first
 *  positional arg; everything below is metadata. `name` defaults to
 *  the function's `.name` property — supply explicitly when
 *  registering an arrow / anonymous / bound function (whose `.name`
 *  is empty or non-identifier-shaped). */
interface FnRegistration {
    readonly name?: string;
    readonly description?: string;
    readonly hostFsAccess?: boolean;
    readonly networkAccess?: boolean;
    readonly paramsSchema?: _standard_schema_spec.StandardSchemaV1;
    /** When true, the framework appends a `HostFnContext` (`{ console,
     *  signal }`) as the trailing positional argument to the handler.
     *  See `HostFnContext` in `agex-ts/types`. Host-bound only —
     *  combining with `url` is rejected at registration. */
    readonly wantsContext?: boolean;
}
/** Options accepted by `agent.cls()`. The class is the first
 *  positional arg; `name` defaults to `cls.name` (override for
 *  anonymous classes or when re-naming the agent-facing identifier). */
interface ClsRegistration {
    readonly name?: string;
    readonly description?: string;
    readonly constructable?: boolean;
    readonly include?: MemberFilter;
    readonly exclude?: MemberFilter;
    readonly configure?: Readonly<Record<string, MemberConfig>>;
    readonly hostFsAccess?: boolean;
    readonly networkAccess?: boolean;
}
/** Options accepted by `agent.namespace()`. The target object is
 *  the first positional arg; `name` is required because plain
 *  objects don't carry a useful name property. */
interface NsRegistration {
    readonly name: string;
    readonly description?: string;
    readonly recursive?: boolean;
    readonly include?: MemberFilter;
    readonly exclude?: MemberFilter;
    readonly configure?: Readonly<Record<string, MemberConfig>>;
    readonly hostFsAccess?: boolean;
    readonly networkAccess?: boolean;
}
/** Options accepted by `agent.terminal()`. The handler is the
 *  first positional arg; `name` and `description` are required
 *  (the agent surfaces these in the rendered tool list). */
interface TerminalRegistration {
    readonly name: string;
    readonly description: string;
    readonly hostFsAccess?: boolean;
    readonly networkAccess?: boolean;
}
/** Options accepted by `agent.skill()`. The markdown content is
 *  the first positional arg; `name` is required (it's the
 *  identifier the agent uses to look the skill up). */
interface SkillRegistration {
    readonly name: string;
}
/** URL-shipped registration spec — pass as the first positional
 *  arg to `agent.fn` / `.cls` / `.namespace` instead of a live JS
 *  reference. The runtime adapter (worker, Node) imports the
 *  module via dynamic `import(url)` and exposes `mod[export ??
 *  name]` to the agent under `name`.
 *
 *  Per-export visibility gating doesn't apply to URL-shipped
 *  registrations — the module ships into the agent's realm whole.
 *  Combining `include` / `exclude` / `configure` with this spec
 *  throws `RegistrationError` at registration time. */
interface UrlSpec {
    readonly url: string;
    /** Named export to pluck from the module. Defaults to the
     *  registration `name`; pass `'default'` for default exports. */
    readonly export?: string;
}
declare class Agent {
    #private;
    constructor(opts: AgentOptions, stateResolver: StateResolver);
    get name(): string;
    get maxIterations(): number;
    /** Stable identifier for the agent's current registration shape.
     *  Changes whenever a registration mutation lands. */
    get fingerprint(): string;
    /** The agent's primer prose, if any. Surfaced as part of the
     *  system prompt during task runs. */
    get primer(): string | undefined;
    /** The configured LLM driver, if any. Tasks throw at call time
     *  if this isn't set. */
    get llm(): LLMClient | undefined;
    /** The configured runtime, if any. Tasks throw at call time if
     *  this isn't set. */
    get runtime(): RuntimeAdapter | undefined;
    /** The configured namespace resolver, if any. When set, the runtime
     *  routes unregistered import specifiers through this function. */
    get namespaceResolver(): NamespaceResolver | undefined;
    /** The token threshold above which chaptering fires (if a chapter
     *  task is registered). Undefined disables chaptering. */
    get chapteringTrigger(): number | undefined;
    /** Override for the BUILTIN_PRIMER. Undefined uses the default. */
    get agexPrimerOverride(): string | undefined;
    /** Curated capabilities primer used in place of the auto-rendered
     *  registrations section. Undefined falls back to auto-rendering. */
    get capabilitiesPrimer(): string | undefined;
    /** Read-only snapshot of the registration policy. */
    policy(): Policy;
    fn(fn: ((...args: unknown[]) => unknown | Promise<unknown>) | UrlSpec, opts?: FnRegistration): this;
    cls(cls: (new (...args: unknown[]) => unknown) | UrlSpec, opts?: ClsRegistration): this;
    namespace(target: object | UrlSpec, opts: NsRegistration): this;
    skill(content: string, opts: SkillRegistration): this;
    terminal(handler: TerminalCommandHandler, opts: TerminalRegistration): this;
    /** Define a typed callable that drives the action loop. The
     *  returned function is awaitable: `const result = await task(input)`. */
    task<I, O>(def: TaskDefinition<I, O>): (input: I, options?: TaskCallOptions) => Promise<O>;
    /** Framework-internal accessor — the chaptering machinery looks
     *  up the auto-registered chapter task through here. Returns
     *  `undefined` when chaptering is disabled (i.e. `chapteringTrigger`
     *  was not set on this agent). Not part of the user-facing surface;
     *  embedders enable chaptering via `AgentOptions.chapteringTrigger`. */
    getChapterTask(): TaskFn<string, ReadonlyArray<Chapter>> | undefined;
    /** Manually trigger chaptering for `session`. Useful when an
     *  embedder wants explicit control over when compaction happens —
     *  e.g. a "compact now" UI button, scheduled compaction, or
     *  application-specific signals beyond the automatic
     *  `chapteringTrigger` threshold check.
     *
     *  Bypasses the threshold gate: chaptering runs whenever called,
     *  regardless of `chapteringTrigger`. Still respects the runtime
     *  guard — if there's nothing safe to fold (e.g. only one
     *  in-progress task, no completed predecessors and no prior
     *  chapters), the chapter task isn't invoked and `0` is returned.
     *
     *  Requires the chapter task to be registered (set
     *  `AgentOptions.chapteringTrigger` to enable; if you only want
     *  manual chaptering and never auto-fire, set it to a value high
     *  enough that the auto-trigger never trips).
     *
     *  Returns the number of `ChapterEvent`s applied to the session's
     *  log. `0` when chaptering is disabled, no chapter task is
     *  registered, or there's nothing foldable. */
    runChaptering(session?: string, opts?: {
        readonly signal?: AbortSignal;
        readonly onEvent?: (event: AgentEvent) => void | Promise<void>;
    }): Promise<number>;
    /** Per-session VFS. Same instance for the same session id; writes
     *  persist across calls within the agent's lifetime. */
    fs(session?: string): Promise<VirtualFileSystem>;
    /** Framework-internal: rebuild the `/skills/` overlay for `session`
     *  from the current registered skills. Called by the action loop
     *  on every task start so newly-registered skills become
     *  browseable. */
    refreshSkillsOverlay(session?: string): Promise<void>;
    /** Framework-internal: rebuild the `/chapters/` overlay for
     *  `session` from the current event log + state, so a chapter that
     *  just landed becomes browseable on the next read. The chaptering
     *  machinery calls this after `replaceRange`. */
    refreshChaptersOverlay(session?: string): Promise<void>;
    /** Per-session typed cache. */
    cache(session?: string): Promise<Cache>;
    /** Per-session event log. Same instance for the same session id.
     *
     *  Returns the concrete `EventLogImpl` rather than just the public
     *  `EventLog` interface, because framework-internal callers (the
     *  task lifecycle, chaptering machinery) need extra methods like
     *  `refs()` and `replaceRange()`. The public surface is the same;
     *  end-user code generally interacts via the `EventLog` interface. */
    events(session?: string): Promise<EventLogImpl>;
    /** The session's underlying StateBackend. Useful for inspection /
     *  manual commit / time travel via kvgit. Returns the raw backend
     *  so consumers can use the `isVersioned` predicate. */
    state(session?: string): Promise<StateBackend>;
    /** Flush pending writes for `session` if the backend is versioned.
     *  No-op for Live. */
    commit(session?: string, opts?: {
        info?: Readonly<Record<string, unknown>>;
    }): Promise<string | null>;
    /** Release runtime resources. Must be called when the agent is no
     *  longer needed — a worker-based `RuntimeAdapter` (the production
     *  default) holds onto a Worker / `worker_threads` instance that
     *  won't get GC'd otherwise. No-op if no runtime is configured.
     *
     *  After `dispose()`, calling `task()` will fail because the runtime
     *  is gone. Don't reuse the agent. */
    dispose(): Promise<void>;
    /**
     * Hot-swap the safe-to-mutate subset of `AgentOptions`. Useful for
     * embedders with a settings UI ("user changed model in the drawer")
     * where reconstructing the agent would orphan per-session state,
     * runtime resources, etc.
     *
     * Each provided field replaces its current value; omitted fields
     * stay as they were. Pass `undefined` to clear a value (e.g.
     * `chapteringTrigger: undefined` turns auto-chaptering off).
     *
     * Takes effect on the **next read**, which for most fields is the
     * next LLM call / next task boundary:
     * - `llm`: next turn uses the new client. In-flight HTTP requests
     *   continue with the old client; nothing mid-stream is touched.
     * - `primer` / `agexPrimerOverride` / `capabilitiesPrimer`: next
     *   task's system message reflects the change. Note that the LLM
     *   provider's prompt cache will invalidate when the system text
     *   changes.
     * - `chapteringTrigger`: takes effect at the next task-boundary
     *   chaptering check. Setting to `undefined` disables auto-fire.
     * - `chapterPrimer`: applied if/when the chapter task next runs.
     * - `maxIterations`: applied at the start of the next task.
     *
     * NOT included: `name`, `state`, `runtime`, `fs`. Mutating those
     * mid-session would orphan per-session resources or break
     * invariants the substrate depends on. If you need to change them,
     * `dispose()` and `createAgent({...})` again.
     */
    reconfigure(opts: ReconfigurableOptions): void;
    /** Commit metadata at `hash` (or current HEAD if omitted) for
     *  `session`. Null on non-versioned state or if the commit doesn't
     *  exist. */
    commitInfo(hash?: string, session?: string): Promise<CommitInfo | null>;
    /** Walk `session`'s commit hashes backward through the history.
     *  Yields nothing on non-versioned state. */
    history(hash?: string, opts?: {
        allParents?: boolean;
        session?: string;
    }): AsyncIterable<string>;
    /** Read `session`'s events as they were at a historical commit.
     *  Returns `null` if the backend isn't versioned or the commit
     *  doesn't exist. */
    eventsAt(commitHash: string, session?: string): Promise<EventLog | null>;
    /** Test-shaped check that a member name passes the include/exclude
     *  filter pair. Exposed for adapters that need to mirror the agent's
     *  filter rules. */
    static memberAllowed: typeof memberAllowed;
}

/**
 * Chaptering — context compaction triggered by token budget.
 *
 * Mechanism (mirrors agex-py):
 *   - The user registers a chapter task via `agent.chapterTask({...})`.
 *     It's a normal task that runs through the action loop, sees
 *     registered fns/namespaces, and uses the agent's LLM. Contract:
 *     input is a numbered task index (string); output is `Chapter[]`
 *     where each chapter has 1-based inclusive `start`/`end`
 *     positions into that index.
 *   - After each `ActionEvent`, the parent task's loop calls
 *     `shouldTriggerChaptering`. If it trips and a chapter task is
 *     registered, `runChaptering` builds the index, invokes the
 *     chapter task **in the parent's session** (so the chapter task's
 *     LLM sees the parent's full conversation history rendered as
 *     turns), and for each returned `Chapter`:
 *       1. Translates `start`/`end` boundary positions to a contiguous
 *          slice of state keys.
 *       2. Calls `EventLogImpl.replaceRange(refs, chapterEvent)`,
 *          which writes the chapter event and rewrites the log's
 *          index — the chaptered range is removed and the chapter
 *          ref is spliced in. The originals stay at their state keys
 *          but leave the active log.
 *   - Recursion guard: chaptering doesn't re-fire while the chapter
 *     task itself is executing. Tracked via a `WeakSet<Agent>`.
 *
 * **Why same session, not a child:** the chapter task running in the
 * parent's session means its loop renders the parent's full event log
 * as conversation history when it calls the LLM. The agent reflects on
 * its *own* work with full context visible — actual code, results,
 * outputs, errors — not a skeletal summary string. The numbered index
 * passed as input is just a navigational aid that tells the LLM how
 * positions map to ranges. Without same-session, chaptering quality
 * collapses to "summarise from a log skeleton."
 *
 * **Boundaries, not events:** the chapter task picks ranges over
 * *boundaries* (TaskStartEvent ∪ ChapterEvent), not raw events. Each
 * boundary owns the events from itself up to (but not including) the
 * next boundary — so a TaskStartEvent boundary is "this whole task"
 * and a ChapterEvent boundary is "this folded summary." Picking a
 * range that spans both kinds is nested chaptering: the new
 * ChapterEvent's `eventRefs` includes the inner ChapterEvent's storage
 * key, and walking down resolves to the original raw events.
 *
 * **Filtering:** the chapter task's own bookkeeping events
 * (`taskStart` with `taskName === '__chapter__'` and its closing
 * outcome) are filtered from both the LLM render path (Filter A in
 * `renderEvents`) and the chaptering index builder (Filter B here).
 * They stay in the log for UI / undo. This avoids the summary text
 * being duplicated (once in the ChapterEvent, again in the chapter
 * task's emitted code) and keeps future chapter tasks from seeing
 * prior chaptering work as enumerable entries.
 */

/** True when the latest `ActionEvent.inputTokens` is at or above
 *  `threshold`. Returns false if no threshold is configured, or if
 *  no ActionEvent has been logged yet, or if its `inputTokens` is
 *  unset (provider didn't report).
 *
 *  `lastFiredActionTimestamp` gates against the **stale-trigger
 *  loop**: after chaptering folds a range, the most recent
 *  ActionEvent's `inputTokens` still reflects the pre-fold context
 *  size (the provider measured it then; we don't re-estimate). If
 *  another task boundary fires before a fresh LLM call lands —
 *  e.g. a parent task that emits `taskSuccess(subTask())` so its
 *  most-recent action was measured before subTask's chaptering ran
 *  — the trigger would fire again on the same stale measurement
 *  and waste an LLM call on a redundant chapter task.
 *
 *  When `lastFiredActionTimestamp` matches the latest ActionEvent's
 *  timestamp, we treat that measurement as already-consumed and
 *  return false. The next genuine LLM call produces a new
 *  ActionEvent (different timestamp), the gate clears, and the
 *  trigger can fire again if the new measurement is still over
 *  threshold. */
declare function shouldTriggerChaptering(events: ReadonlyArray<AgentEvent>, threshold: number | undefined, lastFiredActionTimestamp?: string): boolean;

/**
 * Drop-in console formatters for `TaskCallOptions.onToken` and
 * `TaskCallOptions.onEvent`, mirroring agex-py's `pprint_tokens` and
 * `pprint_events`.
 *
 *   - `prettyTokens` — stateless callback that streams a
 *     `TokenChunk` (per-character flow as the model writes). Use
 *     when you want a fire-and-forget streaming view and don't
 *     mind the occasional repeated label on `filePath` /
 *     `fileSearch` if a value spans multiple chunks.
 *   - `createPrettyTokens()` — factory returning a stateful
 *     callback that buffers single-line fields (`title` /
 *     `filePath` / `fileSearch`) so labels emit once per emission
 *     even when content streams in many chunks. Better default
 *     for production console output.
 *   - `prettyEvents` — formats a discrete `AgentEvent` (one section
 *     per action / output / outcome). Use when you want a chunkier
 *     after-the-fact log instead of streaming.
 *
 * Pass either directly to the corresponding callback. For UIs that
 * want different formatting (HTML, color, etc.) write your own
 * against the same `TokenChunk` / `AgentEvent` shapes.
 */

interface PrettyOptions {
    /** Where to write. Defaults to `console.log` (no buffering). When
     *  set, individual chunks are appended without a trailing newline
     *  so streaming reads as one continuous flow. */
    readonly write?: (s: string) => void;
}
/** Stream a single `TokenChunk` to the configured writer.
 *
 *  Prefixes:
 *    - `toolStart` → `\n[<toolName>]\n` so the next chunk burst is
 *      visually attached to the tool that's emitting it.
 *    - `title` → `\n# title: <content>` (one-line label).
 *    - `thinking` → content streamed inline (model's reasoning).
 *    - `text` → content streamed inline (model-facing prose).
 *    - `ts` / `terminal` → content streamed inline (code / commands).
 *    - `filePath` / `fileSearch` / `fileContent` → labeled, inline.
 *    - `emission` → trailing newline so the next emission starts
 *      cleanly.
 *    - `signature` → skipped (opaque binary). */
declare function prettyTokens(token: TokenChunk, opts?: PrettyOptions): void;
interface PrettyEventOptions {
    /** Per-line writer. Defaults to `console.log` (each call emits its
     *  own newline). Set this if you want to capture or redirect. */
    readonly write?: (line: string) => void;
    /** Cap the per-emission code/text body at N chars when printing.
     *  Set to `Infinity` for no cap. Defaults to `2_000`. */
    readonly maxBody?: number;
}
/** Pretty-print a single `AgentEvent` as a compact block. Drop in as
 *  `onEvent`. Each event writes one or more lines via the configured
 *  writer (default: `console.log`). */
declare function prettyEvents(event: AgentEvent, opts?: PrettyEventOptions): void;

export { Agent, AgentEvent, type AgentOptions, Cache, Chapter, ChapterEvent, type ClsRegistration, EventLog, FSConfig, type FnRegistration, LLMClient, MemberConfig, MemberFilter, NamespaceResolver, type NsRegistration, Policy, RuntimeAdapter, StateConfig, TaskCallOptions, TaskDefinition, TaskFn, TerminalCommandHandler, type TerminalRegistration, TokenChunk, VirtualFileSystem, createAgent, prettyEvents, prettyTokens, shouldTriggerChaptering };
