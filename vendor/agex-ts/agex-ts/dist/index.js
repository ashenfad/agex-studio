import { connectState, isVersioned } from './chunk-WECOJZZ7.js';
import { KvgitState } from './chunk-3ZSPEOPD.js';
import './chunk-E46VTKTZ.js';
import { DEFAULT_CHAPTER_PRIMER, runChaptering, SkillsOverlay, buildTaskMessage, buildSystemMessage, renderEvents, makeToolUseId, getLastFiredActionTimestamp, shouldTriggerChaptering, markChapteringFired, CHAPTER_TASK_NAME } from './chunk-XTIOXGRO.js';
export { shouldTriggerChaptering } from './chunk-XTIOXGRO.js';
import { PolicyBuilder, memberAllowed } from './chunk-MUU37UMN.js';
import { CancelledError, TaskFailError, isCancelledError, RegistrationError, SchemaError } from './chunk-V7QM2ZJ3.js';
export { AgentError, CancelledError, FatalError, RegistrationError, SchemaError, TASK_CONTROL_BRAND, TaskFailError, TransientError, isTaskControlError } from './chunk-V7QM2ZJ3.js';
import './chunk-ZDNM4VPR.js';
import { TerminalError, execute } from 'termish-ts';

// src/cache.ts
var KEY_PREFIX = "cache/";
var CacheImpl = class {
  #state;
  #session;
  constructor(state, session) {
    this.#state = state;
    this.#session = session;
  }
  /** Session id this cache is scoped to. */
  get session() {
    return this.#session;
  }
  async set(key, value) {
    this.#state.set(KEY_PREFIX + key, value);
  }
  async get(key) {
    return this.#state.get(KEY_PREFIX + key);
  }
  async has(key) {
    return this.#state.has(KEY_PREFIX + key);
  }
  async delete(key) {
    if (!await this.#state.has(KEY_PREFIX + key)) return false;
    this.#state.delete(KEY_PREFIX + key);
    return true;
  }
  async keys() {
    const out = [];
    for await (const k of this.#state.keys()) {
      if (k.startsWith(KEY_PREFIX)) out.push(k.slice(KEY_PREFIX.length));
    }
    return out.sort();
  }
};

// src/event-log.ts
var DEFAULT_SESSION = "default";
var VALUE_PREFIX = "evt/";
var INDEX_KEY = "__event_log__";
var EventLogImpl = class {
  #state;
  /** Tracked for surface compatibility with callers that read
   *  `log.session` for diagnostics; the prefix is no longer derived
   *  from this field — sessions are isolated at the substrate. */
  #session;
  /** Per-millisecond collision counter so two events at the same
   *  timestamp don't overwrite each other. */
  #lastTimestamp = "";
  #seq = 0;
  constructor(state, session = DEFAULT_SESSION) {
    this.#state = state;
    this.#session = session;
  }
  /** Session id this log is scoped to. */
  get session() {
    return this.#session;
  }
  async add(event) {
    const key = this.#generateKey(event);
    this.#state.set(key, this.#stamp(event));
    const index = await this.#state.get(INDEX_KEY) ?? [];
    this.#state.set(INDEX_KEY, [...index, key]);
    return key;
  }
  async *iter() {
    const index = await this.#state.get(INDEX_KEY) ?? [];
    for (const key of index) {
      const v = await this.#state.get(key);
      if (v !== void 0) yield v;
    }
  }
  async at(commitHash) {
    if (!isVersioned(this.#state)) return null;
    return null;
  }
  /** Read the index of active event refs in chronological order.
   *  Used by chaptering to map numbered positions back to state
   *  keys; not part of the public `EventLog` interface. */
  async refs() {
    return await this.#state.get(INDEX_KEY) ?? [];
  }
  /** Replace a contiguous run of event refs with a single
   *  `ChapterEvent`. The originals stay at their state keys (so
   *  `chapterEvent.eventRefs` can resolve them) but are removed
   *  from the active index. Subsequent `iter()` yields the chapter
   *  in their place.
   *
   *  Mirrors agex-py's `replace_events_with_chapters`. Returns the
   *  state key the chapter event was written to. */
  async replaceRange(eventRefs, chapterEvent) {
    if (eventRefs.length === 0) {
      throw new Error("replaceRange: eventRefs must be non-empty");
    }
    const chapterKey = this.#generateKey(chapterEvent);
    this.#state.set(chapterKey, this.#stamp(chapterEvent));
    const index = await this.#state.get(INDEX_KEY) ?? [];
    const refSet = new Set(eventRefs);
    const next = [];
    let inserted = false;
    for (const key of index) {
      if (refSet.has(key)) {
        if (!inserted) {
          next.push(chapterKey);
          inserted = true;
        }
      } else {
        next.push(key);
      }
    }
    if (!inserted) next.push(chapterKey);
    this.#state.set(INDEX_KEY, next);
    return chapterKey;
  }
  // ---------------------------------------------------------------------------
  /**
   * Stamp `commitHash` onto an event being added to the log.
   *
   * Mirrors agex-py's `add_event_to_log` (state/log.py): when the
   * underlying state is versioned, record the *parent* commit at
   * add-time — i.e., the most recent landed commit, NOT the commit
   * this event will be part of after the next flush. The semantic
   * the studio (and any other history-replay consumer) wants is "the
   * commit you'd revert to in order to undo this event and everything
   * after it." Live state has no commits, so the field stays absent.
   *
   * Stamps once at add-time and is never rewritten when `commit()`
   * eventually lands. Same shape as agex-py — no post-commit
   * walk-back, no sidecar (eventKey → commitHash) index.
   */
  #stamp(event) {
    if (!isVersioned(this.#state)) return event;
    const parent = this.#state.currentCommit;
    if (parent === null) return event;
    return { ...event, commitHash: parent };
  }
  #generateKey(event) {
    const ts = event.timestamp || (/* @__PURE__ */ new Date()).toISOString();
    if (ts === this.#lastTimestamp) this.#seq++;
    else {
      this.#lastTimestamp = ts;
      this.#seq = 0;
    }
    return `${VALUE_PREFIX}${ts}/${this.#seq.toString().padStart(6, "0")}`;
  }
};
var encoder = new TextEncoder();
var decoder = new TextDecoder("utf-8", { fatal: false });
async function dispatchFileWrite(emission, fs) {
  await ensureParentDir(emission.path, fs);
  const bytes = encoder.encode(emission.content);
  const mode = emission.mode === "append" ? "a" : "w";
  await fs.write(emission.path, bytes, mode);
}
async function ensureParentDir(path, fs) {
  const slash = path.lastIndexOf("/");
  if (slash <= 0) return;
  const parent = path.slice(0, slash);
  await fs.mkdir(parent, { parents: true, existOk: true });
}
async function dispatchFileEdit(emission, fs) {
  if (!await fs.exists(emission.path)) {
    throw new Error(`fileEdit: ${emission.path}: no such file`);
  }
  const existing = await fs.read(emission.path);
  const text = decoder.decode(existing);
  const search = emission.search;
  if (search.length === 0) {
    throw new Error("fileEdit: empty search string");
  }
  const matchAll = emission.matchAll === true;
  let next;
  if (matchAll) {
    next = text.split(search).join(emission.content);
  } else {
    const idx = text.indexOf(search);
    if (idx === -1) {
      throw new Error(`fileEdit: ${emission.path}: search string not found`);
    }
    next = text.slice(0, idx) + emission.content + text.slice(idx + search.length);
  }
  await fs.write(emission.path, encoder.encode(next));
}
var DEFAULT_TERMINAL_OUTPUT_CAP = 2e5;
async function dispatchTerminal(commands, fs, policy, signal) {
  const hostCommands = /* @__PURE__ */ new Map();
  for (const [name, reg] of policy.terminals) {
    hostCommands.set(name, reg.handler);
  }
  return execute(commands, fs, {
    commands: hostCommands,
    signal,
    maxOutputChars: DEFAULT_TERMINAL_OUTPUT_CAP
  });
}

// src/task.ts
var DEFAULT_SESSION2 = "default";
function makeTask(agent, def, taskName) {
  return async (input, options = {}) => {
    const llmClient = agent.llm ?? throwMissing("llm");
    const runtimeAdapter = agent.runtime ?? throwMissing("runtime");
    const session = options.session ?? DEFAULT_SESSION2;
    const signal = options.signal ?? new AbortController().signal;
    const eventLog = await agent.events(session);
    const fs = await agent.fs(session);
    const cache = await agent.cache(session);
    let validatedInput = input;
    if (def.input !== void 0) {
      validatedInput = await validateOrThrow(def.input, input, "input");
    }
    await runtimeAdapter.init(agent.policy(), {
      ...agent.namespaceResolver !== void 0 && {
        namespaceResolver: agent.namespaceResolver
      }
    });
    await agent.refreshSkillsOverlay(session);
    const taskMessage = buildTaskMessage(def, validatedInput);
    const startEvent = {
      type: "taskStart",
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      agentName: agent.name,
      taskName: taskName ?? deriveTaskName(def),
      inputs: validatedInput,
      message: taskMessage
    };
    await emit(startEvent, eventLog, options.onEvent);
    let iter = 0;
    const maxIter = agent.maxIterations;
    const runtimeAddendum = runtimeAdapter.primerAddendum?.();
    const system = buildSystemMessage({
      policy: agent.policy(),
      ...agent.agexPrimerOverride !== void 0 && {
        agexPrimerOverride: agent.agexPrimerOverride
      },
      ...agent.capabilitiesPrimer !== void 0 && {
        capabilitiesPrimer: agent.capabilitiesPrimer
      },
      ...agent.primer !== void 0 && { agentPrimer: agent.primer },
      ...runtimeAddendum !== void 0 && { runtimeAddendum }
    });
    let lastError;
    try {
      while (iter < maxIter) {
        if (signal.aborted) throw new CancelledError();
        iter++;
        const events = await collectEvents(eventLog);
        const turns = renderEvents(events);
        const emissions = [];
        let inputTokens;
        let outputTokens;
        for await (const chunk of llmClient.complete({ system, turns }, signal)) {
          if (signal.aborted) throw new CancelledError();
          if (options.onToken !== void 0) await options.onToken(chunk);
          if (chunk.done && chunk.emission !== void 0) emissions.push(chunk.emission);
          if (chunk.inputTokens !== void 0) inputTokens = chunk.inputTokens;
          if (chunk.outputTokens !== void 0) outputTokens = chunk.outputTokens;
        }
        const actionEvent = {
          type: "action",
          timestamp: (/* @__PURE__ */ new Date()).toISOString(),
          agentName: agent.name,
          emissions,
          ...inputTokens !== void 0 && { inputTokens },
          ...outputTokens !== void 0 && { outputTokens }
        };
        await emit(actionEvent, eventLog, options.onEvent);
        const ctx = {
          fs,
          cache,
          signal,
          ...validatedInput !== void 0 && { inputs: validatedInput }
        };
        const outcome = await dispatchEmissions(
          emissions,
          actionEvent.timestamp,
          runtimeAdapter,
          ctx,
          fs,
          agent.policy(),
          agent.name,
          eventLog,
          options.onEvent
        );
        if (outcome.kind === "continue" && !hasActionableEmission(emissions)) {
          const reminderEvent = {
            type: "output",
            timestamp: (/* @__PURE__ */ new Date()).toISOString(),
            agentName: agent.name,
            parts: [
              {
                type: "text",
                text: "[System reminder] The previous turn produced only narration \u2014 no action tool was dispatched. Call taskSuccess(...) (or taskFail(...)) inside ts_action to finish the task, or dispatch an action tool (ts_action / terminal_action / write_file / edit_file) to keep working. Text alone does not advance the task."
              }
            ]
          };
          await emit(reminderEvent, eventLog, options.onEvent);
        }
        if (outcome.kind === "success") {
          let result = outcome.value;
          if (def.output !== void 0) {
            result = await validateOrThrow(def.output, result, "output");
          }
          const successEvent = {
            type: "success",
            timestamp: (/* @__PURE__ */ new Date()).toISOString(),
            agentName: agent.name,
            result
          };
          await emit(successEvent, eventLog, options.onEvent);
          await maybeFireBoundaryChaptering(agent, session, eventLog, signal, options.onEvent);
          return result;
        }
        if (outcome.kind === "fail") {
          const failEvent2 = {
            type: "fail",
            timestamp: (/* @__PURE__ */ new Date()).toISOString(),
            agentName: agent.name,
            message: outcome.message
          };
          await emit(failEvent2, eventLog, options.onEvent);
          await maybeFireBoundaryChaptering(agent, session, eventLog, signal, options.onEvent);
          throw new TaskFailError(outcome.message);
        }
        lastError = outcome.lastError;
      }
      const exhaustMessage = lastError !== void 0 ? `Task exceeded maxIterations (${maxIter})
Last error: ${lastError}` : `Task exceeded maxIterations (${maxIter})`;
      const failEvent = {
        type: "fail",
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        agentName: agent.name,
        message: exhaustMessage
      };
      await emit(failEvent, eventLog, options.onEvent);
      await maybeFireBoundaryChaptering(agent, session, eventLog, signal, options.onEvent);
      throw new TaskFailError(exhaustMessage);
    } catch (e) {
      if (isCancelledError(e)) {
        await emit(
          {
            type: "cancelled",
            timestamp: (/* @__PURE__ */ new Date()).toISOString(),
            agentName: agent.name,
            taskName: taskName ?? deriveTaskName(def),
            iterationsCompleted: iter
          },
          eventLog,
          options.onEvent
        );
      }
      throw e;
    }
  };
}
async function dispatchEmissions(emissions, actionTimestamp, runtime, ctx, fs, policy, agentName, eventLog, onEvent) {
  for (let i = 0; i < emissions.length; i++) {
    const em = emissions[i];
    if (ctx.signal.aborted) throw new CancelledError();
    const emissionId = makeToolUseId(actionTimestamp, i);
    if (em.type === "ts") {
      const result = await runtime.execute(em.code, { ...ctx, emissionId });
      if (result.error !== null && result.outcome.kind === "continue") {
        if (isCancelledError(result.error) || ctx.signal.aborted) {
          throw new CancelledError(result.error.message);
        }
      }
      const parts = [...result.outputs];
      if (result.error !== null && result.outcome.kind === "continue") {
        parts.push({
          type: "error",
          errorName: result.error.name || "Error",
          errorMessage: result.error.message
        });
      }
      if (parts.length > 0) {
        const outputEvent = {
          type: "output",
          timestamp: (/* @__PURE__ */ new Date()).toISOString(),
          agentName,
          emissionId,
          parts
        };
        await emit(outputEvent, eventLog, onEvent);
      }
      if (result.error !== null && result.outcome.kind === "continue") {
        return { kind: "continue", lastError: describeError(result.error) };
      }
      if (result.outcome.kind !== "continue") return result.outcome;
      continue;
    }
    if (em.type === "fileWrite") {
      try {
        await dispatchFileWrite(em, fs);
      } catch (e) {
        await emitErrorOutput(e, agentName, emissionId, eventLog, onEvent);
        return { kind: "continue", lastError: describeError(e) };
      }
      continue;
    }
    if (em.type === "fileEdit") {
      try {
        await dispatchFileEdit(em, fs);
      } catch (e) {
        await emitErrorOutput(e, agentName, emissionId, eventLog, onEvent);
        return { kind: "continue", lastError: describeError(e) };
      }
      continue;
    }
    if (em.type === "terminal") {
      try {
        const stdout = await dispatchTerminal(em.commands, fs, policy, ctx.signal);
        if (stdout.length > 0) {
          const outputEvent = {
            type: "output",
            timestamp: (/* @__PURE__ */ new Date()).toISOString(),
            agentName,
            emissionId,
            parts: [{ type: "text", text: stdout }]
          };
          await emit(outputEvent, eventLog, onEvent);
        }
      } catch (e) {
        const partial = e instanceof TerminalError ? e.partialOutput : "";
        await emitErrorOutput(e, agentName, emissionId, eventLog, onEvent, partial);
        return { kind: "continue", lastError: describeError(e) };
      }
    }
  }
  return { kind: "continue" };
}
async function emitErrorOutput(e, agentName, emissionId, eventLog, onEvent, precedingStdout = "") {
  const errorName = e instanceof Error ? e.name || "Error" : "Error";
  const errorMessage = e instanceof Error ? e.message : String(e);
  const parts = [];
  if (precedingStdout.length > 0) {
    parts.push({ type: "text", text: precedingStdout });
  }
  parts.push({ type: "error", errorName, errorMessage });
  const outputEvent = {
    type: "output",
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    agentName,
    emissionId,
    parts
  };
  await emit(outputEvent, eventLog, onEvent);
}
function describeError(e) {
  return e instanceof Error ? e.message : String(e);
}
async function collectEvents(log) {
  const out = [];
  for await (const e of log.iter()) out.push(e);
  return out;
}
async function emit(event, log, onEvent) {
  await log.add(event);
  if (onEvent !== void 0) await onEvent(event);
}
async function maybeFireBoundaryChaptering(agent, session, eventLog, signal, onEvent) {
  if (agent.getChapterTask() === void 0) return;
  if (signal.aborted) return;
  const allEvents = await collectEvents(eventLog);
  const lastFiredTs = getLastFiredActionTimestamp(eventLog);
  if (!shouldTriggerChaptering(allEvents, agent.chapteringTrigger, lastFiredTs)) return;
  await runChaptering(allEvents, eventLog, agent, session, signal, async (e) => {
    if (onEvent !== void 0) await onEvent(e);
  });
  const postEvents = await collectEvents(eventLog);
  for (let i = postEvents.length - 1; i >= 0; i--) {
    const e = postEvents[i];
    if (e.type === "action") {
      markChapteringFired(eventLog, e.timestamp);
      break;
    }
  }
}
function deriveTaskName(def) {
  const firstLine = def.description.split("\n")[0] ?? def.description;
  return firstLine.slice(0, 80);
}
async function validateOrThrow(schema, value, side) {
  const result = await schema["~standard"].validate(value);
  if ("issues" in result && result.issues !== void 0) {
    const issues = result.issues.map((i) => ({
      path: (i.path ?? []).map(
        (p) => typeof p === "object" && p !== null ? p.key : p
      ),
      message: i.message
    }));
    throw new SchemaError(
      `${side} validation failed: ${issues.map((i) => i.message).join("; ")}`,
      issues
    );
  }
  return result.value;
}
function throwMissing(field) {
  throw new Error(`agent.task: missing required ${field} (pass via createAgent({ ${field}: ... }))`);
}
function hasActionableEmission(emissions) {
  return emissions.some(
    (em) => em.type === "ts" || em.type === "terminal" || em.type === "fileWrite" || em.type === "fileEdit"
  );
}

// src/fs/chapters-overlay.ts
var enc = new TextEncoder();
var EPOCH_ISO = (/* @__PURE__ */ new Date(0)).toISOString();
var ChaptersOverlay = class {
  #files;
  /** All directory paths implied by the file map, computed on swap.
   *  Lets `isDir()` answer for synthetic intermediate dirs. */
  #dirs;
  constructor(files = /* @__PURE__ */ new Map()) {
    this.#files = files;
    this.#dirs = computeDirs(files);
  }
  /** Replace the backing file map. Used by the action loop after a
   *  new chapter lands. */
  swap(files) {
    this.#files = files;
    this.#dirs = computeDirs(files);
  }
  // ---------- cwd (no-op for read-only overlays) ----------
  getcwd() {
    return "/";
  }
  async chdir(path) {
    throw new Error("ChaptersOverlay: chdir is not supported on read-only overlay");
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
    throw new Error("ChaptersOverlay: write not supported (read-only overlay)");
  }
  async mkdir() {
    throw new Error("ChaptersOverlay: mkdir not supported (read-only overlay)");
  }
  async remove() {
    throw new Error("ChaptersOverlay: remove not supported (read-only overlay)");
  }
  async rmdir() {
    throw new Error("ChaptersOverlay: rmdir not supported (read-only overlay)");
  }
  async rename() {
    throw new Error("ChaptersOverlay: rename not supported (read-only overlay)");
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
async function buildChaptersOverlay(events, resolveEvent) {
  const out = /* @__PURE__ */ new Map();
  for await (const e of events) {
    if (e.type !== "chapter") continue;
    await renderChapterAt(e, "", out, resolveEvent);
  }
  return out;
}
async function renderChapterAt(chapter, parentPath, out, resolveEvent) {
  const base = `${parentPath}/${chapter.slug}`;
  out.set(`${base}/summary.md`, enc.encode(`# ${chapter.name}

${chapter.message}
`));
  let eventIdx = 1;
  for (const ref of chapter.eventRefs) {
    const original = await resolveEvent(ref);
    if (original === void 0) continue;
    if (original.type === "chapter") {
      await renderChapterAt(original, `${base}/chapters`, out, resolveEvent);
    } else {
      const pad = eventIdx.toString().padStart(3, "0");
      const path = `${base}/events/${pad}-${original.type}.md`;
      out.set(path, enc.encode(renderEventMarkdown(original)));
      eventIdx++;
    }
  }
}
function renderEventMarkdown(e) {
  const header = `# ${e.type} @ ${e.timestamp}`;
  switch (e.type) {
    case "taskStart":
      return `${header}

Task: ${e.taskName}

Inputs:

\`\`\`
${safeJson(e.inputs)}
\`\`\`
`;
    case "action": {
      const blocks = e.emissions.map((em, i) => {
        return `## Emission ${i + 1}: ${em.type}

${describeEmission(em)}`;
      });
      return `${header}

${blocks.join("\n\n")}
`;
    }
    case "output": {
      const parts = e.parts.map((p) => {
        if (p.type === "text") return `\`\`\`
${p.text}
\`\`\``;
        if (p.type === "error") return `**${p.errorName}**: ${p.errorMessage}`;
        return `*[image: ${p.format}, ${p.data.length} bytes base64]*`;
      });
      return `${header}

${parts.join("\n\n")}
`;
    }
    case "success":
      return `${header}

Result:

\`\`\`
${safeJson(e.result)}
\`\`\`
`;
    case "fail":
      return `${header}

${e.message}
`;
    case "cancelled":
      return `${header}

${e.taskName}: cancelled after ${e.iterationsCompleted} iterations
`;
    case "error":
      return `${header}

${e.errorName}: ${e.errorMessage}
`;
    case "file":
      return `${header}

added: ${e.added.join(", ")}
modified: ${e.modified.join(", ")}
removed: ${e.removed.join(", ")}
`;
    case "systemNote":
      return `${header}

${e.message}
`;
    case "chapter":
      return `${header}

# ${e.name}

${e.message}
`;
    default: {
      return header;
    }
  }
}
function describeEmission(em) {
  switch (em.type) {
    case "ts":
      return `\`\`\`ts
${em.code}
\`\`\``;
    case "terminal":
      return `\`\`\`sh
${em.commands}
\`\`\``;
    case "fileWrite":
      return `**${em.path}** (${em.mode})

\`\`\`
${em.content}
\`\`\``;
    case "fileEdit":
      return `**${em.path}**

search:

\`\`\`
${em.search}
\`\`\`

replace:

\`\`\`
${em.content}
\`\`\``;
    case "text":
      return em.text;
    case "thinking":
      return `*thinking:* ${em.text}`;
    default: {
      return "";
    }
  }
}
function safeJson(v) {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
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

// src/fs/mount.ts
var MountFS = class {
  #backing;
  #mounts;
  constructor(backing, mounts = []) {
    this.#backing = backing;
    this.#mounts = [];
    for (const m of mounts) this.mount(m.prefix, m.fs);
  }
  /** Add or replace a mount at `prefix`. Throws if the prefix is
   *  invalid; replaces silently if a mount at the same prefix exists.
   *
   *  Mounts are kept sorted by descending prefix length so the most
   *  specific match wins during routing — e.g. given mounts at `/a`
   *  and `/a/b`, a read at `/a/b/file.txt` correctly routes to `/a/b`. */
  mount(prefix, fs) {
    this.#validatePrefix(prefix);
    const idx = this.#mounts.findIndex((m) => m.prefix === prefix);
    if (idx >= 0) this.#mounts[idx] = { prefix, fs };
    else this.#mounts.push({ prefix, fs });
    this.#mounts.sort((a, b) => b.prefix.length - a.prefix.length);
  }
  /** Remove a mount. Returns true if one was removed. */
  unmount(prefix) {
    const idx = this.#mounts.findIndex((m) => m.prefix === prefix);
    if (idx < 0) return false;
    this.#mounts.splice(idx, 1);
    return true;
  }
  /** Currently active mounts in declaration order. */
  get mounts() {
    return this.#mounts;
  }
  // ---------- cwd ----------
  getcwd() {
    return this.#backing.getcwd();
  }
  async chdir(path) {
    return this.#backing.chdir(path);
  }
  // ---------- reads ----------
  async read(path) {
    const route = this.#route(path);
    return route.fs.read(route.path);
  }
  async exists(path) {
    const route = this.#route(path);
    return route.fs.exists(route.path);
  }
  async isFile(path) {
    const route = this.#route(path);
    return route.fs.isFile(route.path);
  }
  async isDir(path) {
    const route = this.#route(path);
    if (route.fs === this.#backing) {
      const abs = this.#abs(path);
      for (const m of this.#mounts) {
        if (abs === m.prefix) return true;
      }
    }
    return route.fs.isDir(route.path);
  }
  async stat(path) {
    const route = this.#route(path);
    if (route.fs === this.#backing) {
      const abs = this.#abs(path);
      for (const m of this.#mounts) {
        if (abs === m.prefix) {
          return {
            size: 0,
            createdAt: EPOCH_ISO2,
            modifiedAt: EPOCH_ISO2,
            isDir: true
          };
        }
      }
    }
    return route.fs.stat(route.path);
  }
  // ---------- writes (always go to the backing FS) ----------
  async write(path, content, mode) {
    const route = this.#route(path);
    if (route.fs !== this.#backing) {
      throw new TypeError(`MountFS: cannot write under read-only mount ${route.mountPrefix}`);
    }
    return this.#backing.write(path, content, mode);
  }
  async mkdir(path, opts) {
    const route = this.#route(path);
    if (route.fs !== this.#backing) {
      throw new TypeError(`MountFS: cannot mkdir under read-only mount ${route.mountPrefix}`);
    }
    return this.#backing.mkdir(path, opts);
  }
  async remove(path) {
    const route = this.#route(path);
    if (route.fs !== this.#backing) {
      throw new TypeError(`MountFS: cannot remove under read-only mount ${route.mountPrefix}`);
    }
    return this.#backing.remove(path);
  }
  async rmdir(path) {
    const route = this.#route(path);
    if (route.fs !== this.#backing) {
      throw new TypeError(`MountFS: cannot rmdir under read-only mount ${route.mountPrefix}`);
    }
    return this.#backing.rmdir(path);
  }
  async rename(src, dst) {
    const srcRoute = this.#route(src);
    const dstRoute = this.#route(dst);
    if (srcRoute.fs !== this.#backing || dstRoute.fs !== this.#backing) {
      throw new TypeError("MountFS: cannot rename across or under read-only mounts");
    }
    return this.#backing.rename(src, dst);
  }
  // ---------- iteration ----------
  async list(path, opts) {
    const route = this.#route(path ?? ".");
    const base = await route.fs.list(route.path, opts);
    if (route.fs !== this.#backing) return base.sort();
    const abs = this.#abs(path ?? ".");
    const extras = /* @__PURE__ */ new Set();
    const prefix = abs === "/" ? "/" : `${abs}/`;
    for (const m of this.#mounts) {
      if (!m.prefix.startsWith(prefix)) continue;
      const rest = m.prefix.slice(prefix.length);
      if (rest.length === 0) continue;
      if (opts?.recursive) {
        extras.add(rest);
        const inner = await m.fs.list("/", { recursive: true });
        for (const k of inner) extras.add(`${rest}/${k}`);
      } else {
        const slash = rest.indexOf("/");
        extras.add(slash === -1 ? rest : rest.slice(0, slash));
      }
    }
    const out = new Set(base);
    for (const x of extras) out.add(x);
    return [...out].sort();
  }
  async listDetailed(path, opts) {
    const route = this.#route(path ?? ".");
    const base = await route.fs.listDetailed(route.path, opts);
    if (route.fs !== this.#backing) return base;
    const abs = this.#abs(path ?? ".");
    const extras = [];
    const prefix = abs === "/" ? "/" : `${abs}/`;
    const userPrefix = path === "/" || path === void 0 || path === "." ? path ?? "." : path;
    for (const m of this.#mounts) {
      if (!m.prefix.startsWith(prefix)) continue;
      const rest = m.prefix.slice(prefix.length);
      if (rest.length === 0) continue;
      const slash = rest.indexOf("/");
      const head = slash === -1 ? rest : rest.slice(0, slash);
      const headPath = userPrefix === "/" ? `/${head}` : `${userPrefix}/${head}`;
      extras.push({
        name: head,
        path: headPath,
        size: 0,
        createdAt: EPOCH_ISO2,
        modifiedAt: EPOCH_ISO2,
        isDir: true
      });
      if (opts?.recursive) {
        const inner = await m.fs.listDetailed("/", { recursive: true });
        for (const fi of inner) {
          extras.push({
            ...fi,
            path: `${m.prefix}${fi.path === "/" ? "" : fi.path}`
          });
        }
      }
    }
    const all = [...base, ...extras];
    const byPath = /* @__PURE__ */ new Map();
    for (const fi of all) byPath.set(fi.path, fi);
    return [...byPath.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  }
  // ---------- internal ----------
  #abs(path) {
    if (path === ".") return this.#backing.getcwd();
    if (path.startsWith("/")) return normalizeAbs(path);
    return normalizeAbs(`${this.#backing.getcwd()}/${path}`);
  }
  /** Pick the FS that owns `path` and return the path translated
   *  into that FS's namespace. Mount paths route to the overlay
   *  with the mount prefix stripped; everything else routes to the
   *  backing FS unchanged. */
  #route(path) {
    const abs = this.#abs(path);
    for (const m of this.#mounts) {
      if (abs === m.prefix) {
        return { fs: m.fs, path: "/", mountPrefix: m.prefix };
      }
      if (abs.startsWith(`${m.prefix}/`)) {
        return { fs: m.fs, path: abs.slice(m.prefix.length), mountPrefix: m.prefix };
      }
    }
    return { fs: this.#backing, path, mountPrefix: null };
  }
  #validatePrefix(prefix) {
    if (!prefix.startsWith("/")) {
      throw new Error(`MountFS: mount prefix must start with '/': ${prefix}`);
    }
    if (prefix === "/") {
      throw new Error("MountFS: cannot mount at root /");
    }
    if (prefix.endsWith("/")) {
      throw new Error(`MountFS: mount prefix must not end with '/': ${prefix}`);
    }
  }
};
var EPOCH_ISO2 = (/* @__PURE__ */ new Date(0)).toISOString();
function normalizeAbs(path) {
  const segments = path.split("/").filter((s) => s !== "" && s !== ".");
  const out = [];
  for (const seg of segments) {
    if (seg === "..") {
      if (out.length > 0) out.pop();
    } else out.push(seg);
  }
  return `/${out.join("/")}`;
}

// src/vfs.ts
var CHAPTERS_PREFIX = "/chapters";
var SKILLS_PREFIX = "/skills";
var VfsManager = class {
  #createBacking;
  #cache = /* @__PURE__ */ new Map();
  constructor(createBacking) {
    this.#createBacking = createBacking;
  }
  /** Get the FileSystem for a session. Lazily creates and caches one
   *  per session id; subsequent calls return the same instance.
   *
   *  Async because the backing FS factory may await — for the kvgit
   *  backing, opening the per-session VersionedKV is async. */
  async fs(session) {
    const cached = this.#cache.get(session);
    if (cached !== void 0) return cached.mount;
    const backing = await this.#createBacking(session);
    const chaptersOverlay = new ChaptersOverlay();
    const skillsOverlay = new SkillsOverlay();
    const mount = new MountFS(backing, [
      { prefix: CHAPTERS_PREFIX, fs: chaptersOverlay },
      { prefix: SKILLS_PREFIX, fs: skillsOverlay }
    ]);
    this.#cache.set(session, { mount, chaptersOverlay, skillsOverlay });
    return mount;
  }
  /** Rebuild the `/chapters/` overlay for `session` from the current
   *  event log. Called by the action loop after chaptering applies a
   *  new chapter so the agent sees it immediately on its next
   *  filesystem read. No-op if the session hasn't been initialized
   *  yet (the next `fs()` call will build a fresh overlay). */
  async refreshChaptersOverlay(session, events, resolveEvent) {
    const entry = this.#cache.get(session);
    if (entry === void 0) return;
    const files = await buildChaptersOverlay(events, resolveEvent);
    entry.chaptersOverlay.swap(files);
  }
  /** Rebuild the `/skills/` overlay for `session` from the agent's
   *  current registered skills. Called when a new skill registers,
   *  or lazily on first task call (so freshly registered skills are
   *  visible without an explicit refresh). */
  refreshSkillsOverlay(session, skills) {
    const entry = this.#cache.get(session);
    if (entry === void 0) return;
    entry.skillsOverlay.swap(skills);
  }
};

// src/agent.ts
async function createAgent(opts) {
  const stateResolver = await connectState(opts.state ?? { type: "live" });
  return new Agent(opts, stateResolver);
}
function urlReg(spec, rest) {
  return spec.export !== void 0 ? { url: spec.url, export: spec.export, ...rest } : { url: spec.url, ...rest };
}
function isUrlSpec(v) {
  if (v === null || typeof v !== "object") return false;
  const obj = v;
  if (typeof obj.url !== "string") return false;
  for (const k of Object.keys(obj)) {
    if (k !== "url" && k !== "export") return false;
  }
  return true;
}
var DEFAULT_SESSION3 = "default";
var DEFAULT_MAX_ITERATIONS = 10;
function resolveName(explicit, intrinsic, kind) {
  if (explicit !== void 0 && explicit.length > 0) return explicit;
  if (intrinsic !== void 0 && intrinsic.length > 0) return intrinsic;
  throw new RegistrationError(
    `agent.${kind}(): no name available \u2014 the value has no usable .name property (anonymous / arrow / bound function?). Pass \`{ name: '...' }\` explicitly.`
  );
}
var Agent = class {
  // Mutable so `reconfigure({...})` can hot-swap the safe-to-mutate
  // subset of options (llm, primer, chaptering settings, etc.).
  // Replacement is whole-object via spread, so the existing readers
  // (which all dereference through `this.#opts.<field>` per call) see
  // the new value on their next read.
  #opts;
  #stateResolver;
  #policy = new PolicyBuilder();
  #vfs;
  #caches = /* @__PURE__ */ new Map();
  #eventLogs = /* @__PURE__ */ new Map();
  #chapterTask;
  constructor(opts, stateResolver) {
    this.#opts = opts;
    this.#stateResolver = stateResolver;
    const fsConfig = opts.fs ?? { type: "memory" };
    this.#vfs = new VfsManager(this.#buildBackingFactory(fsConfig));
    if (opts.chapteringTrigger !== void 0) {
      const primer = opts.chapterPrimer ?? DEFAULT_CHAPTER_PRIMER;
      this.#chapterTask = makeTask(
        this,
        { description: "Compact prior task ranges into chapters.", primer },
        CHAPTER_TASK_NAME
      );
    }
  }
  /** Build the per-session backing-FS factory the VfsManager will
   *  call. `memory`: fresh `MemoryFS` per session. `kvgit`: a
   *  `KvgitFS` over the session's shared `Staged`, which is the same
   *  store the cache and event log use — so a single
   *  `state.commit(session)` captures the whole world. */
  #buildBackingFactory(fsConfig) {
    if (fsConfig.type === "memory") {
      return async () => {
        const { MemoryFS } = await import('termish-ts/fs/memory');
        return new MemoryFS();
      };
    }
    const resolver = this.#stateResolver;
    if (!resolver.versioned) {
      throw new Error(
        `Agent: { fs: { type: "kvgit" } } requires { state: { type: "versioned", ... } } \u2014 kvgit-backed VFS shares the agent's versioned state.`
      );
    }
    return async (session) => {
      const state = await resolver.resolve(session);
      if (!(state instanceof KvgitState)) {
        throw new Error("Agent: kvgit-backed FS expects KvgitState; got an unexpected backend");
      }
      const { KvgitFS } = await import('termish-ts/fs/kvgit');
      return new KvgitFS(state.staged);
    };
  }
  // -- Identity -----------------------------------------------------------
  get name() {
    return this.#opts.name;
  }
  get maxIterations() {
    return this.#opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  }
  /** Stable identifier for the agent's current registration shape.
   *  Changes whenever a registration mutation lands. */
  get fingerprint() {
    return this.#policy.fingerprint();
  }
  /** The agent's primer prose, if any. Surfaced as part of the
   *  system prompt during task runs. */
  get primer() {
    return this.#opts.primer;
  }
  /** The configured LLM driver, if any. Tasks throw at call time
   *  if this isn't set. */
  get llm() {
    return this.#opts.llm;
  }
  /** The configured runtime, if any. Tasks throw at call time if
   *  this isn't set. */
  get runtime() {
    return this.#opts.runtime;
  }
  /** The configured namespace resolver, if any. When set, the runtime
   *  routes unregistered import specifiers through this function. */
  get namespaceResolver() {
    return this.#opts.namespaceResolver;
  }
  /** The token threshold above which chaptering fires (if a chapter
   *  task is registered). Undefined disables chaptering. */
  get chapteringTrigger() {
    return this.#opts.chapteringTrigger;
  }
  /** Override for the BUILTIN_PRIMER. Undefined uses the default. */
  get agexPrimerOverride() {
    return this.#opts.agexPrimerOverride;
  }
  /** Curated capabilities primer used in place of the auto-rendered
   *  registrations section. Undefined falls back to auto-rendering. */
  get capabilitiesPrimer() {
    return this.#opts.capabilitiesPrimer;
  }
  /** Read-only snapshot of the registration policy. */
  policy() {
    return this.#policy.snapshot();
  }
  // -- Registration -------------------------------------------------------
  //
  // All registration methods follow the same shape: the *thing being
  // registered* is the first positional arg, and a single options
  // object holds everything else (name override, description,
  // visibility filters, etc.). Mirrors agex-py's
  // `agent.cls(MyClass, name="...")` style. Where a name can be
  // inferred from the value (`fn.name`, `cls.name`) it's optional;
  // namespace / skill / terminal require explicit `name` since
  // plain objects, markdown blobs, and handlers don't carry a
  // useful identifier.
  fn(fn, opts = {}) {
    const { name: _drop, ...rest } = opts;
    if (isUrlSpec(fn)) {
      const name2 = resolveName(opts.name, fn.export, "fn");
      this.#policy.registerFn(name2, urlReg(fn, rest));
      return this;
    }
    const name = resolveName(opts.name, fn.name, "fn");
    this.#policy.registerFn(name, { fn, ...rest });
    return this;
  }
  cls(cls, opts = {}) {
    const { name: _drop, ...rest } = opts;
    if (isUrlSpec(cls)) {
      const name2 = resolveName(opts.name, cls.export, "cls");
      this.#policy.registerCls(name2, urlReg(cls, rest));
      return this;
    }
    const name = resolveName(opts.name, cls.name, "cls");
    this.#policy.registerCls(name, { cls, ...rest });
    return this;
  }
  namespace(target, opts) {
    const { name, ...rest } = opts;
    if (isUrlSpec(target)) {
      this.#policy.registerNamespace(name, urlReg(target, rest));
      return this;
    }
    this.#policy.registerNamespace(name, { target, ...rest });
    return this;
  }
  skill(content, opts) {
    this.#policy.registerSkill(opts.name, content);
    return this;
  }
  terminal(handler, opts) {
    const { name, ...rest } = opts;
    this.#policy.registerTerminal(name, { handler, ...rest });
    return this;
  }
  // -- Task lifecycle ----------------------------------------------------
  /** Define a typed callable that drives the action loop. The
   *  returned function is awaitable: `const result = await task(input)`. */
  task(def) {
    return makeTask(this, def);
  }
  /** Framework-internal accessor — the chaptering machinery looks
   *  up the auto-registered chapter task through here. Returns
   *  `undefined` when chaptering is disabled (i.e. `chapteringTrigger`
   *  was not set on this agent). Not part of the user-facing surface;
   *  embedders enable chaptering via `AgentOptions.chapteringTrigger`. */
  getChapterTask() {
    return this.#chapterTask;
  }
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
  async runChaptering(session = DEFAULT_SESSION3, opts = {}) {
    const eventLog = await this.events(session);
    const events = [];
    for await (const e of eventLog.iter()) events.push(e);
    const signal = opts.signal ?? new AbortController().signal;
    return runChaptering(events, eventLog, this, session, signal, async (e) => {
      if (opts.onEvent !== void 0) await opts.onEvent(e);
    });
  }
  // -- Per-session host APIs ---------------------------------------------
  //
  // Every per-session accessor is async because session state is
  // resolved lazily through the `StateResolver` (opening an
  // IndexedDB / SQLite store is async). Once a session has been
  // resolved, the corresponding `CacheImpl` / `EventLogImpl` /
  // `MountFS` is cached, so subsequent calls await one map lookup.
  /** Per-session VFS. Same instance for the same session id; writes
   *  persist across calls within the agent's lifetime. */
  async fs(session = DEFAULT_SESSION3) {
    return this.#vfs.fs(session);
  }
  /** Framework-internal: rebuild the `/skills/` overlay for `session`
   *  from the current registered skills. Called by the action loop
   *  on every task start so newly-registered skills become
   *  browseable. */
  async refreshSkillsOverlay(session = DEFAULT_SESSION3) {
    await this.fs(session);
    this.#vfs.refreshSkillsOverlay(session, this.policy().skills);
  }
  /** Framework-internal: rebuild the `/chapters/` overlay for
   *  `session` from the current event log + state, so a chapter that
   *  just landed becomes browseable on the next read. The chaptering
   *  machinery calls this after `replaceRange`. */
  async refreshChaptersOverlay(session = DEFAULT_SESSION3) {
    const log = await this.events(session);
    const state = await this.#stateResolver.resolve(session);
    await this.#vfs.refreshChaptersOverlay(
      session,
      log.iter(),
      (ref) => state.get(ref)
    );
  }
  /** Per-session typed cache. */
  async cache(session = DEFAULT_SESSION3) {
    const cached = this.#caches.get(session);
    if (cached !== void 0) return cached;
    const state = await this.#stateResolver.resolve(session);
    const fresh = new CacheImpl(state, session);
    this.#caches.set(session, fresh);
    return fresh;
  }
  /** Per-session event log. Same instance for the same session id.
   *
   *  Returns the concrete `EventLogImpl` rather than just the public
   *  `EventLog` interface, because framework-internal callers (the
   *  task lifecycle, chaptering machinery) need extra methods like
   *  `refs()` and `replaceRange()`. The public surface is the same;
   *  end-user code generally interacts via the `EventLog` interface. */
  async events(session = DEFAULT_SESSION3) {
    const cached = this.#eventLogs.get(session);
    if (cached !== void 0) return cached;
    const state = await this.#stateResolver.resolve(session);
    const fresh = new EventLogImpl(state, session);
    this.#eventLogs.set(session, fresh);
    return fresh;
  }
  /** The session's underlying StateBackend. Useful for inspection /
   *  manual commit / time travel via kvgit. Returns the raw backend
   *  so consumers can use the `isVersioned` predicate. */
  async state(session = DEFAULT_SESSION3) {
    return this.#stateResolver.resolve(session);
  }
  /** Flush pending writes for `session` if the backend is versioned.
   *  No-op for Live. */
  async commit(session = DEFAULT_SESSION3, opts = {}) {
    const state = await this.#stateResolver.resolve(session);
    if (!isVersioned(state)) return null;
    return state.commit(opts);
  }
  /** Release runtime resources. Must be called when the agent is no
   *  longer needed — a worker-based `RuntimeAdapter` (the production
   *  default) holds onto a Worker / `worker_threads` instance that
   *  won't get GC'd otherwise. No-op if no runtime is configured.
   *
   *  After `dispose()`, calling `task()` will fail because the runtime
   *  is gone. Don't reuse the agent. */
  async dispose() {
    const runtime = this.#opts.runtime;
    if (runtime !== void 0) await runtime.dispose();
  }
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
  reconfigure(opts) {
    this.#opts = { ...this.#opts, ...opts };
  }
  // -- Inspection / time-travel ------------------------------------------
  /** Commit metadata at `hash` (or current HEAD if omitted) for
   *  `session`. Null on non-versioned state or if the commit doesn't
   *  exist. */
  async commitInfo(hash, session = DEFAULT_SESSION3) {
    const state = await this.#stateResolver.resolve(session);
    if (!(state instanceof KvgitState)) return null;
    return state.commitInfo(hash);
  }
  /** Walk `session`'s commit hashes backward through the history.
   *  Yields nothing on non-versioned state. */
  async *history(hash, opts = {}) {
    const session = opts.session ?? DEFAULT_SESSION3;
    const state = await this.#stateResolver.resolve(session);
    if (!(state instanceof KvgitState)) return;
    const histOpts = opts.allParents !== void 0 ? { allParents: opts.allParents } : {};
    for await (const h of state.history(hash, histOpts)) yield h;
  }
  /** Read `session`'s events as they were at a historical commit.
   *  Returns `null` if the backend isn't versioned or the commit
   *  doesn't exist. */
  async eventsAt(commitHash, session = DEFAULT_SESSION3) {
    const state = await this.#stateResolver.resolve(session);
    if (!(state instanceof KvgitState)) return null;
    const view = await state.checkoutAt(commitHash);
    if (view === null) return null;
    const { Staged } = await import('kvgit-ts');
    const { polymorphicDecoder, polymorphicEncoder } = await import('termish-ts/fs/kvgit');
    const historicalStaged = new Staged(view, {
      encoder: polymorphicEncoder,
      decoder: polymorphicDecoder
    });
    const historicalState = new KvgitState(historicalStaged);
    return new EventLogImpl(historicalState, session);
  }
  // -- Internals exposed for the action loop / runtime adapter ----------
  /** Test-shaped check that a member name passes the include/exclude
   *  filter pair. Exposed for adapters that need to mirror the agent's
   *  filter rules. */
  static memberAllowed = memberAllowed;
};

// src/pretty.ts
var defaultWrite = (s) => {
  const proc = typeof globalThis !== "undefined" ? globalThis.process : void 0;
  if (proc?.stdout?.write !== void 0) proc.stdout.write(s);
  else console.log(s);
};
function prettyTokens(token, opts = {}) {
  const write = opts.write ?? defaultWrite;
  switch (token.type) {
    case "toolStart":
      write(`
[${token.content}]
`);
      return;
    case "title":
      if (token.done) write("\n");
      else if (token.content.length > 0) write(token.content);
      return;
    case "thinking":
    case "text":
    case "ts":
    case "terminal":
      write(token.content);
      return;
    case "filePath":
    case "fileSearch": {
      const label = token.type === "filePath" ? "path" : "search";
      if (token.done) write("\n");
      else if (token.content.length > 0) write(`
${label}: ${token.content}`);
      return;
    }
    case "fileContent":
      write(token.content);
      return;
    case "emission":
      write("\n");
      return;
    case "signature":
      return;
  }
}
function prettyEvents(event, opts = {}) {
  const write = opts.write ?? ((s) => console.log(s));
  const maxBody = opts.maxBody ?? 2e3;
  switch (event.type) {
    case "taskStart":
      write(`[taskStart] ${event.taskName}`);
      return;
    case "action":
      for (const em of event.emissions) {
        switch (em.type) {
          case "ts": {
            const head = em.title !== void 0 && em.title.length > 0 ? `[ts] ${em.title}` : "[ts]";
            write(`${head}
${indent(cap(em.code, maxBody))}`);
            break;
          }
          case "terminal": {
            const head = em.title !== void 0 && em.title.length > 0 ? `[terminal] ${em.title}` : "[terminal]";
            write(`${head} ${cap(em.commands, maxBody)}`);
            break;
          }
          case "thinking":
            write(`[thinking] ${cap(em.text, maxBody)}`);
            break;
          case "text":
            write(`[text] ${cap(em.text, maxBody)}`);
            break;
          case "fileWrite":
            write(`[fileWrite] ${em.path} (${em.mode})`);
            break;
          case "fileEdit":
            write(`[fileEdit] ${em.path}`);
            break;
        }
      }
      return;
    case "output":
      for (const p of event.parts) {
        if (p.type === "text") write(`[stdout] ${cap(p.text.trim(), maxBody)}`);
        else if (p.type === "error")
          write(`[stderr] ${cap(`${p.errorName}: ${p.errorMessage}`, maxBody)}`);
        else write(`[stdout] <image ${p.format}>`);
      }
      return;
    case "success":
      write("[success]");
      return;
    case "fail":
      write(`[fail] ${event.message}`);
      return;
    case "cancelled":
      write(`[cancelled] ${event.taskName} after ${event.iterationsCompleted} iterations`);
      return;
    case "error":
      write(`[error] ${event.errorName}: ${event.errorMessage}`);
      return;
    case "chapter":
      write(`[chapter] ${event.name} \u2014 ${cap(event.message, maxBody)}`);
      return;
    case "file":
      write(
        `[file:${event.source}] +${event.added.length} ~${event.modified.length} -${event.removed.length}`
      );
      return;
    case "systemNote":
      write(`[systemNote] ${event.message}`);
      return;
  }
}
function cap(s, n) {
  if (n === Number.POSITIVE_INFINITY || s.length <= n) return s;
  return `${s.slice(0, n)}\u2026(${s.length - n} more)`;
}
function indent(s, by = "  ") {
  return s.split("\n").map((l) => by + l).join("\n");
}

export { Agent, createAgent, prettyEvents, prettyTokens };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map