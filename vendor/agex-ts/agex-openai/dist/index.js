import { isTransientNetworkError, sleep, safeReadText, parseSseEvents, sseLinesToEventDicts, parseToolEvents } from 'agex-ts/providers';
import { toolSchemas } from 'agex-ts/render';

// src/client.ts

// src/adapter.ts
function schemasToOpenAITools(schemas) {
  return schemas.map((s) => ({
    type: "function",
    function: {
      name: s.name,
      description: s.description,
      parameters: s.parameters
    }
  }));
}
function lowerNeutralTurns(turns) {
  const out = [];
  for (const turn of turns) {
    if (turn.role === "assistant") {
      out.push(lowerAssistantTurn(turn.content));
    } else {
      out.push(...lowerUserTurn(turn.content));
    }
  }
  return out;
}
function lowerAssistantTurn(parts) {
  const textBits = [];
  const toolCalls = [];
  for (const part of parts) {
    if (part.type === "text") {
      textBits.push(part.text);
    } else if (part.type === "thinking") ; else if (part.type === "toolUse") {
      toolCalls.push(lowerToolUse(part));
    }
  }
  const msg = {
    role: "assistant",
    content: textBits.length > 0 ? textBits.join("") : null,
    ...toolCalls.length > 0 && { tool_calls: toolCalls }
  };
  return msg;
}
function lowerToolUse(part) {
  return {
    id: part.toolUseId,
    type: "function",
    function: {
      name: part.toolName,
      arguments: JSON.stringify(part.input)
    }
  };
}
function lowerUserTurn(parts) {
  const out = [];
  const trailing = [];
  for (const part of parts) {
    if (part.type === "toolResult") {
      out.push(lowerToolResult(part));
    } else {
      trailing.push(part);
    }
  }
  if (trailing.length > 0) {
    out.push(lowerTrailingUserContent(trailing));
  }
  return out;
}
function lowerToolResult(part) {
  const bits = [];
  for (const inner of part.content) {
    if (inner.type === "text") bits.push(inner.text);
    else bits.push("[image]");
  }
  return {
    role: "tool",
    tool_call_id: part.toolUseId,
    content: bits.join("\n")
  };
}
function lowerTrailingUserContent(parts) {
  const allText = parts.every((p) => p.type === "text");
  if (allText) {
    return {
      role: "user",
      content: parts.map((p) => p.text).join("")
    };
  }
  const content = [];
  for (const part of parts) {
    if (part.type === "text") {
      content.push({ type: "text", text: part.text });
    } else if (part.type === "image") {
      content.push(lowerImage(part));
    }
  }
  return { role: "user", content };
}
function lowerImage(part) {
  const mediaType = mediaTypeFor(part.format);
  return {
    type: "image_url",
    image_url: { url: `data:${mediaType};base64,${part.data}` }
  };
}
function mediaTypeFor(format) {
  switch (format) {
    case "png":
      return "image/png";
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
  }
}

// src/stream.ts
function newState() {
  return { openByIndex: /* @__PURE__ */ new Map(), textBuf: [] };
}
async function* translateOpenAIStream(events, usage) {
  const state = newState();
  for await (const raw of events) {
    const ev = raw ?? {};
    captureUsage(ev, usage);
    if (isErrorChunk(ev)) {
      throw new Error(`OpenAI stream error: ${describeError(ev)}`);
    }
    yield* handleChunk(state, ev);
  }
  yield* close(state);
}
function* handleChunk(state, ev) {
  const choices = ev.choices;
  if (choices === void 0 || choices.length === 0) return;
  const choice = choices[0];
  const delta = choice.delta ?? {};
  const content = delta.content;
  if (typeof content === "string" && content.length > 0) {
    state.textBuf.push(content);
    yield { type: "textDelta", content };
  }
  const toolCalls = delta.tool_calls;
  if (toolCalls !== void 0) {
    for (const tc of toolCalls) {
      const idx = tc.index;
      if (idx === void 0) continue;
      let open = state.openByIndex.get(idx);
      if (open === void 0) {
        const id = tc.id ?? `call_${idx}`;
        const fn2 = tc.function ?? {};
        const name = fn2.name ?? "";
        open = { callId: id, toolName: name };
        state.openByIndex.set(idx, open);
        yield { type: "toolCallStart", callId: id, toolName: name };
      }
      const fn = tc.function ?? {};
      const args = fn.arguments;
      if (args !== void 0 && args.length > 0) {
        yield { type: "toolCallArgDelta", callId: open.callId, argumentChunk: args };
      }
    }
  }
}
function* close(state) {
  for (const open of state.openByIndex.values()) {
    yield { type: "toolCallEnd", callId: open.callId };
  }
  state.openByIndex.clear();
  if (state.textBuf.length > 0) {
    yield { type: "textPart", text: state.textBuf.join("") };
    state.textBuf = [];
  }
}
function captureUsage(ev, usage) {
  if (usage === void 0) return;
  const raw = ev.usage;
  if (raw === void 0 || raw === null || typeof raw !== "object") return;
  const u = raw;
  const promptTokens = u.prompt_tokens;
  const completionTokens = u.completion_tokens;
  if (typeof promptTokens === "number") usage.inputTokens = promptTokens;
  if (typeof completionTokens === "number") usage.outputTokens = completionTokens;
}
function isErrorChunk(ev) {
  return ev.error !== void 0 && ev.error !== null;
}
function describeError(ev) {
  const err = ev.error;
  if (err === void 0) return "unknown";
  const msg = err.message ?? err.type ?? err.code;
  return typeof msg === "string" ? msg : "unknown";
}

// src/client.ts
var DEFAULT_BASE_URL = "https://api.openai.com/v1";
var DEFAULT_MODEL = "gpt-4o-mini";
var DEFAULT_MAX_TOKENS = 16384;
var DEFAULT_TIMEOUT_MS = 9e4;
var STREAM_MAX_RETRIES = 2;
var RETRY_BACKOFF_MS = 1e3;
var OpenAI = class {
  model;
  apiKey;
  baseUrl;
  timeoutMs;
  maxTokens;
  forceToolUse;
  extras;
  fetchImpl;
  headerOverrides;
  constructor(opts = {}) {
    this.model = opts.model ?? DEFAULT_MODEL;
    this.apiKey = opts.apiKey ?? "";
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.forceToolUse = opts.forceToolUse ?? true;
    this.extras = opts.extras ?? {};
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
    this.headerOverrides = lowercaseKeys(opts.headers ?? {});
  }
  // ---------- LLMClient surface ----------
  async *complete(request, signal) {
    const body = this.buildBody(request);
    const url = `${this.baseUrl}/chat/completions`;
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
      provider: "openai",
      model: this.model,
      timeoutSeconds: this.timeoutMs / 1e3,
      extras: {
        baseUrl: this.baseUrl,
        maxTokens: this.maxTokens,
        forceToolUse: this.forceToolUse,
        ...this.extras
      }
    };
  }
  // ---------- Request construction ----------
  buildBody(request) {
    const lowered = lowerNeutralTurns(request.turns);
    const messages = [{ role: "system", content: request.system }, ...lowered];
    const tools = schemasToOpenAITools(toolSchemas());
    const body = {
      model: this.model,
      messages,
      tools,
      // gpt-5* and o-series reasoning models reject `max_tokens` and
      // require `max_completion_tokens` instead (it disambiguates
      // visible-output tokens from internal reasoning tokens). Older
      // models accept either; we send the right one based on model
      // name. Local servers (ollama, vLLM, etc.) using older model
      // names get `max_tokens` and stay happy.
      [tokenLimitField(this.model)]: this.maxTokens,
      stream: true,
      // include_usage = true makes the final chunk carry the
      // prompt/completion token counts so the chaptering trigger
      // works correctly.
      stream_options: { include_usage: true }
    };
    if (this.forceToolUse) {
      body.tool_choice = "required";
    }
    Object.assign(body, this.extras);
    return body;
  }
  buildHeaders() {
    const h = {
      "content-type": "application/json",
      // Send a header even when no key was provided so picky
      // local-model proxies that require *some* auth header don't
      // 401. The string is meaningless to them.
      authorization: `Bearer ${this.apiKey || "sk-no-key"}`
    };
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
        `OpenAI API error ${response.status} ${response.statusText}: ${text || "(empty body)"}`
      );
    }
    if (response.body === null) {
      throw new Error("OpenAI API returned no response body");
    }
    const usage = { inputTokens: null, outputTokens: null };
    const sseLines = parseSseEvents(response.body);
    const events = sseLinesToEventDicts(sseLines);
    const toolCallEvents = translateOpenAIStream(events, usage);
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
function tokenLimitField(model) {
  if (/^(gpt-5|o[1-9])/.test(model)) return "max_completion_tokens";
  return "max_tokens";
}
function lowercaseKeys(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k.toLowerCase()] = v;
  return out;
}

export { OpenAI };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map