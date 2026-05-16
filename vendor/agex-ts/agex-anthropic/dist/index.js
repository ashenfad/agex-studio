import { isTransientNetworkError, sleep, safeReadText, parseSseEvents, sseLinesToEventDicts, parseToolEvents } from 'agex-ts/providers';
import { toolSchemas } from 'agex-ts/render';

// src/client.ts

// src/adapter.ts
function schemasToAnthropicTools(schemas) {
  return schemas.map((s) => ({
    name: s.name,
    description: s.description,
    input_schema: s.parameters
  }));
}
function lowerNeutralTurns(turns) {
  return turns.map((turn) => ({
    role: turn.role,
    content: turn.content.flatMap(lowerPart)
  }));
}
function lowerPart(part) {
  switch (part.type) {
    case "text":
      return [lowerText(part)];
    case "image":
      return [lowerImage(part)];
    case "thinking":
      return lowerThinking(part);
    case "toolUse":
      return [lowerToolUse(part)];
    case "toolResult":
      return [lowerToolResult(part)];
    default: {
      return [];
    }
  }
}
function lowerText(part) {
  return { type: "text", text: part.text };
}
function lowerImage(part) {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: imageMediaType(part.format),
      data: part.data
    }
  };
}
function imageMediaType(format) {
  switch (format) {
    case "png":
      return "image/png";
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
  }
}
function lowerThinking(part) {
  if (part.signature === void 0) return [];
  const sig = decodeUtf8(part.signature);
  if (part.redacted === true) {
    return [{ type: "redacted_thinking", data: sig }];
  }
  return [{ type: "thinking", thinking: part.text, signature: sig }];
}
function lowerToolUse(part) {
  return {
    type: "tool_use",
    id: part.toolUseId,
    name: part.toolName,
    input: part.input
  };
}
function lowerToolResult(part) {
  return {
    type: "tool_result",
    tool_use_id: part.toolUseId,
    content: part.content.map((c) => c.type === "text" ? lowerText(c) : lowerImage(c)),
    ...part.isError === true && { is_error: true }
  };
}
var _decoder = new TextDecoder("utf-8", { fatal: false });
function decodeUtf8(bytes) {
  return _decoder.decode(bytes);
}
function applyCacheControl(messages, cacheIndex, ttl = "1h") {
  if (messages.length === 0 || cacheIndex < 0 || cacheIndex >= messages.length) {
    return messages.map((m) => ({ ...m }));
  }
  const cc = { type: "ephemeral", ttl };
  return messages.map((msg, i) => {
    if (i !== cacheIndex) return { ...msg };
    const targetIdx = findCacheableBlockIndex(msg.content);
    if (targetIdx === null) return { ...msg };
    const newContent = msg.content.map(
      (b, j) => j === targetIdx ? withCacheControl(b, cc) : b
    );
    return { role: msg.role, content: newContent };
  });
}
function findCacheableBlockIndex(content) {
  for (let i = content.length - 1; i >= 0; i--) {
    const b = content[i];
    if (b === void 0) continue;
    if (b.type === "text" && b.text.length === 0) continue;
    return i;
  }
  return null;
}
function withCacheControl(block, cc) {
  return { ...block, cache_control: cc };
}

// src/stream.ts
function newState() {
  return {
    openByIndex: /* @__PURE__ */ new Map(),
    thinkingByIndex: /* @__PURE__ */ new Map(),
    textByIndex: /* @__PURE__ */ new Map()
  };
}
async function* translateAnthropicStream(events, usage) {
  const state = newState();
  for await (const raw of events) {
    const ev = raw ?? {};
    captureUsage(ev, usage);
    if (ev.type === "error") {
      const e = ev.error ?? {};
      throw new Error(`Anthropic stream error: ${e.message ?? e.type ?? "unknown"}`);
    }
    yield* handleEvent(state, ev);
  }
  for (const { callId } of state.openByIndex.values()) {
    yield { type: "toolCallEnd", callId };
  }
  state.openByIndex.clear();
  for (const t of state.thinkingByIndex.values()) {
    yield* emitThinking(t);
  }
  state.thinkingByIndex.clear();
}
function* handleEvent(state, ev) {
  const etype = ev.type;
  if (etype === "content_block_start") {
    const idx = ev.index;
    if (idx === void 0) return;
    const block = ev.content_block ?? {};
    const btype = block.type;
    if (btype === "tool_use") {
      const callId = block.id ?? `call_${idx}`;
      const name = block.name ?? "";
      state.openByIndex.set(idx, { callId, toolName: name });
      yield { type: "toolCallStart", callId, toolName: name };
    } else if (btype === "thinking") {
      state.thinkingByIndex.set(idx, {
        text: "",
        signature: "",
        redacted: false,
        data: ""
      });
    } else if (btype === "redacted_thinking") {
      state.thinkingByIndex.set(idx, {
        text: "",
        signature: "",
        redacted: true,
        // Encrypted payload arrives whole on block_start (not via deltas).
        data: block.data ?? ""
      });
    } else if (btype === "text") {
      state.textByIndex.set(idx, block.text ?? "");
    }
    return;
  }
  if (etype === "content_block_delta") {
    const idx = ev.index;
    if (idx === void 0) return;
    const delta = ev.delta ?? {};
    const dtype = delta.type;
    if (dtype === "input_json_delta") {
      const open = state.openByIndex.get(idx);
      const partial = delta.partial_json ?? "";
      if (open !== void 0 && partial.length > 0) {
        yield { type: "toolCallArgDelta", callId: open.callId, argumentChunk: partial };
      }
    } else if (dtype === "thinking_delta") {
      const t = state.thinkingByIndex.get(idx);
      if (t !== void 0) {
        const chunk = delta.thinking ?? "";
        t.text += chunk;
        if (chunk.length > 0) yield { type: "thinkingDelta", content: chunk };
      }
    } else if (dtype === "signature_delta") {
      const t = state.thinkingByIndex.get(idx);
      if (t !== void 0) t.signature += delta.signature ?? "";
    } else if (dtype === "text_delta") {
      const cur = state.textByIndex.get(idx);
      if (cur !== void 0) {
        const chunk = delta.text ?? "";
        state.textByIndex.set(idx, cur + chunk);
        if (chunk.length > 0) yield { type: "textDelta", content: chunk };
      }
    }
    return;
  }
  if (etype === "content_block_stop") {
    const idx = ev.index;
    if (idx === void 0) return;
    const open = state.openByIndex.get(idx);
    if (open !== void 0) {
      state.openByIndex.delete(idx);
      yield { type: "toolCallEnd", callId: open.callId };
      return;
    }
    const t = state.thinkingByIndex.get(idx);
    if (t !== void 0) {
      state.thinkingByIndex.delete(idx);
      yield* emitThinking(t);
      return;
    }
    const text = state.textByIndex.get(idx);
    if (text !== void 0) {
      state.textByIndex.delete(idx);
      if (text.length > 0) yield { type: "textPart", text };
    }
  }
}
var _enc = new TextEncoder();
function* emitThinking(t) {
  if (t.redacted) {
    if (t.data.length === 0) return;
    yield {
      type: "thinkingPart",
      signature: _enc.encode(t.data),
      redacted: true
    };
    return;
  }
  const hasText = t.text.length > 0;
  const hasSig = t.signature.length > 0;
  if (!hasText && !hasSig) return;
  yield {
    type: "thinkingPart",
    ...hasText && { text: t.text },
    ...hasSig && { signature: _enc.encode(t.signature) }
  };
}
function captureUsage(ev, usage) {
  if (usage === void 0) return;
  const t = ev.type;
  if (t === "message_start") {
    const msg = ev.message ?? {};
    applyUsage(msg.usage, usage);
  } else if (t === "message_delta") {
    applyUsage(ev.usage, usage);
  }
}
function applyUsage(u, holder) {
  if (u === void 0) return;
  const totalIn = totalInputTokens(u);
  if (totalIn !== null) holder.inputTokens = totalIn;
  const out = u.output_tokens;
  if (typeof out === "number") holder.outputTokens = out;
}
function totalInputTokens(u) {
  const hasAny = "input_tokens" in u || "cache_creation_input_tokens" in u || "cache_read_input_tokens" in u;
  if (!hasAny) return null;
  return numberOr0(u.input_tokens) + numberOr0(u.cache_creation_input_tokens) + numberOr0(u.cache_read_input_tokens);
}
function numberOr0(v) {
  return typeof v === "number" ? v : 0;
}

// src/client.ts
var ANTHROPIC_VERSION = "2023-06-01";
var DEFAULT_BASE_URL = "https://api.anthropic.com/v1";
var DEFAULT_MODEL = "claude-sonnet-4-5";
var DEFAULT_MAX_TOKENS = 16384;
var DEFAULT_THINKING_BUDGET = 2048;
var DEFAULT_TIMEOUT_MS = 9e4;
var STREAM_MAX_RETRIES = 2;
var RETRY_BACKOFF_MS = 1e3;
var CACHE_TTL = "1h";
var Anthropic = class {
  model;
  apiKey;
  baseUrl;
  timeoutMs;
  nativeThinking;
  thinkingBudget;
  maxTokens;
  extras;
  browserDirectAccess;
  fetchImpl;
  headerOverrides;
  constructor(opts = {}) {
    this.model = opts.model ?? DEFAULT_MODEL;
    this.apiKey = opts.apiKey ?? "";
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.nativeThinking = opts.nativeThinking ?? true;
    this.thinkingBudget = opts.thinkingBudget ?? DEFAULT_THINKING_BUDGET;
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.extras = opts.extras ?? {};
    this.browserDirectAccess = opts.browserDirectAccess ?? false;
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
    this.headerOverrides = lowercaseKeys(opts.headers ?? {});
  }
  // ---------- LLMClient surface ----------
  async *complete(request, signal) {
    const body = this.buildBody(request);
    const url = `${this.baseUrl}/messages`;
    const headers = this.buildHeaders();
    let lastError;
    for (let attempt = 0; attempt < STREAM_MAX_RETRIES; attempt++) {
      try {
        yield* this.streamOnce(url, body, headers, signal);
        return;
      } catch (err) {
        lastError = err;
        if (signal?.aborted) throw err;
        if (!isTransientNetworkError(err) || attempt + 1 >= STREAM_MAX_RETRIES) throw err;
        await sleep(RETRY_BACKOFF_MS, signal);
      }
    }
    throw lastError;
  }
  dumpConfig() {
    return {
      provider: "anthropic",
      model: this.model,
      timeoutSeconds: this.timeoutMs / 1e3,
      extras: {
        baseUrl: this.baseUrl,
        nativeThinking: this.nativeThinking,
        thinkingBudget: this.thinkingBudget,
        maxTokens: this.maxTokens,
        ...this.extras
      }
    };
  }
  // ---------- Request construction ----------
  buildBody(request) {
    const lowered = lowerNeutralTurns(request.turns);
    const cacheIdx = lowered.length - 2;
    const messages = applyCacheControl(
      lowered,
      cacheIdx,
      CACHE_TTL
    );
    const system = [
      {
        type: "text",
        text: request.system,
        cache_control: { type: "ephemeral", ttl: CACHE_TTL }
      }
    ];
    const tools = schemasToAnthropicTools(
      toolSchemas({ nativeThinking: this.nativeThinking })
    );
    const body = {
      model: this.model,
      system,
      messages,
      tools,
      max_tokens: this.maxTokens,
      stream: true
    };
    if (this.nativeThinking) {
      body.thinking = { type: "enabled", budget_tokens: this.thinkingBudget };
    } else {
      body.tool_choice = { type: "any" };
    }
    Object.assign(body, this.extras);
    return body;
  }
  buildHeaders() {
    const h = {
      "content-type": "application/json",
      "anthropic-version": ANTHROPIC_VERSION
    };
    if (this.apiKey.length > 0) h["x-api-key"] = this.apiKey;
    if (this.browserDirectAccess) h["anthropic-dangerous-direct-browser-access"] = "true";
    for (const [k, v] of Object.entries(this.headerOverrides)) {
      if (v === null) delete h[k];
      else h[k] = v;
    }
    return h;
  }
  // ---------- Streaming ----------
  async *streamOnce(url, body, headers, signal) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal !== void 0) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeoutHandle);
      if (signal !== void 0) signal.removeEventListener("abort", onAbort);
    }
    if (!response.ok) {
      const text = await safeReadText(response);
      throw new Error(
        `Anthropic API error ${response.status} ${response.statusText}: ${text || "(empty body)"}`
      );
    }
    if (response.body === null) {
      throw new Error("Anthropic API returned no response body");
    }
    const usage = { inputTokens: null, outputTokens: null };
    const sseLines = parseSseEvents(response.body);
    const events = sseLinesToEventDicts(sseLines);
    const toolCallEvents = translateAnthropicStream(events, usage);
    let lastIndex = -1;
    for await (const tok of parseToolEvents(toolCallEvents)) {
      if (tok.type === "emission" && tok.emissionIndex > lastIndex) {
        lastIndex = tok.emissionIndex;
      }
      yield tok;
    }
    yield {
      type: "emission",
      content: "",
      done: true,
      emissionIndex: lastIndex + 1,
      ...usage.inputTokens !== null && { inputTokens: usage.inputTokens },
      ...usage.outputTokens !== null && { outputTokens: usage.outputTokens }
    };
  }
};
function lowercaseKeys(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k.toLowerCase()] = v;
  return out;
}

export { Anthropic };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map