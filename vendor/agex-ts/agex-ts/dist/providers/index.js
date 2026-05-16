import { TOOL_EDIT_FILE, TOOL_WRITE_FILE, TOOL_TERMINAL, TOOL_TS } from '../chunk-DVVSWFU5.js';
import '../chunk-MUU37UMN.js';
import '../chunk-V7QM2ZJ3.js';
import '../chunk-ZDNM4VPR.js';

// src/providers/json-stream.ts
var SIMPLE_ESCAPES = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  n: "\n",
  t: "	",
  r: "\r",
  b: "\b",
  f: "\f"
};
var WS = /* @__PURE__ */ new Set([" ", "	", "\n", "\r"]);
var JsonStringExtractor = class {
  state = 0 /* BeforeObject */;
  currentKey = "";
  keyBuf = [];
  valueBuf = [];
  escape = false;
  unicodeHex = [];
  unicodePending = 0;
  skipDepth = 0;
  skipInStr = false;
  skipEsc = false;
  /** Feed a chunk of JSON text; collect deltas as strings grow/close.
   *  Tolerant of chunk boundaries at any position, including
   *  mid-escape and mid-`\\uXXXX`. */
  feed(chunk) {
    const out = [];
    for (const ch of chunk) {
      this.consume(ch, out);
    }
    if (this.valueBuf.length > 0 && this.state === 5 /* InString */) {
      out.push({ key: this.currentKey, content: this.valueBuf.join(""), done: false });
      this.valueBuf = [];
    }
    return out;
  }
  consume(ch, out) {
    switch (this.state) {
      case 0 /* BeforeObject */:
        if (ch === "{") this.state = 1 /* ExpectKeyOrEnd */;
        return;
      case 1 /* ExpectKeyOrEnd */:
        if (WS.has(ch)) return;
        if (ch === '"') {
          this.keyBuf = [];
          this.state = 2 /* InKey */;
        } else if (ch === "}") {
          this.state = 8 /* Done */;
        }
        return;
      case 2 /* InKey */:
        if (this.escape) {
          this.keyBuf.push(SIMPLE_ESCAPES[ch] ?? ch);
          this.escape = false;
        } else if (ch === "\\") {
          this.escape = true;
        } else if (ch === '"') {
          this.currentKey = this.keyBuf.join("");
          this.state = 3 /* ExpectColon */;
        } else {
          this.keyBuf.push(ch);
        }
        return;
      case 3 /* ExpectColon */:
        if (ch === ":") this.state = 4 /* ExpectValue */;
        return;
      case 4 /* ExpectValue */:
        if (WS.has(ch)) return;
        if (ch === '"') {
          this.state = 5 /* InString */;
          this.valueBuf = [];
          this.escape = false;
          this.unicodePending = 0;
          return;
        }
        this.skipInStr = false;
        this.skipEsc = false;
        this.skipDepth = ch === "{" || ch === "[" ? 1 : 0;
        this.state = 6 /* SkipNonString */;
        return;
      case 5 /* InString */:
        this.consumeInString(ch, out);
        return;
      case 6 /* SkipNonString */:
        this.consumeSkip(ch);
        return;
      case 7 /* ExpectCommaOrEnd */:
        if (WS.has(ch)) return;
        if (ch === ",") this.state = 1 /* ExpectKeyOrEnd */;
        else if (ch === "}") this.state = 8 /* Done */;
        return;
      case 8 /* Done */:
        return;
    }
  }
  consumeInString(ch, out) {
    if (this.unicodePending > 0) {
      this.unicodeHex.push(ch);
      this.unicodePending--;
      if (this.unicodePending === 0) {
        const hex = this.unicodeHex.join("");
        this.unicodeHex = [];
        const code = Number.parseInt(hex, 16);
        if (Number.isFinite(code)) {
          this.valueBuf.push(String.fromCodePoint(code));
        } else {
          this.valueBuf.push("\uFFFD");
        }
      }
      return;
    }
    if (this.escape) {
      this.escape = false;
      if (ch === "u") {
        this.unicodePending = 4;
        this.unicodeHex = [];
      } else {
        this.valueBuf.push(SIMPLE_ESCAPES[ch] ?? ch);
      }
      return;
    }
    if (ch === "\\") {
      this.escape = true;
      return;
    }
    if (ch === '"') {
      if (this.valueBuf.length > 0) {
        out.push({ key: this.currentKey, content: this.valueBuf.join(""), done: false });
        this.valueBuf = [];
      }
      out.push({ key: this.currentKey, content: "", done: true });
      this.state = 7 /* ExpectCommaOrEnd */;
      return;
    }
    this.valueBuf.push(ch);
  }
  consumeSkip(ch) {
    if (this.skipInStr) {
      if (this.skipEsc) {
        this.skipEsc = false;
      } else if (ch === "\\") {
        this.skipEsc = true;
      } else if (ch === '"') {
        this.skipInStr = false;
      }
      return;
    }
    if (ch === '"') {
      this.skipInStr = true;
      return;
    }
    if (ch === "{" || ch === "[") {
      this.skipDepth++;
      return;
    }
    if (ch === "}" || ch === "]") {
      if (this.skipDepth > 0) {
        this.skipDepth--;
        if (this.skipDepth === 0) this.state = 7 /* ExpectCommaOrEnd */;
        return;
      }
      if (ch === "}") this.state = 8 /* Done */;
      return;
    }
    if (ch === "," && this.skipDepth === 0) {
      this.state = 1 /* ExpectKeyOrEnd */;
    }
  }
};

// src/providers/parser.ts
var TS_KEY_MAP = {
  title: "title",
  thinking: "thinking",
  code: "ts"
};
var TERMINAL_KEY_MAP = {
  title: "title",
  thinking: "thinking",
  commands: "terminal"
};
var WRITE_FILE_KEY_MAP = {
  path: "filePath",
  content: "fileContent"
};
var EDIT_FILE_KEY_MAP = {
  path: "filePath",
  search: "fileSearch",
  content: "fileContent"
};
function keyMapFor(toolName) {
  switch (toolName) {
    case TOOL_TS:
      return TS_KEY_MAP;
    case TOOL_TERMINAL:
      return TERMINAL_KEY_MAP;
    case TOOL_WRITE_FILE:
      return WRITE_FILE_KEY_MAP;
    case TOOL_EDIT_FILE:
      return EDIT_FILE_KEY_MAP;
  }
}
var CallState = class {
  toolName;
  emissionIndex;
  /** Per-call opaque signature the provider wants round-tripped on
   *  subsequent turns (Gemini's `thoughtSignature`). Threaded onto
   *  the built Emission so the renderer can place it correctly on
   *  the next request. `undefined` for providers that don't sign. */
  signature;
  extractor = new JsonStringExtractor();
  rawBuf = [];
  keyMap;
  constructor(toolName, emissionIndex, signature) {
    this.toolName = toolName;
    this.emissionIndex = emissionIndex;
    if (signature !== void 0) this.signature = signature;
    this.keyMap = keyMapFor(toolName);
  }
  feedArgs(chunk) {
    this.rawBuf.push(chunk);
    const out = [];
    for (const delta of this.extractor.feed(chunk)) {
      const tokenType = this.keyMap[delta.key];
      if (tokenType === void 0) continue;
      out.push({
        type: tokenType,
        content: delta.content,
        done: delta.done,
        emissionIndex: this.emissionIndex
      });
    }
    return out;
  }
  /** Build the authoritative Emission from the buffered raw JSON.
   *
   *  On any parse / shape failure, returns a synthetic `TextEmission`
   *  describing what went wrong — never `null`. Two reasons:
   *
   *    1. An empty assistant turn (no emissions) makes Anthropic
   *       400 on the next request.
   *    2. The text shows up as a `[text]` part in the action's
   *       conversation history, so the model can read its own
   *       error and adjust on the next turn. */
  finalize() {
    const raw = this.rawBuf.join("");
    const fallback = (reason) => ({
      type: "emission",
      content: "",
      done: true,
      emissionIndex: this.emissionIndex,
      emission: {
        type: "text",
        text: `(${this.toolName} call dropped: ${reason})`
      }
    });
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return fallback(`invalid JSON args \u2014 ${e instanceof Error ? e.message : "unknown"}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return fallback("args were not a JSON object");
    }
    const args = parsed;
    const emission = this.buildEmission(args);
    if (emission === null) {
      return fallback("required fields missing (e.g. path / search)");
    }
    return {
      type: "emission",
      content: "",
      done: true,
      emissionIndex: this.emissionIndex,
      emission
    };
  }
  buildEmission(args) {
    switch (this.toolName) {
      case TOOL_TS:
        return buildTsEmission(args, this.signature);
      case TOOL_TERMINAL:
        return buildTerminalEmission(args, this.signature);
      case TOOL_WRITE_FILE:
        return buildWriteFileEmission(args, this.signature);
      case TOOL_EDIT_FILE:
        return buildEditFileEmission(args, this.signature);
    }
  }
};
function buildTsEmission(args, signature) {
  const code = strOr(args.code, "");
  return {
    type: "ts",
    code,
    ...args.thinking !== void 0 && { thinking: strOr(args.thinking, "") },
    ...args.title !== void 0 && { title: strOr(args.title, "") },
    ...signature !== void 0 && { signature }
  };
}
function buildTerminalEmission(args, signature) {
  const commands = strOr(args.commands, "");
  return {
    type: "terminal",
    commands,
    ...args.thinking !== void 0 && { thinking: strOr(args.thinking, "") },
    ...args.title !== void 0 && { title: strOr(args.title, "") },
    ...signature !== void 0 && { signature }
  };
}
function buildWriteFileEmission(args, signature) {
  const path = strOr(args.path, "");
  if (path.length === 0) return null;
  const rawMode = args.mode;
  const mode = rawMode === "append" ? "append" : "write";
  return {
    type: "fileWrite",
    path,
    content: strOr(args.content, ""),
    mode,
    ...signature !== void 0 && { signature }
  };
}
function buildEditFileEmission(args, signature) {
  const path = strOr(args.path, "");
  if (path.length === 0) return null;
  if (typeof args.search !== "string") return null;
  return {
    type: "fileEdit",
    path,
    search: args.search,
    content: strOr(args.content, ""),
    ...args.matchAll === true && { matchAll: true },
    ...signature !== void 0 && { signature }
  };
}
function strOr(v, fallback) {
  return typeof v === "string" ? v : fallback;
}
async function* parseToolEvents(events) {
  const calls = /* @__PURE__ */ new Map();
  let nextIndex = 0;
  let currentThinkingIdx = null;
  let currentTextIdx = null;
  for await (const event of events) {
    if (event.type === "thinkingDelta") {
      if (currentThinkingIdx === null) currentThinkingIdx = nextIndex++;
      yield {
        type: "thinking",
        content: event.content,
        done: false,
        emissionIndex: currentThinkingIdx
      };
      continue;
    }
    if (event.type === "textDelta") {
      if (currentTextIdx === null) currentTextIdx = nextIndex++;
      yield { type: "text", content: event.content, done: false, emissionIndex: currentTextIdx };
      continue;
    }
    if (event.type === "textPart") {
      const text = event.text;
      const idx = currentTextIdx ?? nextIndex++;
      currentTextIdx = null;
      const emission = { type: "text", text };
      yield { type: "emission", content: "", done: true, emissionIndex: idx, emission };
      continue;
    }
    if (event.type === "thinkingPart") {
      const hasText = event.text !== void 0 && event.text.length > 0;
      const hasSig = event.signature !== void 0;
      const isRedacted = event.redacted === true;
      if (!hasText && !hasSig && !isRedacted) {
        currentThinkingIdx = null;
        continue;
      }
      const idx = currentThinkingIdx ?? nextIndex++;
      currentThinkingIdx = null;
      const emission = {
        type: "thinking",
        text: event.text ?? "",
        ...event.signature !== void 0 && { signature: event.signature },
        ...event.redacted === true && { redacted: true }
      };
      yield { type: "emission", content: "", done: true, emissionIndex: idx, emission };
      continue;
    }
    if (event.type === "toolCallStart") {
      const idx = nextIndex++;
      calls.set(event.callId, new CallState(event.toolName, idx, event.signature));
      yield {
        type: "toolStart",
        content: event.toolName,
        done: true,
        emissionIndex: idx
      };
      continue;
    }
    if (event.type === "toolCallArgDelta") {
      const state = calls.get(event.callId);
      if (state === void 0) continue;
      for (const tok of state.feedArgs(event.argumentChunk)) yield tok;
      continue;
    }
    if (event.type === "toolCallEnd") {
      const state = calls.get(event.callId);
      if (state === void 0) continue;
      calls.delete(event.callId);
      yield state.finalize();
    }
  }
}

// src/providers/sse.ts
var MAX_LINE_BYTES = 1048576;
async function* parseSseEvents(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value !== void 0) {
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > MAX_LINE_BYTES && buffer.indexOf("\n") === -1) {
          throw new Error(`SSE line exceeded ${MAX_LINE_BYTES} bytes without a newline`);
        }
        let nl = buffer.indexOf("\n");
        while (nl !== -1) {
          const line = buffer.slice(0, nl).replace(/\r$/, "");
          buffer = buffer.slice(nl + 1);
          if (line.startsWith("data:")) {
            let payload = line.slice(5);
            if (payload.startsWith(" ")) payload = payload.slice(1);
            if (payload === "[DONE]") return;
            yield payload;
          }
          nl = buffer.indexOf("\n");
        }
      }
      if (done) break;
    }
    buffer += decoder.decode();
    const tail = buffer.replace(/\r$/, "");
    if (tail.startsWith("data:")) {
      let payload = tail.slice(5);
      if (payload.startsWith(" ")) payload = payload.slice(1);
      if (payload !== "[DONE]") yield payload;
    }
  } finally {
    reader.releaseLock();
  }
}

// src/providers/http.ts
async function* sseLinesToEventDicts(lines) {
  for await (const payload of lines) {
    if (payload.length === 0) continue;
    try {
      yield JSON.parse(payload);
    } catch {
    }
  }
}
async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
function isTransientNetworkError(err) {
  if (err instanceof Error) {
    if (err.name === "AbortError") return false;
    if (err.name === "TypeError") return true;
    const msg = err.message.toLowerCase();
    if (msg.includes("network") || msg.includes("socket") || msg.includes("econnreset")) {
      return true;
    }
  }
  return false;
}
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const t = setTimeout(resolve, ms);
    if (signal !== void 0) {
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          reject(new Error("aborted"));
        },
        { once: true }
      );
    }
  });
}

export { JsonStringExtractor, isTransientNetworkError, parseSseEvents, parseToolEvents, safeReadText, sleep, sseLinesToEventDicts };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map