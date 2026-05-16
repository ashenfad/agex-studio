import { StandardSchemaV1 } from '@standard-schema/spec';
import { FileSystem } from 'termish-ts';
import './errors.js';

/**
 * Builtin primer — the agex-ts equivalent of agex-py's BUILTIN_PRIMER.
 *
 * Explains the agent's environment and capabilities. Wire-format
 * neutral: the concrete tool-call syntax is supplied by the
 * provider package's own primer addendum (Anthropic's tool_use
 * blocks, OpenAI's tool calls, etc.). This primer teaches the
 * *concepts* — when to use each operation, their semantics, and
 * the rules that apply.
 *
 * Adapted from the Python version with the bits that don't carry:
 *   - python_action → ts_action
 *   - pickle / Pydantic semantics → structured-clone semantics
 *   - importlib.reload caveats → ESM module reload notes
 *   - Python-specific best practices reframed for TS
 *
 * Override at agent-construction with `agexPrimerOverride` if
 * you need different framing for a specific use case.
 */
declare const BUILTIN_PRIMER = "# Agex Agent Environment\n\nYou are a ReAct-style agent operating in a sandboxed TypeScript environment with two action surfaces: a **TypeScript action** where computation lives, and a **per-command shell** for filesystem operations and host-registered tools.  You think in code; reach for whichever surface fits the operation.\n\n## Core Philosophy\n\n- **Code is action.** You solve problems by writing and running code, not by dispatching narrow tools for each sub-step.  Import libraries and call host-registered functions directly from your `ts_action`.\n- **Each TypeScript action is a fresh script.** Variables, imports, and definitions don't carry from one `ts_action` to the next.  To preserve work across actions, write to the filesystem \u2014 helpers under `/helpers/`, working data under a scratch path.\n\n## Capabilities\n\n### TypeScript (`ts_action`)\n\nThe computation surface.  Each `ts_action` runs as a fresh script \u2014 variables you assign, functions you define, and modules you import are gone the moment the action returns.  To carry data between actions, write to the filesystem; to carry code, put it under `/helpers/` and import.  Within a single action, write a complete program: load \u2192 compute \u2192 log or `taskSuccess`.\n\n`async`/`await` is supported at the top level \u2014 most host-registered methods will be async, especially anything proxying back to the host (database calls, fs operations, etc.).  Top-level `await` is fine; you don't need an IIFE.\n\n**Always `await` async calls** (or prefix with `void` if you intentionally want fire-and-forget).  This matches standard JS/TS practice \u2014 `@typescript-eslint/no-floating-promises` flags exactly this in normal codebases.  Concretely: if you write `async function generateReport() { ... taskSuccess(...) }` and then call `generateReport()` without `await`, `ts_action` returns BEFORE `generateReport` finishes \u2014 the terminator fires too late, the action produces no observable outcome, and the runtime surfaces a `MissingAwaitError` to nudge you toward the fix.  Always write `await generateReport()` (or, when you really mean to discard the Promise on purpose, `void generateReport()`).\n\n**TypeScript syntax**: type annotations, interfaces, type aliases, generics, and `as` casts are all supported and erased before execution.  A few TS features that aren't pure type-erasure are NOT supported and will throw a syntax error: `enum` (use `const X = { A: 'a' } as const` instead), `namespace` (use modules / imports), parameter properties (`constructor(private x: number)` \u2014 declare and assign instead), and decorators.  Modern TS style avoids all of these, so this rarely bites in practice.\n\n**Registered resources \u2014 use `import` to reach them.**  Functions, classes, and namespaces listed in the **Registered Resources** section below are reached via natural `import` syntax: `import * as math from 'math'`, `import { Vec } from 'Vec'`.  The specifier is matched against the names listed under **Registered Resources**.  Most registrations also live in scope as bare globals (so `new Vec(1, 2)` works without an import), but writing the import is portable and the only way to reach modules that are loaded on demand \u2014 some registered libraries fetch on first use, and the import statement triggers that load (the rewriter handles the `await` for you, no special syntax needed on your end).  Code *you* write under `/helpers/` likewise gets imported via `import { ... } from '/helpers/foo'` (see \"Importing your code\" below).  Static `import` from anything else (npm packages, arbitrary URLs, the host's own modules) won't resolve and will throw.\n\n**Always emit `title` as the first field in your tool call**, before `code` (or `commands` for terminal).  The title is a one-line summary of what this action *does* (not what you'll observe afterward) \u2014 committing to it first leads to tighter, more focused code, and the host can stream the title to the user before the body arrives.  Do this even when the conversation history shows you doing it a different way; consistency matters.\n\nTask terminators (`taskSuccess`, `taskFail`) are only available here \u2014 not in scripts run via the shell.\n\n### Terminal (`terminal_action`)\n\nThe per-invocation shell surface.  Each command runs in isolation \u2014 like `ts_action`, no state carries between calls.  Filesystem operations and any commands the host has registered work on **your own workspace** (the VFS); nothing here is shared with the user's local machine, and there's no remote \u2014 version control, if available, is your own over your scratch space.\n\nReach for the terminal when:\n\n- Inventorying or searching the workspace (`ls`, `find`, `grep`).\n- Running tools the host has registered \u2014 try `<command> --help` to see options.\n- Reading documentation (`cat /skills/<name>/SKILL.md`) or chaptered work (`cat /chapters/<slug>/summary.md`).\n\nIf you develop in helpers, finish the task by importing the result back into `ts_action`: `import { solve } from '/helpers/compute'; taskSuccess(solve(inputs))`.\n\n### Filesystem\n\nA Virtual Filesystem is your durable workspace.  TypeScript actions and shell commands are stateless on their own, but anything you've written to the VFS persists across actions, turns, and tasks.  Two operations write to it \u2014 your response format's primer shows the concrete syntax.\n\n**Write / Append** \u2014 create a new file with given content, or append to the end of an existing one.  Use for brand-new files or extending the end.\n\n**Edit (search + replace)** \u2014 modify a specific region of an existing file.  Every edit specifies a `search` string locating the region and a `content` string with the new content.\n\n- `search` must match the file exactly, including whitespace and indentation.\n- By default `search` must occur exactly once.  Use the `matchAll` option to apply to every occurrence.\n- To insert content around an existing anchor, include the anchor itself in `content` (e.g. search for `function foo() {` and replace with `function foo() {\\n  // new line`).\n- For purely additive content, prefer `append` over `edit` \u2014 append can't miss a search target that was never there.\n\n**Importing your code** \u2014 files you write under `/helpers/` (e.g. `/helpers/utils.ts`) can be imported as `import { ... } from '/helpers/utils'`.  Always use **absolute** VFS paths (`/helpers/...`) when importing from `ts_action` \u2014 the script has no meaningful current directory, so relative specifiers like `./utils` resolve against the VFS root and won't find your helper.  Helpers themselves *can* import each other with relative paths (`./other` resolves relative to the importing helper's directory).  Helpers are the canonical way to carry code across actions and tasks: write reusable functions there, import them in any future action.\n\n### Cache (`cache`)\n\nA persistent typed key-value store scoped to your agent session \u2014 survives across actions and tasks, isolated per session.  Use it for plain data you want to remember without round-tripping through the filesystem.\n\n- `await cache.set('rows', parsedRows)` \u2014 store\n- `await cache.get('rows')` \u2014 retrieve, returns `undefined` if absent\n- `await cache.delete('rows')` \u2014 forget\n- `await cache.keys()` \u2014 see what's there\n\n**Cache only what survives a round-trip.**  Cache values cross between the worker and the host on every read/write, which means they pass through `structuredClone` (or JSON when state is persisted), so methods and class identity are stripped.  Plain data \u2014 objects, arrays, strings, numbers, `Date`, `Map`, `Set`, `Uint8Array` \u2014 survives intact.  Class instances do not: a cached Arquero table comes back as a bag of properties with no `.filter()` / `.rollup()` / `.toCSV()`, a cached DuckDB connection comes back useless, a fitted model loses its `.predict()`.  Convert to a portable shape on set and rebuild on get \u2014 e.g. `cache.set('t', table.toCSV())` paired with `arquero.fromCSV(await cache.get('t'))`, or `cache.set('rows', table.objects())` for an array of plain rows.  References stay live within a single action (no boundary crossing), but assume every other turn pays a round-trip.  For files (text, binaries, generated artifacts), prefer the VFS \u2014 cache is for small in-memory data.\n\n### Image inspection\n\n`console.log` accepts image-shaped values and renders them inline so you can inspect them on the next turn.  Three shapes are recognized:\n\n- `{ format: 'png' | 'jpeg' | 'webp', data: <base64 string> }`\n- A `data:image/(png|jpeg|webp);base64,...` string\n- A `Uint8Array` whose first ~12 bytes match a PNG / JPEG / WebP magic\n\nMixed args render in order: `console.log('shot:', bytes)` produces a text part followed by an image part.  If you want to *inspect* raw bytes (hex, length, etc.) without the image-render path firing, slice or stringify them first \u2014 `console.log(bytes.byteLength)` or `console.log(Array.from(bytes.slice(0, 16)))` won't be misrouted.\n\n### Chapters\n\nYour context may contain \uD83D\uDCD6 **Chapter** events \u2014 summaries of earlier work.  The originals are preserved at the `/chapters/<slug>/` path shown in each chapter; use `ls` / `cat` from `terminal_action` if you need specifics beyond the summary.\n\n### Skills\n\nIf you have skills available (listed near the top of this primer), each one lives at `/skills/<name>/SKILL.md`.  Skills carry project-specific knowledge \u2014 API conventions, data shapes, hard-won facts about the host environment.  When a task seems related to a skill's subject, **read the skill's full content with `cat /skills/<name>/SKILL.md` from `terminal_action` before guessing** \u2014 guessed signatures and field names cost a turn each.\n\n## Task Control\n\nYour `ts_action` returning normally means \"keep going\" \u2014 `console.log` output (text or image \u2014 see *Image inspection* above) and any expression result render back to you at the start of the next turn.  Use a terminator only when you want to signal a definitive outcome:\n\n- **`taskSuccess(result)`** \u2014 task complete; `result` is returned to the caller.\n- **`taskFail(message)`** \u2014 task is impossible (technical impossibility, security violation, unrecoverable infrastructure error). The caller decides what to do next; you're done.\n\nAny terminator ends the current task.  **Prints in the same action as a terminator are wasted from your perspective** \u2014 the task ends before any next turn, so there's no opportunity to read them.  Print only when you intend to keep going (so you can inspect what happened); skip the prints in the action that finishes the task.  Your event log and filesystem persist \u2014 and on a resubmitted task you'll see your prior work in your history \u2014 but TypeScript actions are stateless to begin with, so there's no live REPL state to lose.  The only thing to be deliberate about is making sure anything future-you will need is on disk: helpers under `/helpers/`, working data under a scratch path.\n\n`taskFail` is **not** for code bugs.  If your code throws an exception, let it surface \u2014 you'll see the stack trace on the next turn and can fix it.  Wrapping code in `try/catch` and calling `taskFail()` hides bugs from yourself and ships raw stack traces to the caller.\n\n## Inputs\n\nThe task input is available as the `inputs` variable in `ts_action`.  Its shape is described in the per-task instructions (the user message that initiated the task).  Don't reach for a JSON parse of the prompt \u2014 the values are already deserialized objects ready to use.\n\n`inputs` is bound only inside `ts_action` itself.  Helpers under `/helpers/` are regular modules \u2014 they don't inherit `ts_action`'s ambient bindings (`inputs`, `taskSuccess`, `fs`, `cache`, `console`).  Pass what they need as parameters: `import { solve } from '/helpers/compute'; taskSuccess(solve(inputs))`.\n\n## Best Practices\n\n1. **Inspect data before assuming structure.** Check `Object.keys(data)`, `Array.isArray(x)`, etc. before indexing. Saves a turn of \"TypeError\" on data you haven't really looked at.\n2. **Modularize complex logic.** Write a file under `/helpers/` for non-trivial code, then import it. Keeps `ts_action` bodies readable, and is the only way to carry code across actions \u2014 TypeScript definitions don't survive between actions.\n3. **Externalize as you go.** Anything you'll want in a later action must leave the current namespace before the action returns: in-memory data goes in `cache`, reusable code in `/helpers/`, working files under `/scratch/` or similar.  TypeScript state is discarded after each action.\n4. **Verify testable results before completing.** When your task returns something testable (a function, parser, or other reusable artifact), assert against known cases in the same `ts_action` as `taskSuccess`. If a check fails, the error surfaces next turn so you can fix it; if it passes, the task completes in one turn. Skip this for trivial answer-style tasks where the answer *is* the work.\n5. **Let errors surface.** Do not wrap code in broad `try/catch` that calls `taskFail`. Stack traces are debugging information, not failure modes.\n";

/**
 * Best-effort JSON Schema extraction from a Standard Schema.
 *
 * Standard Schema 1.0 deliberately doesn't standardize shape
 * introspection across validators — only `validate` + phantom
 * type slots. But each major validator exposes its own way to
 * derive a JSON Schema:
 *
 *   - zod 3.25+: `schema.toJSONSchema()` per schema
 *   - arktype: `schema.json` property
 *   - valibot: needs `@valibot/to-json-schema` (we don't auto-pull
 *     it; users supply `inputJsonSchema` / `outputJsonSchema` if
 *     they need valibot)
 *
 * This helper sniffs the most common method names and returns
 * whatever it gets. If nothing matches, returns `null` and the
 * renderer falls back to the user's `inputDescription` /
 * `outputDescription` prose, or the generic "any value matching
 * the task description" fallback.
 *
 * Users with bespoke validators or who want strict control over
 * what the agent sees can supply `inputJsonSchema` /
 * `outputJsonSchema` overrides on `TaskDefinition` — those win
 * over auto-extraction.
 */

/** Try to derive a JSON Schema-shaped object from a Standard Schema.
 *  Returns `null` if no recognized introspection method is exposed. */
declare function extractJsonSchema(schema: StandardSchemaV1): object | null;
/** True if `schema` looks like a JSON Schema describing an object
 *  with discoverable top-level properties. Used by the task message
 *  builder to decide between per-field rendering (one line per
 *  field) and the single-blob fallback. */
declare function hasObjectProperties(jsonSchema: object | null): boolean;
/** Pull the top-level property names from an object-shaped JSON Schema.
 *  Returns `[]` if the schema doesn't describe an object. */
declare function objectPropertyNames(jsonSchema: object | null): string[];

/**
 * Render the agent's registration table as markdown for the system
 * prompt. Each kind gets its own section; entries with descriptions
 * lead with their description (the prominence-by-presence rule).
 *
 * For namespaces and classes, we list visible members so the agent
 * doesn't have to discover them by trial and error. Member visibility
 * uses the same `include`/`exclude` filter pair the runtime adapter
 * applies — what's listed here is what the agent will actually be
 * able to call.
 *
 * Members without an explicit `configure[name].description` are listed
 * by name only. With one, the description is appended.
 */

/** Build the "Registered Resources" section of the system prompt. */
declare function renderRegistrations(policy: Policy): string;

/**
 * `buildSystemMessage(agent)` — composes the agent's system prompt
 * from the four standard parts, in cache-friendly order:
 *
 *   1. BUILTIN_PRIMER (or `agent.agexPrimerOverride`) — agex
 *      conventions, identical across every task for every agent
 *      that doesn't override
 *   2. Capabilities or Registered Resources — `capabilitiesPrimer`
 *      if set (curated control), otherwise auto-rendered from the
 *      policy table
 *   3. Skills listing — names + first-line descriptions of
 *      registered skills (full content lives in `/skills/<name>/SKILL.md`)
 *   4. `agent.primer` — the agent's own per-instance voice
 *
 * Stable parts top-loaded so provider packages can place a cache
 * marker after part 4: everything in the system message is
 * cacheable, and reading it costs zero new tokens on subsequent
 * turns of the same task — or even subsequent tasks against the
 * same agent shape.
 */

interface SystemMessageInputs {
    /** The full registration table. Only the description-bearing
     *  entries get rendered into the prompt. */
    readonly policy: Policy;
    /** When set, replaces the BUILTIN_PRIMER entirely. Use only if
     *  you really mean to override agex's environment description. */
    readonly agexPrimerOverride?: string;
    /** When set, replaces the auto-rendered "Registered Resources"
     *  section with curated prose. Use when the auto-rendering
     *  doesn't fit your agent's UX (e.g. you want to organize tools
     *  thematically, or surface only some of them). */
    readonly capabilitiesPrimer?: string;
    /** The agent's per-instance voice. Appended last. */
    readonly agentPrimer?: string;
    /** Optional addendum the runtime adapter contributes (via
     *  `RuntimeAdapter.primerAddendum`). Inserted just after the
     *  built-in primer so any environment-specific guidance the
     *  agent needs (e.g. workerRuntime's `routeFetchToVfs` enabling
     *  fetch-against-VFS) is read alongside the agex conventions. */
    readonly runtimeAddendum?: string;
}
declare function buildSystemMessage(inputs: SystemMessageInputs): string;

/**
 * Task lifecycle — `agent.task({ description, input?, output? })`
 * returns a typed callable that drives the action loop.
 *
 * Per turn:
 *   1. Build `LLMRequest` from system prompt + event log.
 *   2. Stream from `LLMClient.complete()`. Forward chunks to
 *      `onToken`. Assemble full `Emission`s from `done` boundaries.
 *   3. Append an `ActionEvent` carrying the ordered emissions (with
 *      provider signatures intact).
 *   4. Dispatch each emission. `ts` runs through `RuntimeAdapter`;
 *      richer dispatch (file ops, terminal) lands in the next commit.
 *   5. Resolve the task on `taskSuccess` / `taskFail`;
 *      otherwise loop until `maxIterations`.
 *
 * Cancellation: the host `AbortSignal` is threaded into both the
 * runtime and the LLM client; aborting writes a `CancelledEvent`
 * and rejects with `CancelledError`.
 */

interface TaskDefinition<I, O> {
    /** What this task does — surfaced in the per-task user message. */
    readonly description: string;
    /** Optional Standard Schema for input validation. The renderer
     *  also tries to extract a JSON Schema from this for shape
     *  presentation; supply `inputJsonSchema` to override. */
    readonly input?: StandardSchemaV1<I, I>;
    /** Optional Standard Schema for output validation. */
    readonly output?: StandardSchemaV1<O, O>;
    /** Optional override for the JSON Schema sent to the agent for
     *  inputs. Use when your validator's introspection isn't picked
     *  up automatically, or when you want a stripped-down shape. */
    readonly inputJsonSchema?: object;
    /** Optional override for the JSON Schema sent to the agent for
     *  the expected output. Same use cases as `inputJsonSchema`. */
    readonly outputJsonSchema?: object;
    /** Optional prose description of the input shape. Surfaced when
     *  no JSON Schema is available; useful for handwritten guidance
     *  beyond what schema introspection can express. */
    readonly inputDescription?: string;
    /** Optional prose description of the expected output. Same role
     *  as `inputDescription` but for the return value. */
    readonly outputDescription?: string;
    /** Optional task-specific addendum surfaced after the
     *  description in the per-task user message. */
    readonly primer?: string;
}

/**
 * `buildTaskMessage(def, input)` — composes the per-task user
 * message that opens the conversation.
 *
 * Structure mirrors agex-py's `build_task_message`:
 *
 *   Task: <description>
 *   <def.primer if set>
 *
 *   Details for your task are available in the `inputs` variable.
 *   Here is its structure and content:
 *   ```
 *   inputs.field1 = <value>
 *   inputs.field2 = <value>
 *   ```
 *
 *   Access these values with patterns like `inputs.field1`.
 *
 *   When complete, call `taskSuccess(result)` with your result.
 *   The result type should be:
 *   ```json
 *   <JSON Schema or prose>
 *   ```
 *
 * Per-field input rendering only happens when we have a JSON Schema
 * for the input that describes an object with discoverable
 * properties. Without one, falls back to a single-blob
 * `inputs = <safeStringify>` line.
 *
 * Output rendering preference, in order: `outputJsonSchema`
 * override → `extractJsonSchema(output)` → `outputDescription`
 * prose → generic fallback.
 */

declare function buildTaskMessage<I, O>(def: TaskDefinition<I, O>, inputValue: I): string;

/**
 * Provider-agnostic JSON schemas for the four action tools the agent
 * may call: `ts_action`, `terminal_action`, `write_file`, `edit_file`.
 *
 * Each schema is a plain dict — `{ name, description, parameters }`.
 * Provider packages translate the envelope:
 *
 *   - Anthropic renames `parameters` → `input_schema`, no wrapper.
 *   - OpenAI wraps in `{ type: 'function', function: { ... } }`.
 *   - Gemini puts `parameters` directly under `function_declarations`.
 *
 * The schema *bodies* are identical across providers — only the
 * outer shape differs. Keeping them in one place avoids three copies
 * of the same JSON drifting apart.
 *
 * `toolSchemas({ nativeThinking: true })` strips the `thinking`
 * narration parameter from action tools — appropriate when the
 * provider delivers native thinking blocks (Claude 4+ extended
 * thinking, Gemini 3 thought parts), so asking the model to also
 * fill a `thinking` argument is redundant and confuses the model
 * into half-completing the schema instead of running real code.
 */

declare const TOOL_TS: "ts_action";
declare const TOOL_TERMINAL: "terminal_action";
declare const TOOL_WRITE_FILE: "write_file";
declare const TOOL_EDIT_FILE: "edit_file";
interface ToolSchema {
    readonly name: ToolName;
    readonly description: string;
    readonly parameters: Readonly<Record<string, unknown>>;
}
interface ToolSchemaOptions {
    /** Strip the `thinking` narration parameter from action tool
     *  schemas. Appropriate when the provider supplies native thinking
     *  blocks; the model then emits real reasoning as a separate
     *  thought channel rather than as a JSON string. */
    readonly nativeThinking?: boolean;
}
/** Return the four action tool schemas. Pass `nativeThinking: true`
 *  on providers that deliver native thinking blocks (Claude 4+,
 *  Gemini 3) so the action tools don't ask the model to also
 *  narrate reasoning into a JSON parameter. */
declare function toolSchemas(opts?: ToolSchemaOptions): ToolSchema[];

/**
 * Provider-agnostic rendering — the "what the agent sees" surface
 * shared across every provider package.
 *
 * Three pieces, each focused:
 *
 *   - `buildSystemMessage(inputs)` — composes the system prompt
 *     (BUILTIN_PRIMER + capabilities/registrations + skills listing
 *     + agent.primer)
 *   - `buildTaskMessage(def, inputValue)` — composes the per-task
 *     opening user message (description + inputs + expected return)
 *   - `renderEvents(events)` — composes the conversation turns from
 *     the event log (ActionEvent → assistant tool_use, OutputEvent →
 *     user tool_result, ChapterEvent → assistant text with the
 *     `/chapters/<slug>/` path hint)
 *
 * Provider packages (`@agex-ts/anthropic` etc.) take the
 * `NeutralTurn[]` from `renderEvents` plus the system + task
 * messages and lower them into their wire format (Anthropic content
 * blocks, OpenAI tool messages, Gemini parts arrays).
 *
 * Tool-use IDs are derived deterministically from the source
 * ActionEvent's timestamp + emission index. Stability matters
 * because each new request re-renders the full history; the IDs in
 * the historical parts must match what the provider has seen
 * before. As long as the renderer is pure and the events don't
 * mutate, the IDs stay stable.
 */

type Role = 'user' | 'assistant';
/** The four "actions" the agent can emit. Each becomes a tool_use
 *  block in the provider's wire format. */
type ToolName = 'ts_action' | 'terminal_action' | 'write_file' | 'edit_file';
interface TextPart {
    readonly type: 'text';
    readonly text: string;
}
interface ImagePart {
    readonly type: 'image';
    readonly format: ImageFormat;
    /** Base64-encoded bytes. */
    readonly data: string;
    readonly altText?: string;
}
interface ThinkingPart {
    readonly type: 'thinking';
    readonly text: string;
    readonly redacted?: boolean;
    /** Provider-native opaque round-trip blob. MUST be passed back
     *  verbatim on the next request — providers reject mismatched
     *  signatures. */
    readonly signature?: Uint8Array;
}
interface ToolUsePart {
    readonly type: 'toolUse';
    readonly toolUseId: string;
    readonly toolName: ToolName;
    readonly input: Readonly<Record<string, unknown>>;
    readonly signature?: Uint8Array;
}
interface ToolResultPart {
    readonly type: 'toolResult';
    readonly toolUseId: string;
    readonly content: ReadonlyArray<TextPart | ImagePart>;
    readonly isError?: boolean;
}
type NeutralPart = TextPart | ImagePart | ThinkingPart | ToolUsePart | ToolResultPart;
interface NeutralTurn {
    readonly role: Role;
    readonly content: ReadonlyArray<NeutralPart>;
}
/** Render a sequence of events as a neutral conversation. The
 *  returned turns are ordered chronologically. Skipped events:
 *
 *    - `error` / `systemNote` — framework metadata, not conversation
 *    - `file` with `source: 'agent'` — already covered by the
 *      per-emission tool_result for `fileWrite` / `fileEdit`
 *
 * `file` with `source: 'user'` is surfaced as a `[System reminder]`
 * line in the next user turn so the agent notices files the
 * embedder dropped into the VFS mid-session.
 *
 * Rendered events:
 *
 *    - `TaskStartEvent` becomes a user turn with the stored task
 *      message (the message stamped at task launch by
 *      `buildTaskMessage`). For multi-task sessions, this places
 *      each task's opening prompt at its actual position in the
 *      timeline, not floating at the front of the request.
 *    - `ActionEvent` becomes one assistant turn. Tool-call
 *      emissions (`ts` / `terminal` / `fileWrite` / `fileEdit`)
 *      become `tool_use` parts. `text` / `thinking` become
 *      text / thinking parts inline in the same assistant turn.
 *    - `OutputEvent`s following the action are routed by their
 *      `emissionId` back to the tool_use that produced them. All
 *      tool_results for one assistant turn collapse into a single
 *      user turn (Anthropic and OpenAI both reject split user
 *      turns of tool_results).
 *    - Every tool_use part gets *some* tool_result: real outputs
 *      when present, a synthesized "wrote /path" line for file
 *      emissions on success, or "(no observation)" for silent
 *      `ts` / `terminal` blocks.
 *    - `success` / `fail` / `cancelled` become brief
 *      assistant text turns ("[Task 'X' complete]" etc.) so the
 *      model sees prior tasks closing out before the next one
 *      opens. Without this, two consecutive task starts in the
 *      same session would look like the model went rogue mid-task.
 *    - `ChapterEvent` becomes its own assistant turn (with the
 *      `/chapters/<slug>/` hint) and forces a flush of any pending
 *      user content first.
 */
declare function renderEvents(events: ReadonlyArray<AgentEvent>): NeutralTurn[];
/** Render a single chapter event as the text the LLM will see in
 *  place of the originals. Includes the `/chapters/<slug>/` path
 *  hint so the agent can drill in via its VFS tools. */
declare function renderChapterText(event: ChapterEvent): string;
/** Render a user-source FileEvent as a bracketed system-reminder
 *  line for the next user turn. Returns `null` if the event carries
 *  no actual changes (all three lists empty), so the caller skips
 *  injecting an empty reminder. Format mirrors the no-action nudge
 *  bracket style so the model reads both as framework meta. */
declare function renderUserFileEventText(event: FileEvent): string | null;
/** Stable deterministic toolUseId for a given action position. The
 *  same (timestamp, index) pair always produces the same id, so the
 *  framework can re-render the history across turns without
 *  breaking provider-side validation. */
declare function makeToolUseId(actionTimestamp: string, emissionIndex: number): string;

/** The agent's host-side virtual filesystem — same protocol as the
 *  termish-ts `FileSystem`. Re-exported so consumers can implement it
 *  without depending on termish-ts directly. */
type VirtualFileSystem = FileSystem;
/**
 * Optional host-supplied resolver for unregistered import specifiers.
 *
 * When the agent's emitted code contains `import x from 'foo'` and
 * `'foo'` isn't in the registered namespace map, the runtime calls
 * the resolver. Returning a URL imports that module; returning `null`
 * (or throwing) denies the import — the agent sees a `Cannot find
 * module 'foo'` error on its next turn.
 *
 * The resolver may be sync or async; the worker's import-resolution
 * path awaits async returns naturally.
 *
 * Resolution priority: registered namespace → resolver → error.
 * A specifier matched by a registered namespace never reaches the
 * resolver.
 */
type NamespaceResolver = (specifier: string) => string | Promise<string | null> | null;
/** TypeScript code the agent wants to execute in the sandbox. */
interface TsEmission {
    readonly type: 'ts';
    readonly code: string;
    readonly thinking?: string;
    readonly title?: string;
    /** Provider-native opaque round-trip blob (Claude thinking blocks,
     *  Gemini `thought_signatures`). MUST be passed back verbatim on
     *  the next request — providers reject mismatched signatures. */
    readonly signature?: Uint8Array;
}
/** A shell pipeline the agent wants to run via termish-ts. */
interface TerminalEmission {
    readonly type: 'terminal';
    readonly commands: string;
    readonly thinking?: string;
    readonly title?: string;
    readonly signature?: Uint8Array;
}
/** Replace or create a file in the agent's VFS. */
interface FileWriteEmission {
    readonly type: 'fileWrite';
    readonly path: string;
    readonly content: string;
    readonly mode: 'write' | 'append';
    readonly signature?: Uint8Array;
}
/** Apply a search/replace edit against a file in the VFS. */
interface FileEditEmission {
    readonly type: 'fileEdit';
    readonly path: string;
    readonly search: string;
    readonly content: string;
    readonly matchAll?: boolean;
    readonly signature?: Uint8Array;
}
/** Free-text observation from the agent. No side effect; logged. */
interface TextEmission {
    readonly type: 'text';
    readonly text: string;
    readonly signature?: Uint8Array;
}
/** Reasoning/thinking output the agent wants to surface. No side
 *  effect; logged. May be `redacted` (provider stripped the content
 *  but kept the slot — must be preserved for cache integrity). */
interface ThinkingEmission {
    readonly type: 'thinking';
    readonly text: string;
    readonly redacted?: boolean;
    readonly signature?: Uint8Array;
}
/** Discriminated union of every emission variant. Order is
 *  load-bearing for prompt caching — providers validate that the
 *  next request echoes the same sequence (and signatures) verbatim. */
type Emission = TsEmission | TerminalEmission | FileWriteEmission | FileEditEmission | TextEmission | ThinkingEmission;
type TokenChunkType = 'title' | 'thinking' | 'text' | 'ts' | 'terminal' | 'filePath' | 'fileSearch' | 'fileContent' | 'emission' | 'signature' | 'toolStart';
/** A single chunk of a streaming LLM response. The agent loop
 *  forwards these to `onToken` callbacks in real time and assembles
 *  full `Emission`s from `type: 'emission'` deltas. */
interface TokenChunk {
    readonly type: TokenChunkType;
    readonly content: string;
    readonly done: boolean;
    /** Index of the emission this chunk contributes to (zero-based). */
    readonly emissionIndex: number;
    /** Present on `done` boundaries — the fully assembled emission. */
    readonly emission?: Emission;
    readonly signature?: Uint8Array;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
}
/** Fields shared by every event in the log. */
interface EventBase {
    /** ISO 8601 UTC timestamp. */
    readonly timestamp: string;
    /** Name of the agent that produced this event. */
    readonly agentName: string;
    /** kvgit commit hash this event was committed under, if any. */
    readonly commitHash?: string;
    /** State key of the parent event in the same task lineage. Lets
     *  callers walk back through `state.events()` for a single task. */
    readonly parentRef?: string;
    /** Optional token estimates for context-budget accounting. */
    readonly inputTokens?: number;
    readonly outputTokens?: number;
}
interface TaskStartEvent extends EventBase {
    readonly type: 'taskStart';
    readonly taskName: string;
    readonly inputs: unknown;
    readonly message?: string;
}
interface ActionEvent extends EventBase {
    readonly type: 'action';
    /** Ordered emission sequence from the LLM turn. Order and
     *  signatures are immutable from this moment on. */
    readonly emissions: ReadonlyArray<Emission>;
}
type ImageFormat = 'png' | 'jpeg' | 'webp';
/** Trailing-arg context passed to a registered host fn that opts in
 *  via `wantsContext: true` on its registration.
 *
 *  - `console`: routes through the same image-aware pipeline as agent
 *    code's `console.log`. Use this in browser-host embedders where
 *    ALS-based capture isn't available.
 *  - `signal`: fires when the agent task is cancelled. In the worker
 *    runtime this reflects the per-execute external signal only.
 *
 *  See `runtime/console-capture` for the implementation. */
interface HostFnContext {
    readonly console: Console;
    readonly signal: AbortSignal;
}
type OutputPart = {
    readonly type: 'text';
    readonly text: string;
} | {
    readonly type: 'image';
    readonly format: ImageFormat;
    /** Base64-encoded bytes. */
    readonly data: string;
    readonly altText?: string;
}
/** A runtime error raised by the agent's emitted code. The loop
 *  emits this part on the OutputEvent for the failing emission and
 *  continues with the next iteration so the agent can self-correct.
 *
 *  Distinct from `ErrorEvent`, which is reserved for framework-level
 *  errors not shown to the agent (worker death, runtime adapter
 *  crash, etc.). This variant is "code the agent wrote threw" — the
 *  agent should see it. */
 | {
    readonly type: 'error';
    readonly errorName: string;
    readonly errorMessage: string;
};
interface OutputEvent extends EventBase {
    readonly type: 'output';
    readonly parts: ReadonlyArray<OutputPart>;
    /** Stable id of the emission that produced these outputs. The
     *  renderer uses this to pair the OutputEvent back to the right
     *  `tool_use` block when composing turns for the next LLM call. */
    readonly emissionId?: string;
}
interface SuccessEvent extends EventBase {
    readonly type: 'success';
    readonly result: unknown;
}
interface FailEvent extends EventBase {
    readonly type: 'fail';
    readonly message: string;
}
interface CancelledEvent extends EventBase {
    readonly type: 'cancelled';
    readonly taskName: string;
    readonly iterationsCompleted: number;
}
interface ErrorEvent extends EventBase {
    readonly type: 'error';
    readonly errorName: string;
    readonly errorMessage: string;
    readonly recoverable: boolean;
}
interface FileEvent extends EventBase {
    readonly type: 'file';
    readonly source: 'user' | 'agent';
    readonly added: ReadonlyArray<string>;
    readonly modified: ReadonlyArray<string>;
    readonly removed: ReadonlyArray<string>;
}
interface SystemNoteEvent extends EventBase {
    readonly type: 'systemNote';
    readonly message: string;
}
/** Context-compaction marker. Replaces the chaptered event range in
 *  the active event log; the originals stay at their state keys
 *  (referenced via `eventRefs`) so they remain browseable through
 *  the `/chapters/<slug>/` VFS overlay. */
interface ChapterEvent extends EventBase {
    readonly type: 'chapter';
    readonly name: string;
    readonly message: string;
    /** Slug used as the path segment in the VFS overlay
     *  (`/chapters/<slug>/`). Stable across renders; computed once at
     *  chapter creation with collision-handling against existing
     *  chapters in the same log. */
    readonly slug: string;
    /** State keys of the events this chapter summarizes — read by the
     *  VFS overlay to materialize per-event markdown files. */
    readonly eventRefs: ReadonlyArray<string>;
}
type AgentEvent = TaskStartEvent | ActionEvent | OutputEvent | SuccessEvent | FailEvent | CancelledEvent | ErrorEvent | FileEvent | SystemNoteEvent | ChapterEvent;
/** Returned by the chapter task. `start` and `end` are 1-based,
 *  inclusive positions into the numbered event index the task
 *  receives — e.g. `{ start: 1, end: 3 }` covers the first three
 *  entries. The framework translates these positions to actual
 *  state keys when applying the chapter to the log. */
interface Chapter {
    readonly start: number;
    readonly end: number;
    readonly name: string;
    readonly message: string;
}
interface TaskCallOptions {
    /** Session identifier — isolates state (events, fs, cache). Default `"default"`. */
    readonly session?: string;
    /** Cancellation. The agent loop checks at iteration boundaries and
     *  threads the signal into `RuntimeAdapter.execute` and
     *  `LLMClient.complete`. */
    readonly signal?: AbortSignal;
    /** Fired for every event written to the log. */
    readonly onEvent?: (event: AgentEvent) => void | Promise<void>;
    /** Fired for every streaming token from the LLM. */
    readonly onToken?: (token: TokenChunk) => void | Promise<void>;
}
/** A task is a typed callable. The user-facing surface returned by
 *  `agent.task({ ... })`. */
type TaskFn<I, O> = (input: I, options?: TaskCallOptions) => Promise<O>;
/** What the runtime adapter returns from each `ts` emission. */
type TaskOutcome = {
    readonly kind: 'success';
    readonly value: unknown;
} | {
    readonly kind: 'fail';
    readonly message: string;
}
/** No terminal action — agent wants another turn. */
 | {
    readonly kind: 'continue';
};
interface ExecuteContext {
    readonly fs: VirtualFileSystem;
    readonly cache: Cache;
    readonly signal: AbortSignal;
    /** The validated task input, exposed to the agent code as the
     *  `inputs` variable. Stable across every emission of a single
     *  task call. `undefined` for tasks with no input. */
    readonly inputs?: unknown;
    /** Optional identifier for the source emission, for diagnostics. */
    readonly emissionId?: string;
}
interface ExecResult {
    readonly outcome: TaskOutcome;
    readonly outputs: ReadonlyArray<OutputPart>;
    /** Unexpected runtime errors (parse error, module not allowed,
     *  exceeded timeout, etc.). Task-control raises don't land here —
     *  they surface as `outcome`. */
    readonly error: Error | null;
    readonly elapsedMs: number;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
}
interface RuntimeInitOptions {
    readonly namespaceResolver?: NamespaceResolver;
}
interface RuntimeAdapter {
    /** One-time initialization. Called when the agent first runs a task.
     *  Receives the registration policy so the adapter can configure
     *  module resolution. The optional `namespaceResolver` is the
     *  agent's host-supplied callable for unregistered import
     *  specifiers; runtimes should route unrecognized names through it
     *  before erroring with `Cannot find module`. */
    init(policy: Policy, opts?: RuntimeInitOptions): Promise<void>;
    /** Run a single `ts` emission. */
    execute(code: string, ctx: ExecuteContext): Promise<ExecResult>;
    /** Release resources. Called when the agent is disposed. */
    dispose(): Promise<void>;
    /** Optional addendum the runtime contributes to the system primer.
     *  Returned text is appended to the built-in primer at task-message
     *  build time. Use when runtime configuration is worth surfacing to
     *  the agent — e.g. `workerRuntime`'s `routeFetchToVfs` enables
     *  `fetch('/path')` against the VFS, which the agent should know
     *  about. Return `undefined` when the runtime has nothing to add. */
    primerAddendum?(): string | undefined;
}
interface LLMRequest {
    /** Fully assembled system prompt: BUILTIN_PRIMER (or override),
     *  capabilities or registered resources, skills listing, the
     *  agent's own primer. Provider sends this as the system field
     *  of its API request. */
    readonly system: string;
    /** Conversation turns, pre-rendered into neutral parts by
     *  `agex-ts/render`. The first turn is always the per-task
     *  opening user message (description + inputs + expected return);
     *  subsequent turns come from `renderEvents()` over the event
     *  log. Provider lowers each part into its wire format
     *  (Anthropic content blocks, OpenAI tool messages, Gemini
     *  parts arrays). */
    readonly turns: ReadonlyArray<NeutralTurn>;
}
interface LLMResponse {
    readonly emissions: ReadonlyArray<Emission>;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
}
interface LLMConfig {
    readonly provider: string;
    readonly model: string;
    readonly timeoutSeconds: number;
    /** Provider-specific extras serialized for transport. */
    readonly extras?: Readonly<Record<string, unknown>>;
}
interface LLMClient {
    /** Streaming response. Yields `TokenChunk`s as the provider produces
     *  them. The agent loop forwards these to `onToken` and assembles
     *  full `Emission`s from `done` boundaries. */
    complete(request: LLMRequest, signal?: AbortSignal): AsyncIterable<TokenChunk>;
    /** Serialize for transport (e.g. when state-config carries the LLM
     *  shape across a worker boundary). */
    dumpConfig(): LLMConfig;
}
/** Common to every registration. Capability flags propagate to the
 *  runtime adapter; the runtime decides whether to allow the call. */
interface RegistrationCommon {
    /** Description-presence is the prominence lever. Items with a
     *  description appear in the agent's primer; without, they exist
     *  but aren't advertised. */
    readonly description?: string;
    /** True if the registered code may touch the host real filesystem.
     *  Default `false`. */
    readonly hostFsAccess?: boolean;
    /** True if the registered code may make network requests. Default `false`. */
    readonly networkAccess?: boolean;
}
/** A registered fn / cls / namespace can either be **host-bound**
 *  (the embedder hands us a live JS reference and the runtime
 *  bridges calls to it) or **URL-shipped** (the embedder hands us
 *  a module URL and the runtime imports it into the worker realm
 *  for the agent to use natively).
 *
 *  Mutual exclusivity: exactly one of the bound-value field
 *  (`fn` / `cls` / `target`) and `url` is present. The
 *  `PolicyBuilder.registerX` methods enforce this at registration
 *  time. Per-method visibility filters (`include` / `exclude` /
 *  `configure`) only apply to host-bound registrations — URL
 *  modules are exposed whole, no per-export gating (the entire
 *  module is in the worker realm; runtime filtering would be
 *  enforcement-by-not-exposing rather than real isolation).
 *
 *  See agex-runtime-worker for the configure-time URL handling
 *  that ships these specs to the worker for `await import(url)`. */
interface RegisteredFn extends RegistrationCommon {
    readonly kind: 'fn';
    readonly name: string;
    /** Host-bound: the live function the bridge calls. Mutually
     *  exclusive with `url`. */
    readonly fn?: (...args: unknown[]) => unknown | Promise<unknown>;
    /** URL-shipped: the worker imports this module and pulls
     *  `mod[export ?? name]` into the agent's scope under `name`.
     *  Mutually exclusive with `fn`. */
    readonly url?: string;
    /** Named export to pluck from the URL-shipped module. Defaults
     *  to the registration `name` for fn / cls (e.g. `agent.fn({
     *  url: '/m.js' }, { name: 'compute' })` looks up `mod.compute`).
     *  Pass `'default'` for default-exported modules. Ignored when
     *  `url` is absent. */
    readonly export?: string;
    /** Optional Standard Schema for runtime parameter validation
     *  (host-bound only — URL-shipped fns are agent-callable
     *  natively in the worker realm). */
    readonly paramsSchema?: StandardSchemaV1;
    /** When true, the framework appends a `HostFnContext` as the
     *  trailing positional argument when invoking the handler. The
     *  context exposes `console` (routes through the same image-aware
     *  pipeline as agent code's `console.log`) and `signal` (fires on
     *  task cancellation). Host-bound only — combining with `url` is
     *  rejected at registration. */
    readonly wantsContext?: boolean;
}
/** Filter spec for class/namespace member visibility. A function returns
 *  true to include; a string is treated as a glob (single segment, no `**`). */
type MemberFilter = string | ReadonlyArray<string> | ((name: string) => boolean);
/** Per-member configuration (description override, schema, etc.). */
interface MemberConfig extends RegistrationCommon {
}
interface RegisteredCls extends RegistrationCommon {
    readonly kind: 'cls';
    readonly name: string;
    /** Host-bound: live constructor the bridge constructs through.
     *  Mutually exclusive with `url`. */
    readonly cls?: new (...args: unknown[]) => unknown;
    /** URL-shipped: worker imports the module and pulls
     *  `mod[export ?? name]` into the agent's scope under `name`.
     *  Mutually exclusive with `cls`. The agent gets the real class
     *  (subclass-able, `instanceof` works natively, no per-call RPC). */
    readonly url?: string;
    /** Named export to pluck from the URL-shipped module. Defaults
     *  to the registration `name`; pass `'default'` for default
     *  exports. Ignored when `url` is absent. */
    readonly export?: string;
    readonly constructable?: boolean;
    /** Per-method visibility filters apply to host-bound classes
     *  only. URL-shipped classes are exposed whole. Combining `url`
     *  with these throws `RegistrationError` at registration time. */
    readonly include?: MemberFilter;
    readonly exclude?: MemberFilter;
    readonly configure?: Readonly<Record<string, MemberConfig>>;
}
/** A namespace exposes the visible members of `target` to the agent
 *  under the registered name. The runtime decides how to bridge
 *  method calls — same-realm runtimes call directly, the worker
 *  runtime routes each call back to the host. From the agent's
 *  perspective the surface is the same: `name.method(args)`. */
interface RegisteredNs extends RegistrationCommon {
    readonly kind: 'namespace';
    readonly name: string;
    /** Host-bound: live object whose visible members the bridge
     *  exposes. Mutually exclusive with `url`. */
    readonly target?: object;
    /** URL-shipped: worker imports the module and exposes it under
     *  the registration `name`. Mutually exclusive with `target`.
     *  Default behavior (no `export` field) is to bind the **whole
     *  module namespace object** — same semantic as `import * as
     *  name from '...'`. With `export` set, pluck `mod[export]`
     *  instead. */
    readonly url?: string;
    /** Named export to pluck from the URL-shipped module. When
     *  absent, the agent sees the whole module namespace object —
     *  this is the namespace-import default and differs from the
     *  fn / cls default of plucking by registration name. Pass
     *  `'default'` for default-exported modules, or any other
     *  named export string. Ignored when `url` is absent. */
    readonly export?: string;
    readonly recursive?: boolean;
    /** Per-member visibility filters apply to host-bound namespaces
     *  only. URL-shipped modules are exposed whole. */
    readonly include?: MemberFilter;
    readonly exclude?: MemberFilter;
    readonly configure?: Readonly<Record<string, MemberConfig>>;
}
interface RegisteredSkill {
    readonly kind: 'skill';
    readonly name: string;
    /** Markdown content. */
    readonly content: string;
}
/** A custom shell command surfaced through `terminal` emissions.
 *  Re-uses termish-ts's `CommandHandler` shape; the agent's shell
 *  pipeline executor merges these on top of termish-ts's builtins. */
interface RegisteredTerminal extends RegistrationCommon {
    readonly kind: 'terminal';
    readonly name: string;
    readonly handler: TerminalCommandHandler;
}
/** A termish-ts-compatible command handler. We re-declare the shape
 *  here rather than importing the full termish-ts types so the type
 *  module's surface stays small. */
type TerminalCommandHandler = (ctx: {
    readonly args: ReadonlyArray<string>;
    readonly stdin: string;
    readonly stdout: {
        write(s: string): void;
    };
    readonly fs: VirtualFileSystem;
    readonly env: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
}) => Promise<{
    exitCode: number;
    stderr: string;
} | undefined | void>;
/** The complete registration table. Built incrementally by
 *  `agent.fn` / `.cls` / `.namespace` / `.skill` / `.terminal`. */
interface Policy {
    readonly fns: ReadonlyMap<string, RegisteredFn>;
    readonly classes: ReadonlyMap<string, RegisteredCls>;
    readonly namespaces: ReadonlyMap<string, RegisteredNs>;
    readonly skills: ReadonlyMap<string, RegisteredSkill>;
    readonly terminals: ReadonlyMap<string, RegisteredTerminal>;
}
interface Cache {
    set<T>(key: string, value: T): Promise<void>;
    get<T = unknown>(key: string): Promise<T | undefined>;
    has(key: string): Promise<boolean>;
    delete(key: string): Promise<boolean>;
    keys(): Promise<ReadonlyArray<string>>;
}
interface EventLog {
    /** Append an event. Returns the state key it was written to. */
    add(event: AgentEvent): Promise<string>;
    /** Iterate events in chronological order. */
    iter(): AsyncIterable<AgentEvent>;
    /** Read-only view at a historical commit hash. Returns `null` if
     *  the underlying state isn't versioned. */
    at(commitHash: string): Promise<EventLog | null>;
}
/** How the agent's state is persisted. `versioned` uses kvgit-ts;
 *  `live` uses the in-process `Live` map. */
type StateConfig = {
    readonly type: 'live';
} | {
    readonly type: 'versioned';
    readonly storage: 'memory' | 'indexeddb' | 'sqlite';
    /** Required for `storage: 'sqlite'`; ignored otherwise. */
    readonly path?: string;
};
/** How the agent's virtual filesystem is backed. `memory` uses
 *  termish-ts's `MemoryFS`; `kvgit` shares the agent's state. */
type FSConfig = {
    readonly type: 'memory';
} | {
    readonly type: 'kvgit';
};

export { type NeutralTurn as $, type AgentEvent as A, type RegisteredTerminal as B, type ChapterEvent as C, type RegistrationCommon as D, type EventLog as E, type FSConfig as F, type RuntimeInitOptions as G, type HostFnContext as H, type ImageFormat as I, type SuccessEvent as J, type SystemNoteEvent as K, type LLMClient as L, type MemberFilter as M, type NamespaceResolver as N, type OutputEvent as O, type Policy as P, type TaskOutcome as Q, type RuntimeAdapter as R, type StateConfig as S, type TerminalCommandHandler as T, type TaskStartEvent as U, type VirtualFileSystem as V, type TerminalEmission as W, type TextEmission as X, type ThinkingEmission as Y, type TokenChunkType as Z, type TsEmission as _, type MemberConfig as a, type ToolName as a0, BUILTIN_PRIMER as a1, type ImagePart as a2, type NeutralPart as a3, type Role as a4, type SystemMessageInputs as a5, TOOL_EDIT_FILE as a6, TOOL_TERMINAL as a7, TOOL_TS as a8, TOOL_WRITE_FILE as a9, type TextPart as aa, type ThinkingPart as ab, type ToolResultPart as ac, type ToolSchema as ad, type ToolSchemaOptions as ae, type ToolUsePart as af, buildSystemMessage as ag, buildTaskMessage as ah, extractJsonSchema as ai, hasObjectProperties as aj, makeToolUseId as ak, objectPropertyNames as al, renderChapterText as am, renderEvents as an, renderRegistrations as ao, renderUserFileEventText as ap, toolSchemas as aq, type TaskDefinition as b, type TaskCallOptions as c, type TaskFn as d, type Chapter as e, type Cache as f, type TokenChunk as g, type ActionEvent as h, type CancelledEvent as i, type Emission as j, type ErrorEvent as k, type EventBase as l, type ExecResult as m, type ExecuteContext as n, type FailEvent as o, type FileEditEmission as p, type FileEvent as q, type FileWriteEmission as r, type LLMConfig as s, type LLMRequest as t, type LLMResponse as u, type OutputPart as v, type RegisteredCls as w, type RegisteredFn as x, type RegisteredNs as y, type RegisteredSkill as z };
