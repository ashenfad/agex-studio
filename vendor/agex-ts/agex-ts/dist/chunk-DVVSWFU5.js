import { memberAllowed } from './chunk-MUU37UMN.js';
import { safeStringify } from './chunk-ZDNM4VPR.js';

// src/slugify.ts
function slugify(input) {
  const normalized = input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (normalized.length === 0) return "chapter";
  return normalized;
}
function uniqueSlug(base, taken) {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

// src/chaptering.ts
var CHAPTER_TASK_NAME = "__chapter__";
var DEFAULT_CHAPTER_PRIMER = `Compact your context by folding completed work into named chapters. You were invoked because your context is over budget \u2014 default to folding something. The originals stay browsable at \`/chapters/<slug>/\`.

The numbered index in your inputs maps to the [N] boundaries you can fold. Each entry is either a task you ran (with its outcome) or a chapter you produced earlier. Read the full task content in your context above to write detailed summaries; the index is just for referring to ranges.

Construct \`Chapter\` instances and return them via \`taskSuccess\`:

    taskSuccess([
      { start: 1, end: 3, name: "Data exploration", message: "Found 3 tables..." },
    ])

Fold completed work that's no longer your immediate context. Including a prior chapter entry in a new range is normal \u2014 that's how you fold older summaries into higher-level ones (nested chaptering).

Don't fold the in-progress entry, or anything you still need detailed access to for active work. \`taskSuccess([])\` is a last resort \u2014 return it only when literally every boundary is in-progress or actively needed.

Rules:
- \`start\` and \`end\` are 1-based inclusive boundary positions.
- Ranges must be contiguous and non-overlapping.
- \`message\` must be VERBOSE \u2014 capture specific findings, data values, variable names, file paths, decisions, and outcomes. The chapter message is what you'll see in place of the originals, so include everything you might need later.
- \`name\` should serve as a table-of-contents entry.
`;
function shouldTriggerChaptering(events, threshold) {
  if (threshold === void 0) return false;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "action") {
      return (e.inputTokens ?? 0) >= threshold;
    }
  }
  return false;
}
var chapteringInFlight = /* @__PURE__ */ new WeakSet();
async function runChaptering(parentEvents, parentEventLog, agent, parentSession, signal, notify) {
  const chapterTask = agent.getChapterTask();
  if (chapterTask === void 0) return 0;
  if (chapteringInFlight.has(agent)) return 0;
  const refsAtTrigger = await parentEventLog.refs();
  const { text: indexText, ranges } = buildBoundaryIndex(parentEvents);
  if (!hasCompletableBoundary(parentEvents, ranges)) {
    return 0;
  }
  chapteringInFlight.add(agent);
  let chapters;
  try {
    const raw = await chapterTask(indexText, {
      session: parentSession,
      signal
    });
    chapters = validateChapters(raw, ranges.length);
  } catch (e) {
    const note = {
      type: "systemNote",
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      agentName: agent.name,
      message: `chaptering failed: ${e instanceof Error ? e.message : String(e)}`
    };
    await parentEventLog.add(note);
    await notify(note);
    return 0;
  } finally {
    chapteringInFlight.delete(agent);
  }
  if (chapters.length === 0) return 0;
  const sorted2 = [...chapters].sort((a, b) => b.start - a.start);
  const takenSlugs = /* @__PURE__ */ new Set();
  for (const e of parentEvents) {
    if (e.type === "chapter") takenSlugs.add(e.slug);
  }
  let applied = 0;
  for (const ch of sorted2) {
    const startRange = ranges[ch.start - 1];
    const endRange = ranges[ch.end - 1];
    if (startRange === void 0 || endRange === void 0) continue;
    const refs = refsAtTrigger.slice(startRange.start, endRange.end);
    if (refs.length === 0) continue;
    const slug = uniqueSlug(slugify(ch.name), takenSlugs);
    takenSlugs.add(slug);
    const ev = {
      type: "chapter",
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      agentName: agent.name,
      name: ch.name,
      message: ch.message,
      slug,
      eventRefs: refs
    };
    await parentEventLog.replaceRange(refs, ev);
    await notify(ev);
    applied++;
  }
  if (applied > 0) {
    await agent.refreshChaptersOverlay(parentSession);
  }
  return applied;
}
function buildChapterScopeFilter(events, includeOpen = false) {
  const skip = /* @__PURE__ */ new Set();
  const stack = [];
  const inChapterRange = () => stack.some((f) => f.kind === "chapter");
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.type === "taskStart") {
      if (e.taskName === CHAPTER_TASK_NAME) {
        stack.push({ kind: "chapter", start: i });
      } else {
        stack.push({ kind: "other" });
      }
    } else if (e.type === "success" || e.type === "fail" || e.type === "cancelled") {
      const top = stack.pop();
      if (top !== void 0 && top.kind === "chapter") {
        for (let j = top.start; j <= i; j++) skip.add(j);
      }
    }
    if (includeOpen && inChapterRange()) skip.add(i);
  }
  return skip;
}
function buildBoundaryIndex(events) {
  const skip = buildChapterScopeFilter(events, true);
  const boundaryIndices = [];
  for (let i = 0; i < events.length; i++) {
    if (skip.has(i)) continue;
    const e = events[i];
    if (e.type === "taskStart" || e.type === "chapter") boundaryIndices.push(i);
  }
  const ranges = boundaryIndices.map((start, i) => ({
    start,
    end: i + 1 < boundaryIndices.length ? boundaryIndices[i + 1] : events.length
  }));
  const lines = [];
  for (let i = 0; i < boundaryIndices.length; i++) {
    const idx = boundaryIndices[i];
    const range = ranges[i];
    const e = events[idx];
    const label = describeBoundary(e, events, range, skip);
    lines.push(`[${i + 1}] ${label}`);
  }
  return { text: lines.join("\n"), ranges };
}
function hasCompletableBoundary(events, ranges) {
  const skip = buildChapterScopeFilter(events, true);
  for (const r of ranges) {
    const head = events[r.start];
    if (head.type === "chapter") return true;
    for (let j = r.start + 1; j < r.end; j++) {
      if (skip.has(j)) continue;
      const ev = events[j];
      if (ev.type === "success" || ev.type === "fail" || ev.type === "cancelled") {
        return true;
      }
    }
  }
  return false;
}
function describeBoundary(boundary, events, range, skip) {
  if (boundary.type === "chapter") {
    return `chapter "${truncate(boundary.name, 60)}" \u2014 ${truncate(boundary.message, 80)}`;
  }
  if (boundary.type !== "taskStart") return "unknown";
  const taskName = boundary.taskName;
  const message = boundary.message ?? "";
  const head = `task "${truncate(taskName, 50)}"`;
  const trailer = message.length > 0 ? `: ${truncate(message.replace(/\n/g, " "), 80)}` : "";
  for (let j = range.start + 1; j < range.end; j++) {
    if (skip.has(j)) continue;
    const ev = events[j];
    if (ev.type === "success") return `${head}${trailer} \u2192 success`;
    if (ev.type === "fail") return `${head}${trailer} \u2192 fail "${truncate(ev.message, 60)}"`;
    if (ev.type === "cancelled") return `${head}${trailer} \u2192 cancelled`;
  }
  return `${head}${trailer} (in progress)`;
}
function truncate(s, max) {
  return s.length <= max ? s : `${s.slice(0, max - 1)}\u2026`;
}
function validateChapters(raw, indexLen) {
  if (!Array.isArray(raw)) {
    throw new Error(`chapter task must return an array, got ${typeof raw}`);
  }
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === null || typeof c !== "object" || typeof c.start !== "number" || typeof c.end !== "number" || typeof c.name !== "string" || typeof c.message !== "string") {
      throw new Error(
        `chapter task: item ${i} must be { start: number, end: number, name: string, message: string }`
      );
    }
    if (c.start < 1 || c.end > indexLen || c.start > c.end) {
      throw new Error(
        `chapter task: item ${i} range [${c.start}, ${c.end}] is invalid for index of length ${indexLen}`
      );
    }
    out.push({
      start: c.start,
      end: c.end,
      name: c.name,
      message: c.message
    });
  }
  const sorted2 = [...out].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted2.length; i++) {
    const prev = sorted2[i - 1];
    const curr = sorted2[i];
    if (curr.start <= prev.end) {
      throw new Error(
        `chapter task: chapters [${prev.start},${prev.end}] and [${curr.start},${curr.end}] overlap`
      );
    }
  }
  return out;
}

// src/output-part.ts
function formatErrorPart(errorName, errorMessage) {
  return `\u{1F4A5} ${errorName}: ${errorMessage}`;
}

// src/render/builtin-primer.ts
var BUILTIN_PRIMER = `# Agex Agent Environment

You are a ReAct-style agent operating in a sandboxed TypeScript environment with two action surfaces: a **TypeScript action** where computation lives, and a **per-command shell** for filesystem operations and host-registered tools.  You think in code; reach for whichever surface fits the operation.

## Core Philosophy

- **Code is action.** You solve problems by writing and running code, not by dispatching narrow tools for each sub-step.  Import libraries and call host-registered functions directly from your \`ts_action\`.
- **Each TypeScript action is a fresh script.** Variables, imports, and definitions don't carry from one \`ts_action\` to the next.  To preserve work across actions, write to the filesystem \u2014 helpers under \`/helpers/\`, working data under a scratch path.

## Capabilities

### TypeScript (\`ts_action\`)

The computation surface.  Each \`ts_action\` runs as a fresh script \u2014 variables you assign, functions you define, and modules you import are gone the moment the action returns.  To carry data between actions, write to the filesystem; to carry code, put it under \`/helpers/\` and import.  Within a single action, write a complete program: load \u2192 compute \u2192 log or \`taskSuccess\`.

\`async\`/\`await\` is supported at the top level \u2014 most host-registered methods will be async, especially anything proxying back to the host (database calls, fs operations, etc.).  Top-level \`await\` is fine; you don't need an IIFE.

**Always \`await\` async calls** (or prefix with \`void\` if you intentionally want fire-and-forget).  This matches standard JS/TS practice \u2014 \`@typescript-eslint/no-floating-promises\` flags exactly this in normal codebases.  Concretely: if you write \`async function generateReport() { ... taskSuccess(...) }\` and then call \`generateReport()\` without \`await\`, \`ts_action\` returns BEFORE \`generateReport\` finishes \u2014 the terminator fires too late, the action produces no observable outcome, and the runtime surfaces a \`MissingAwaitError\` to nudge you toward the fix.  Always write \`await generateReport()\` (or, when you really mean to discard the Promise on purpose, \`void generateReport()\`).

**TypeScript syntax**: type annotations, interfaces, type aliases, generics, and \`as\` casts are all supported and erased before execution.  A few TS features that aren't pure type-erasure are NOT supported and will throw a syntax error: \`enum\` (use \`const X = { A: 'a' } as const\` instead), \`namespace\` (use modules / imports), parameter properties (\`constructor(private x: number)\` \u2014 declare and assign instead), and decorators.  Modern TS style avoids all of these, so this rarely bites in practice.

**Registered resources \u2014 use \`import\` to reach them.**  Functions, classes, and namespaces listed in the **Registered Resources** section below are reached via natural \`import\` syntax: \`import * as math from 'math'\`, \`import { Vec } from 'Vec'\`.  The specifier is matched against the names listed under **Registered Resources**.  Most registrations also live in scope as bare globals (so \`new Vec(1, 2)\` works without an import), but writing the import is portable and the only way to reach modules that are loaded on demand \u2014 some registered libraries fetch on first use, and the import statement triggers that load (the rewriter handles the \`await\` for you, no special syntax needed on your end).  Code *you* write under \`/helpers/\` likewise gets imported via \`import { ... } from '/helpers/foo'\` (see "Importing your code" below).  Static \`import\` from anything else (npm packages, arbitrary URLs, the host's own modules) won't resolve and will throw.

**Always emit \`title\` as the first field in your tool call**, before \`code\` (or \`commands\` for terminal).  The title is a one-line summary of what this action *does* (not what you'll observe afterward) \u2014 committing to it first leads to tighter, more focused code, and the host can stream the title to the user before the body arrives.  Do this even when the conversation history shows you doing it a different way; consistency matters.

Task terminators (\`taskSuccess\`, \`taskFail\`) are only available here \u2014 not in scripts run via the shell.

### Terminal (\`terminal_action\`)

The per-invocation shell surface.  Each command runs in isolation \u2014 like \`ts_action\`, no state carries between calls.  Filesystem operations and any commands the host has registered work on **your own workspace** (the VFS); nothing here is shared with the user's local machine, and there's no remote \u2014 version control, if available, is your own over your scratch space.

Reach for the terminal when:

- Inventorying or searching the workspace (\`ls\`, \`find\`, \`grep\`).
- Running tools the host has registered \u2014 try \`<command> --help\` to see options.
- Reading documentation (\`cat /skills/<name>/SKILL.md\`) or chaptered work (\`cat /chapters/<slug>/summary.md\`).

If you develop in helpers, finish the task by importing the result back into \`ts_action\`: \`import { solve } from '/helpers/compute'; taskSuccess(solve(inputs))\`.

### Filesystem

A Virtual Filesystem is your durable workspace.  TypeScript actions and shell commands are stateless on their own, but anything you've written to the VFS persists across actions, turns, and tasks.  Two operations write to it \u2014 your response format's primer shows the concrete syntax.

**Write / Append** \u2014 create a new file with given content, or append to the end of an existing one.  Use for brand-new files or extending the end.

**Edit (search + replace)** \u2014 modify a specific region of an existing file.  Every edit specifies a \`search\` string locating the region and a \`content\` string with the new content.

- \`search\` must match the file exactly, including whitespace and indentation.
- By default \`search\` must occur exactly once.  Use the \`matchAll\` option to apply to every occurrence.
- To insert content around an existing anchor, include the anchor itself in \`content\` (e.g. search for \`function foo() {\` and replace with \`function foo() {\\n  // new line\`).
- For purely additive content, prefer \`append\` over \`edit\` \u2014 append can't miss a search target that was never there.

**Importing your code** \u2014 files you write under \`/helpers/\` (e.g. \`/helpers/utils.ts\`) can be imported as \`import { ... } from '/helpers/utils'\`.  Always use **absolute** VFS paths (\`/helpers/...\`) when importing from \`ts_action\` \u2014 the script has no meaningful current directory, so relative specifiers like \`./utils\` resolve against the VFS root and won't find your helper.  Helpers themselves *can* import each other with relative paths (\`./other\` resolves relative to the importing helper's directory).  Helpers are the canonical way to carry code across actions and tasks: write reusable functions there, import them in any future action.

### Cache (\`cache\`)

A persistent typed key-value store scoped to your agent session \u2014 survives across actions and tasks, isolated per session.  Use it for plain data you want to remember without round-tripping through the filesystem.

- \`await cache.set('rows', parsedRows)\` \u2014 store
- \`await cache.get('rows')\` \u2014 retrieve, returns \`undefined\` if absent
- \`await cache.delete('rows')\` \u2014 forget
- \`await cache.keys()\` \u2014 see what's there

**Cache only what survives a round-trip.**  Cache values cross between the worker and the host on every read/write, which means they pass through \`structuredClone\` (or JSON when state is persisted), so methods and class identity are stripped.  Plain data \u2014 objects, arrays, strings, numbers, \`Date\`, \`Map\`, \`Set\`, \`Uint8Array\` \u2014 survives intact.  Class instances do not: a cached Arquero table comes back as a bag of properties with no \`.filter()\` / \`.rollup()\` / \`.toCSV()\`, a cached DuckDB connection comes back useless, a fitted model loses its \`.predict()\`.  Convert to a portable shape on set and rebuild on get \u2014 e.g. \`cache.set('t', table.toCSV())\` paired with \`arquero.fromCSV(await cache.get('t'))\`, or \`cache.set('rows', table.objects())\` for an array of plain rows.  References stay live within a single action (no boundary crossing), but assume every other turn pays a round-trip.  For files (text, binaries, generated artifacts), prefer the VFS \u2014 cache is for small in-memory data.

### Image inspection

\`console.log\` accepts image-shaped values and renders them inline so you can inspect them on the next turn.  Three shapes are recognized:

- \`{ format: 'png' | 'jpeg' | 'webp', data: <base64 string> }\`
- A \`data:image/(png|jpeg|webp);base64,...\` string
- A \`Uint8Array\` whose first ~12 bytes match a PNG / JPEG / WebP magic

Mixed args render in order: \`console.log('shot:', bytes)\` produces a text part followed by an image part.  If you want to *inspect* raw bytes (hex, length, etc.) without the image-render path firing, slice or stringify them first \u2014 \`console.log(bytes.byteLength)\` or \`console.log(Array.from(bytes.slice(0, 16)))\` won't be misrouted.

### Chapters

Your context may contain \u{1F4D6} **Chapter** events \u2014 summaries of earlier work.  The originals are preserved at the \`/chapters/<slug>/\` path shown in each chapter; use \`ls\` / \`cat\` from \`terminal_action\` if you need specifics beyond the summary.

### Skills

If you have skills available (listed near the top of this primer), each one lives at \`/skills/<name>/SKILL.md\`.  Skills carry project-specific knowledge \u2014 API conventions, data shapes, hard-won facts about the host environment.  When a task seems related to a skill's subject, **read the skill's full content with \`cat /skills/<name>/SKILL.md\` from \`terminal_action\` before guessing** \u2014 guessed signatures and field names cost a turn each.

## Task Control

Your \`ts_action\` returning normally means "keep going" \u2014 \`console.log\` output (text or image \u2014 see *Image inspection* above) and any expression result render back to you at the start of the next turn.  Use a terminator only when you want to signal a definitive outcome:

- **\`taskSuccess(result)\`** \u2014 task complete; \`result\` is returned to the caller.
- **\`taskFail(message)\`** \u2014 task is impossible (technical impossibility, security violation, unrecoverable infrastructure error). The caller decides what to do next; you're done.

Any terminator ends the current task.  **Prints in the same action as a terminator are wasted from your perspective** \u2014 the task ends before any next turn, so there's no opportunity to read them.  Print only when you intend to keep going (so you can inspect what happened); skip the prints in the action that finishes the task.  Your event log and filesystem persist \u2014 and on a resubmitted task you'll see your prior work in your history \u2014 but TypeScript actions are stateless to begin with, so there's no live REPL state to lose.  The only thing to be deliberate about is making sure anything future-you will need is on disk: helpers under \`/helpers/\`, working data under a scratch path.

\`taskFail\` is **not** for code bugs.  If your code throws an exception, let it surface \u2014 you'll see the stack trace on the next turn and can fix it.  Wrapping code in \`try/catch\` and calling \`taskFail()\` hides bugs from yourself and ships raw stack traces to the caller.

## Inputs

The task input is available as the \`inputs\` variable in \`ts_action\`.  Its shape is described in the per-task instructions (the user message that initiated the task).  Don't reach for a JSON parse of the prompt \u2014 the values are already deserialized objects ready to use.

\`inputs\` is bound only inside \`ts_action\` itself.  Helpers under \`/helpers/\` are regular modules \u2014 they don't inherit \`ts_action\`'s ambient bindings (\`inputs\`, \`taskSuccess\`, \`fs\`, \`cache\`, \`console\`).  Pass what they need as parameters: \`import { solve } from '/helpers/compute'; taskSuccess(solve(inputs))\`.

## Best Practices

1. **Inspect data before assuming structure.** Check \`Object.keys(data)\`, \`Array.isArray(x)\`, etc. before indexing. Saves a turn of "TypeError" on data you haven't really looked at.
2. **Modularize complex logic.** Write a file under \`/helpers/\` for non-trivial code, then import it. Keeps \`ts_action\` bodies readable, and is the only way to carry code across actions \u2014 TypeScript definitions don't survive between actions.
3. **Externalize as you go.** Anything you'll want in a later action must leave the current namespace before the action returns: in-memory data goes in \`cache\`, reusable code in \`/helpers/\`, working files under \`/scratch/\` or similar.  TypeScript state is discarded after each action.
4. **Verify testable results before completing.** When your task returns something testable (a function, parser, or other reusable artifact), assert against known cases in the same \`ts_action\` as \`taskSuccess\`. If a check fails, the error surfaces next turn so you can fix it; if it passes, the task completes in one turn. Skip this for trivial answer-style tasks where the answer *is* the work.
5. **Let errors surface.** Do not wrap code in broad \`try/catch\` that calls \`taskFail\`. Stack traces are debugging information, not failure modes.
`;

// src/render/extract-schema.ts
function extractJsonSchema(schema) {
  const s = schema;
  if (typeof s.toJSONSchema === "function") {
    try {
      const out = s.toJSONSchema();
      if (out !== null && typeof out === "object") return out;
    } catch {
    }
  }
  if (typeof s.toJsonSchema === "function") {
    try {
      const out = s.toJsonSchema();
      if (out !== null && typeof out === "object") return out;
    } catch {
    }
  }
  if (typeof s.json === "object" && s.json !== null) return s.json;
  return null;
}
function hasObjectProperties(jsonSchema) {
  if (jsonSchema === null) return false;
  const s = jsonSchema;
  return s.type === "object" && typeof s.properties === "object" && s.properties !== null;
}
function objectPropertyNames(jsonSchema) {
  if (!hasObjectProperties(jsonSchema)) return [];
  const props = jsonSchema.properties;
  return Object.keys(props);
}

// src/render/registrations.ts
function renderRegistrations(policy) {
  const sections = [];
  const fns = renderFns(policy.fns);
  if (fns !== "") sections.push(fns);
  const classes = renderClasses(policy.classes);
  if (classes !== "") sections.push(classes);
  const namespaces = renderNamespaces(policy.namespaces);
  if (namespaces !== "") sections.push(namespaces);
  const terminals = renderTerminals(policy.terminals);
  if (terminals !== "") sections.push(terminals);
  return sections.join("\n\n");
}
function renderFns(fns) {
  const visible = [...fns.values()].filter((r) => r.description !== void 0);
  if (visible.length === 0) return "";
  const lines = ["## Functions", ""];
  for (const r of sorted(visible)) {
    lines.push(`- \`${r.name}\` \u2014 ${r.description}`);
  }
  return lines.join("\n");
}
function renderClasses(classes) {
  const visible = [...classes.values()].filter((r) => r.description !== void 0);
  if (visible.length === 0) return "";
  const lines = ["## Classes", ""];
  for (const r of sorted(visible)) {
    lines.push(`- \`${r.name}\` \u2014 ${r.description}`);
    if (r.constructable === false) {
      lines.push("  - *(not constructable; use as a type / static surface only)*");
    }
    if (r.cls !== void 0) {
      const members = enumerateMembers(r.cls.prototype, r.include, r.exclude);
      appendMemberLines(lines, members, r.configure ?? {});
    }
  }
  return lines.join("\n");
}
function renderNamespaces(namespaces) {
  const visible = [...namespaces.values()].filter((r) => r.description !== void 0);
  if (visible.length === 0) return "";
  const lines = ["## Namespaces", ""];
  for (const r of sorted(visible)) {
    lines.push(`- \`${r.name}\` \u2014 ${r.description}`);
    if (r.target !== void 0) {
      const members = enumerateMembers(r.target, r.include, r.exclude);
      appendMemberLines(lines, members, r.configure ?? {});
    }
  }
  return lines.join("\n");
}
function renderTerminals(terminals) {
  if (terminals.size === 0) return "";
  const lines = ["## Terminal Commands", ""];
  for (const r of sorted([...terminals.values()])) {
    lines.push(`- \`${r.name}\` \u2014 ${r.description}`);
  }
  return lines.join("\n");
}
function enumerateMembers(target, include, exclude) {
  const seen = /* @__PURE__ */ new Set();
  for (const k of Object.getOwnPropertyNames(target)) {
    if (k === "constructor") continue;
    if (memberAllowed(k, include, exclude)) seen.add(k);
  }
  let proto = Object.getPrototypeOf(target);
  while (proto !== null && proto !== Object.prototype) {
    for (const k of Object.getOwnPropertyNames(proto)) {
      if (k === "constructor") continue;
      if (memberAllowed(k, include, exclude)) seen.add(k);
    }
    proto = Object.getPrototypeOf(proto);
  }
  return [...seen].sort();
}
function appendMemberLines(lines, members, configure) {
  if (members.length === 0) return;
  lines.push("  - *Members:*");
  for (const m of members) {
    const cfg = configure[m];
    if (cfg !== void 0 && cfg.description !== void 0) {
      lines.push(`    - \`${m}\` \u2014 ${cfg.description}`);
    } else {
      lines.push(`    - \`${m}\``);
    }
  }
}
function sorted(entries) {
  return [...entries].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

// src/fs/skills-overlay.ts
var enc = new TextEncoder();
var EPOCH_ISO = (/* @__PURE__ */ new Date(0)).toISOString();
var SkillsOverlay = class {
  #files;
  #dirs;
  constructor(skills = /* @__PURE__ */ new Map()) {
    this.#files = buildFiles(skills);
    this.#dirs = computeDirs(this.#files);
  }
  /** Replace the backing skills map. Called by VfsManager when the
   *  agent's policy changes. */
  swap(skills) {
    this.#files = buildFiles(skills);
    this.#dirs = computeDirs(this.#files);
  }
  // ---------- cwd ----------
  getcwd() {
    return "/";
  }
  async chdir(path) {
    throw new Error("SkillsOverlay: chdir is not supported on read-only overlay");
  }
  // ---------- reads ----------
  async read(path) {
    const norm = normalize(path);
    const bytes = this.#files.get(norm);
    if (bytes === void 0) {
      if (this.#dirs.has(norm)) throw new Error(`read: is a directory: ${path}`);
      throw new Error(`read: no such file: ${path}`);
    }
    return new Uint8Array(bytes);
  }
  async exists(path) {
    const norm = normalize(path);
    return this.#files.has(norm) || this.#dirs.has(norm);
  }
  async isFile(path) {
    return this.#files.has(normalize(path));
  }
  async isDir(path) {
    return this.#dirs.has(normalize(path));
  }
  async stat(path) {
    const norm = normalize(path);
    const file = this.#files.get(norm);
    if (file !== void 0) {
      return { size: file.byteLength, createdAt: EPOCH_ISO, modifiedAt: EPOCH_ISO, isDir: false };
    }
    if (this.#dirs.has(norm)) {
      return { size: 0, createdAt: EPOCH_ISO, modifiedAt: EPOCH_ISO, isDir: true };
    }
    throw new Error(`stat: no such file or directory: ${path}`);
  }
  // ---------- writes (read-only) ----------
  async write() {
    throw new Error("SkillsOverlay: write not supported (read-only overlay)");
  }
  async mkdir() {
    throw new Error("SkillsOverlay: mkdir not supported (read-only overlay)");
  }
  async remove() {
    throw new Error("SkillsOverlay: remove not supported (read-only overlay)");
  }
  async rmdir() {
    throw new Error("SkillsOverlay: rmdir not supported (read-only overlay)");
  }
  async rename() {
    throw new Error("SkillsOverlay: rename not supported (read-only overlay)");
  }
  // ---------- iteration ----------
  async list(path = ".", opts = {}) {
    const norm = path === "." ? "/" : normalize(path);
    if (!this.#dirs.has(norm)) throw new Error(`list: no such directory: ${path}`);
    const prefix = norm === "/" ? "/" : `${norm}/`;
    const direct = /* @__PURE__ */ new Set();
    const all = /* @__PURE__ */ new Set();
    for (const k of this.#files.keys()) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      if (opts.recursive) {
        all.add(rest);
      } else {
        const slash = rest.indexOf("/");
        direct.add(slash === -1 ? rest : rest.slice(0, slash));
      }
    }
    for (const d of this.#dirs) {
      if (d === norm) continue;
      if (!d.startsWith(prefix)) continue;
      const rest = d.slice(prefix.length);
      if (opts.recursive) {
        all.add(rest);
      } else {
        const slash = rest.indexOf("/");
        direct.add(slash === -1 ? rest : rest.slice(0, slash));
      }
    }
    return [...opts.recursive ? all : direct].sort();
  }
  async listDetailed(path = ".", opts = {}) {
    const names = await this.list(path, opts);
    const norm = path === "." ? "/" : normalize(path);
    const userPrefix = path === "/" ? "/" : path === "." ? "/" : path.replace(/\/$/, "");
    const out = [];
    for (const name of names) {
      const childAbs = norm === "/" ? `/${name}` : `${norm}/${name}`;
      const userPath = userPrefix === "/" ? `/${name}` : `${userPrefix}/${name}`;
      const file = this.#files.get(childAbs);
      if (file !== void 0) {
        out.push({
          name: lastSegment(name),
          path: userPath,
          size: file.byteLength,
          createdAt: EPOCH_ISO,
          modifiedAt: EPOCH_ISO,
          isDir: false
        });
      } else if (this.#dirs.has(childAbs)) {
        out.push({
          name: lastSegment(name),
          path: userPath,
          size: 0,
          createdAt: EPOCH_ISO,
          modifiedAt: EPOCH_ISO,
          isDir: true
        });
      }
    }
    return out;
  }
};
function buildFiles(skills) {
  const out = /* @__PURE__ */ new Map();
  for (const [name, skill] of skills) {
    out.set(`/${name}/SKILL.md`, enc.encode(skill.content));
  }
  return out;
}
function normalize(path) {
  const abs = path.startsWith("/") ? path : `/${path}`;
  const segments = abs.split("/").filter((s) => s !== "" && s !== ".");
  const out = [];
  for (const seg of segments) {
    if (seg === "..") {
      if (out.length > 0) out.pop();
    } else out.push(seg);
  }
  return `/${out.join("/")}`;
}
function lastSegment(path) {
  const idx = path.lastIndexOf("/");
  return idx < 0 ? path : path.slice(idx + 1);
}
function computeDirs(files) {
  const dirs = /* @__PURE__ */ new Set(["/"]);
  for (const k of files.keys()) {
    let cur = k;
    while (true) {
      const idx = cur.lastIndexOf("/");
      if (idx <= 0) break;
      cur = cur.slice(0, idx);
      dirs.add(cur);
    }
  }
  return dirs;
}
function renderSkillsListing(skills) {
  if (skills.size === 0) return "";
  const lines = ["## Skills", ""];
  lines.push(
    "Skills carry project-specific knowledge \u2014 read the full content with `cat /skills/<name>/SKILL.md` from `terminal_action` before guessing."
  );
  lines.push("");
  lines.push("Available skills:");
  const sortedSkills = [...skills.values()].sort((a, b) => a.name < b.name ? -1 : 1);
  for (const s of sortedSkills) {
    const firstLine = s.content.split("\n").find((l) => l.trim().length > 0) ?? "";
    const summary = firstLine.replace(/^#+\s*/, "").slice(0, 80);
    if (summary.length > 0) lines.push(`- \`${s.name}\`: ${summary}`);
    else lines.push(`- \`${s.name}\``);
  }
  return lines.join("\n");
}

// src/render/system-message.ts
function buildSystemMessage(inputs) {
  const parts = [];
  parts.push(inputs.agexPrimerOverride ?? BUILTIN_PRIMER);
  if (inputs.runtimeAddendum !== void 0 && inputs.runtimeAddendum.trim().length > 0) {
    parts.push(inputs.runtimeAddendum.trim());
  }
  if (inputs.capabilitiesPrimer !== void 0) {
    if (inputs.capabilitiesPrimer.trim().length > 0) {
      parts.push(`# Capabilities Primer

${inputs.capabilitiesPrimer.trim()}`);
    }
  } else {
    const registrations = renderRegistrations(inputs.policy);
    if (registrations.trim().length > 0) {
      parts.push(`# Registered Resources

${registrations}`);
    }
  }
  const skillsListing = renderSkillsListing(inputs.policy.skills);
  if (skillsListing.trim().length > 0) {
    parts.push(skillsListing);
  }
  if (inputs.agentPrimer !== void 0 && inputs.agentPrimer.trim().length > 0) {
    parts.push(inputs.agentPrimer.trim());
  }
  return parts.join("\n\n");
}

// src/render/task-message.ts
function buildTaskMessage(def, inputValue) {
  const parts = [];
  parts.push(`Task: ${def.description}`);
  if (def.primer !== void 0 && def.primer.trim().length > 0) {
    parts.push(def.primer.trim());
  }
  parts.push(buildInputsBlock(def, inputValue));
  parts.push(buildExpectedReturnBlock(def));
  return parts.join("\n\n");
}
function buildInputsBlock(def, inputValue) {
  if (inputValue === void 0) {
    return "This task takes no inputs (the `inputs` variable is `undefined`).";
  }
  const reminder = "The `inputs` variable is already bound to this value \u2014 read fields off it directly (e.g. `inputs.foo`); do not redeclare it.";
  const intro = "Details for your task are available in the `inputs` variable. Here is its structure and content:";
  const jsonSchema = resolveInputJsonSchema(def);
  if (jsonSchema !== null && hasObjectProperties(jsonSchema)) {
    const lines = [];
    const properties = objectPropertyNames(jsonSchema);
    for (const prop of properties) {
      const fieldValue = inputValue[prop];
      lines.push(`${prop}: ${safeStringify(fieldValue, { maxChars: 2e3 })}`);
    }
    const renderedFields = `\`\`\`yaml
${lines.join("\n")}
\`\`\``;
    return [intro, renderedFields, reminder].join("\n\n");
  }
  if (def.inputDescription !== void 0 && def.inputDescription.trim().length > 0) {
    const blob2 = `\`\`\`json
${safeStringify(inputValue, { maxChars: 4e3 })}
\`\`\``;
    return `${intro}

Shape: ${def.inputDescription.trim()}

${blob2}

${reminder}`;
  }
  const blob = `\`\`\`json
${safeStringify(inputValue, { maxChars: 4e3 })}
\`\`\``;
  return `${intro}

${blob}

${reminder}`;
}
function resolveInputJsonSchema(def) {
  if (def.inputJsonSchema !== void 0) return def.inputJsonSchema;
  if (def.input !== void 0) return extractJsonSchema(def.input);
  return null;
}
function buildExpectedReturnBlock(def) {
  const jsonSchema = resolveOutputJsonSchema(def);
  if (jsonSchema !== null) {
    return `When complete, call \`taskSuccess(result)\` with a value matching:

\`\`\`json
${JSON.stringify(jsonSchema, null, 2)}
\`\`\``;
  }
  if (def.outputDescription !== void 0 && def.outputDescription.trim().length > 0) {
    return `When complete, call \`taskSuccess(result)\` with: ${def.outputDescription.trim()}`;
  }
  return "When complete, call `taskSuccess(result)` with whatever value satisfies the task.";
}
function resolveOutputJsonSchema(def) {
  if (def.outputJsonSchema !== void 0) return def.outputJsonSchema;
  if (def.output !== void 0) return extractJsonSchema(def.output);
  return null;
}

// src/render/tool-schemas.ts
var TOOL_TS = "ts_action";
var TOOL_TERMINAL = "terminal_action";
var TOOL_WRITE_FILE = "write_file";
var TOOL_EDIT_FILE = "edit_file";
var TS_SCHEMA = {
  name: TOOL_TS,
  description: "Run TypeScript code. The task is driven by special calls inside the code: taskSuccess(result) finishes successfully, taskFail(message) finishes with an error, taskClarify(prompt) asks the caller a question. If none is called, the code returns normally and the turn continues \u2014 printed output appears on the next turn.",
  parameters: {
    type: "object",
    required: ["title", "thinking", "code"],
    properties: {
      title: {
        type: "string",
        description: "Short title for this turn (one line)."
      },
      thinking: {
        type: "string",
        description: "Step-by-step reasoning for this turn."
      },
      code: {
        type: "string",
        description: "TypeScript source to execute."
      }
    }
  }
};
var TERMINAL_SCHEMA = {
  name: TOOL_TERMINAL,
  description: "Run shell commands. Does not signal task completion on its own \u2014 use ts_action with taskSuccess() / taskFail() to finish.",
  parameters: {
    type: "object",
    required: ["title", "thinking", "commands"],
    properties: {
      title: {
        type: "string",
        description: "Short title for this turn (one line)."
      },
      thinking: {
        type: "string",
        description: "Step-by-step reasoning for this turn."
      },
      commands: {
        type: "string",
        description: "Shell commands to run. Supported: ls, cat, head, tail, grep, find, wc, sort, uniq, cut, tr, sed, diff, xargs, cp, mv, rm, mkdir, touch, pwd, cd, basename, dirname, echo, printf, tee, tar, gzip, gunzip, zip, unzip. Notes: (1) no shell variable expansion \u2014 `$VAR` references and `X=42` assignments are not interpreted (each command is a thin handler, not a full shell). (2) `cd` is persistent \u2014 the working directory carries over to the next call within this session. (3) Within a single call commands halt on first error; chain with `;`, `&&`, `||` to control flow (`cmd || true` for best-effort)."
      }
    }
  }
};
var WRITE_FILE_SCHEMA = {
  name: TOOL_WRITE_FILE,
  description: "Write or append a file. Place TypeScript modules under '/helpers'.",
  parameters: {
    type: "object",
    required: ["path", "content"],
    properties: {
      path: {
        type: "string",
        description: "Absolute path within the agent's VFS."
      },
      content: {
        type: "string",
        description: "File contents to write."
      },
      mode: {
        type: "string",
        enum: ["write", "append"],
        description: "Defaults to 'write'."
      }
    }
  }
};
var EDIT_FILE_SCHEMA = {
  name: TOOL_EDIT_FILE,
  description: "Surgical search-and-replace. 'search' must match the file exactly (including whitespace) and occur once unless matchAll=true; its text is swapped for 'content'. To insert new content around an anchor, include the anchor in 'content' \u2014 e.g. append a function after 'function foo(){...}' by searching for the whole block and replacing with the same block plus the new function underneath.",
  parameters: {
    type: "object",
    required: ["path", "search", "content"],
    properties: {
      path: {
        type: "string",
        description: "Absolute path within the agent's VFS."
      },
      search: {
        type: "string",
        description: "Exact text to locate. Whitespace is significant."
      },
      content: {
        type: "string",
        description: "Replacement text. Swapped in for 'search'."
      },
      matchAll: {
        type: "boolean",
        description: "If true, apply to every occurrence. Defaults to false."
      }
    }
  }
};
function toolSchemas(opts = {}) {
  const action = opts.nativeThinking === true ? [stripNarrationParams(TS_SCHEMA), stripNarrationParams(TERMINAL_SCHEMA)] : [TS_SCHEMA, TERMINAL_SCHEMA];
  return [...action, WRITE_FILE_SCHEMA, EDIT_FILE_SCHEMA];
}
function stripNarrationParams(schema) {
  const params = schema.parameters;
  const newProps = {};
  for (const [k, v] of Object.entries(params.properties ?? {})) {
    if (k !== "thinking") newProps[k] = v;
  }
  const newRequired = (params.required ?? []).filter((r) => r !== "thinking");
  return {
    ...schema,
    parameters: {
      ...params,
      properties: newProps,
      required: newRequired
    }
  };
}

// src/render/index.ts
function renderEvents(events) {
  const turns = [];
  const skip = buildChapterScopeFilter(events);
  let toolUseOrder = [];
  let obsByEmission = /* @__PURE__ */ new Map();
  let synthByEmission = /* @__PURE__ */ new Map();
  let pendingTrailingParts = [];
  function flushUser() {
    const parts = [];
    for (const { id, toolName } of toolUseOrder) {
      parts.push(buildToolResultPart(id, toolName, obsByEmission.get(id), synthByEmission.get(id)));
    }
    parts.push(...pendingTrailingParts);
    if (parts.length > 0) turns.push({ role: "user", content: parts });
    toolUseOrder = [];
    obsByEmission = /* @__PURE__ */ new Map();
    synthByEmission = /* @__PURE__ */ new Map();
    pendingTrailingParts = [];
  }
  function lastEmissionId() {
    return toolUseOrder.length > 0 ? toolUseOrder[toolUseOrder.length - 1].id : null;
  }
  for (let __i = 0; __i < events.length; __i++) {
    if (skip.has(__i)) continue;
    const event = events[__i];
    switch (event.type) {
      case "taskStart": {
        flushUser();
        const text = event.message ?? `Task: ${event.taskName}`;
        turns.push({ role: "user", content: [{ type: "text", text }] });
        break;
      }
      case "action": {
        flushUser();
        turns.push(renderActionTurn(event, toolUseOrder, synthByEmission));
        break;
      }
      case "output": {
        const stamped = event.emissionId;
        const orderIds = new Set(toolUseOrder.map((t) => t.id));
        const id = stamped !== void 0 && orderIds.has(stamped) ? stamped : lastEmissionId();
        if (id !== null) {
          const slot = obsByEmission.get(id) ?? [];
          slot.push(...event.parts);
          obsByEmission.set(id, slot);
        } else {
          for (const p of event.parts) {
            pendingTrailingParts.push(outputPartToNeutral(p));
          }
        }
        break;
      }
      case "chapter": {
        flushUser();
        turns.push(renderChapterTurn(event));
        break;
      }
      case "success": {
        flushUser();
        turns.push(closingAssistantTurn("[Task complete]"));
        break;
      }
      case "fail": {
        flushUser();
        turns.push(closingAssistantTurn(`[Task failed: ${event.message}]`));
        break;
      }
      case "cancelled": {
        flushUser();
        turns.push(
          closingAssistantTurn(
            `[Task '${event.taskName}' cancelled after ${event.iterationsCompleted} iterations]`
          )
        );
        break;
      }
      case "file": {
        if (event.source === "user") {
          const summary = renderUserFileEventText(event);
          if (summary !== null) pendingTrailingParts.push({ type: "text", text: summary });
        }
        break;
      }
    }
  }
  flushUser();
  return turns;
}
function renderChapterText(event) {
  return `\u{1F4D6} Chapter: "${event.name}"

${event.message}

Full details: /chapters/${event.slug}/`;
}
function renderUserFileEventText(event) {
  const sections = [];
  if (event.added.length > 0) sections.push(`added: ${event.added.join(", ")}`);
  if (event.modified.length > 0) sections.push(`modified: ${event.modified.join(", ")}`);
  if (event.removed.length > 0) sections.push(`removed: ${event.removed.join(", ")}`);
  if (sections.length === 0) return null;
  return `[System reminder] User changes to VFS \u2014 ${sections.join("; ")}`;
}
function makeToolUseId(actionTimestamp, emissionIndex) {
  const safeTs = actionTimestamp.replace(/[:.]/g, "_").replace(/-/g, "_");
  return `tu_${safeTs}_${emissionIndex}`;
}
function renderActionTurn(event, toolUseOrder, synthByEmission) {
  const content = [];
  for (let i = 0; i < event.emissions.length; i++) {
    const em = event.emissions[i];
    const id = makeToolUseId(event.timestamp, i);
    const built = renderEmission(em, id);
    if (built === null) continue;
    content.push(built.part);
    if (built.toolName !== null) {
      toolUseOrder.push({ id, toolName: built.toolName });
      const synth = synthesizeFileResult(em);
      if (synth !== null) synthByEmission.set(id, synth);
    }
  }
  return { role: "assistant", content };
}
function renderEmission(em, emissionId) {
  switch (em.type) {
    case "ts": {
      const part = {
        type: "toolUse",
        toolUseId: emissionId,
        toolName: "ts_action",
        input: {
          code: em.code,
          ...em.thinking !== void 0 && { thinking: em.thinking },
          ...em.title !== void 0 && { title: em.title }
        },
        ...em.signature !== void 0 && { signature: em.signature }
      };
      return { part, toolName: "ts_action" };
    }
    case "terminal": {
      const part = {
        type: "toolUse",
        toolUseId: emissionId,
        toolName: "terminal_action",
        input: {
          commands: em.commands,
          ...em.thinking !== void 0 && { thinking: em.thinking },
          ...em.title !== void 0 && { title: em.title }
        },
        ...em.signature !== void 0 && { signature: em.signature }
      };
      return { part, toolName: "terminal_action" };
    }
    case "fileWrite": {
      const part = {
        type: "toolUse",
        toolUseId: emissionId,
        toolName: "write_file",
        input: { path: em.path, content: em.content, mode: em.mode },
        ...em.signature !== void 0 && { signature: em.signature }
      };
      return { part, toolName: "write_file" };
    }
    case "fileEdit": {
      const part = {
        type: "toolUse",
        toolUseId: emissionId,
        toolName: "edit_file",
        input: {
          path: em.path,
          search: em.search,
          content: em.content,
          ...em.matchAll !== void 0 && { matchAll: em.matchAll }
        },
        ...em.signature !== void 0 && { signature: em.signature }
      };
      return { part, toolName: "edit_file" };
    }
    case "text":
      return { part: { type: "text", text: em.text }, toolName: null };
    case "thinking": {
      const part = {
        type: "thinking",
        text: em.text,
        ...em.redacted !== void 0 && { redacted: em.redacted },
        ...em.signature !== void 0 && { signature: em.signature }
      };
      return { part, toolName: null };
    }
    default: {
      return null;
    }
  }
}
function synthesizeFileResult(em) {
  if (em.type === "fileWrite") {
    const verb = em.mode === "append" ? "appended to" : "wrote";
    return `write_file: ${verb} ${em.path}`;
  }
  if (em.type === "fileEdit") {
    const suffix = em.matchAll === true ? " (matchAll)" : "";
    return `edit_file: replace applied to ${em.path}${suffix}`;
  }
  return null;
}
function buildToolResultPart(toolUseId, toolName, observations, synth) {
  const obs = observations ?? [];
  const hasObservable = obs.some(
    (p) => p.type === "text" || p.type === "image" || p.type === "error"
  );
  if (synth !== void 0 && !hasObservable) {
    return {
      type: "toolResult",
      toolUseId,
      content: [{ type: "text", text: synth }]
    };
  }
  const content = [];
  const textBits = [];
  for (const p of obs) {
    if (p.type === "text") textBits.push(p.text);
    else if (p.type === "error") textBits.push(formatErrorPart(p.errorName, p.errorMessage));
  }
  if (textBits.length > 0) {
    content.push({ type: "text", text: `${toolName}: output
${textBits.join("\n")}` });
  }
  for (const p of obs) {
    if (p.type === "image") {
      content.push({
        type: "image",
        format: p.format,
        data: p.data,
        ...p.altText !== void 0 && { altText: p.altText }
      });
    }
  }
  if (content.length === 0) {
    content.push({ type: "text", text: `${toolName}: (no observation)` });
  }
  return { type: "toolResult", toolUseId, content };
}
function outputPartToNeutral(p) {
  if (p.type === "text") return { type: "text", text: p.text };
  if (p.type === "error") {
    return { type: "text", text: formatErrorPart(p.errorName, p.errorMessage) };
  }
  return {
    type: "image",
    format: p.format,
    data: p.data,
    ...p.altText !== void 0 && { altText: p.altText }
  };
}
function renderChapterTurn(event) {
  return {
    role: "assistant",
    content: [{ type: "text", text: renderChapterText(event) }]
  };
}
function closingAssistantTurn(text) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

export { BUILTIN_PRIMER, CHAPTER_TASK_NAME, DEFAULT_CHAPTER_PRIMER, SkillsOverlay, TOOL_EDIT_FILE, TOOL_TERMINAL, TOOL_TS, TOOL_WRITE_FILE, buildSystemMessage, buildTaskMessage, extractJsonSchema, hasObjectProperties, makeToolUseId, objectPropertyNames, renderChapterText, renderEvents, renderRegistrations, renderUserFileEventText, runChaptering, shouldTriggerChaptering, toolSchemas };
//# sourceMappingURL=chunk-DVVSWFU5.js.map
//# sourceMappingURL=chunk-DVVSWFU5.js.map