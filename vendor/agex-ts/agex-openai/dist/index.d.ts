import { LLMClient, LLMRequest, TokenChunk, LLMConfig } from 'agex-ts/types';

/**
 * OpenAI Chat Completions client implementing agex-ts's `LLMClient`.
 *
 * Builds the request from `LLMRequest` (system + neutral turns),
 * fires `fetch` with `stream: true`, and runs the response through
 * the SSE → stream translator → tool-call parser pipeline to yield
 * `TokenChunk`s.
 *
 * `baseUrl` override is the entry point for OpenAI-compatible
 * servers (ollama, vLLM, LM Studio, OpenRouter, Together, etc.).
 * Auth is `Authorization: Bearer <key>`; many local servers accept
 * any non-empty key (we send 'sk-no-key' if none provided so the
 * header is well-formed).
 *
 * Defaults set: `tool_choice: 'required'` so the model emits at
 * least one tool call per turn (parallel to Anthropic's
 * `tool_choice: 'any'`); `stream_options: { include_usage: true }`
 * so the trailing chunk carries token totals.
 *
 * Out of scope (v1):
 *   - Responses API (gpt-5 / o-series). Use Chat Completions models.
 *   - OpenRouter `reasoning_details` round-trip.
 */

interface OpenAIOptions {
    /** Model id. Defaults to `gpt-4o-mini`. For OpenAI-compatible
     *  servers (ollama, vLLM, etc.) pass the model name they expose. */
    readonly model?: string;
    /** API key. Sent as `Authorization: Bearer <key>`. Required for
     *  the public OpenAI endpoint; may be unused/dummy for local
     *  servers (we always send a header so picky proxies don't 401). */
    readonly apiKey?: string;
    /** API base URL. Defaults to `https://api.openai.com/v1`. Set
     *  this to point at any OpenAI-compatible server:
     *    - ollama: `http://localhost:11434/v1`
     *    - vLLM:   `http://localhost:8000/v1`
     *    - LM Studio: `http://localhost:1234/v1`
     *    - OpenRouter: `https://openrouter.ai/api/v1`
     *    - Together: `https://api.together.xyz/v1` */
    readonly baseUrl?: string;
    /** Per-request timeout. Defaults to 90s. */
    readonly timeoutMs?: number;
    /** Cap on output tokens. Defaults to 16k. */
    readonly maxTokens?: number;
    /** Force the model to emit a tool call each turn. Defaults to
     *  `true` (sends `tool_choice: 'required'`). Set false to allow
     *  text-only turns — useful with models that don't reliably
     *  follow `required` (notably some local models). */
    readonly forceToolUse?: boolean;
    /** Extra fields merged into the request body (e.g. `temperature`,
     *  `top_p`, `seed`, `response_format`). Wins over computed
     *  defaults. */
    readonly extras?: Readonly<Record<string, unknown>>;
    /** Override `fetch` for tests / custom transports. */
    readonly fetchImpl?: typeof fetch;
    /**
     * Custom HTTP headers, merged into the provider's defaults.
     *
     * - String value sets / overrides the header (e.g. supplying a
     *   non-Bearer auth scheme some compat endpoints require).
     * - `null` value DELETES a default header. Useful for compat
     *   endpoints that reject certain headers in CORS preflight.
     *
     * Header names are lowercased to match `fetch`'s case-insensitive
     * handling — both `'Authorization'` and `'authorization'` override
     * the same default. For more invasive request shaping (URL
     * rewriting, body transforms), use `fetchImpl` instead.
     */
    readonly headers?: Readonly<Record<string, string | null>>;
}
declare class OpenAI implements LLMClient {
    readonly model: string;
    private readonly apiKey;
    private readonly baseUrl;
    private readonly timeoutMs;
    private readonly maxTokens;
    private readonly forceToolUse;
    private readonly extras;
    private readonly fetchImpl;
    private readonly headerOverrides;
    constructor(opts?: OpenAIOptions);
    complete(request: LLMRequest, signal?: AbortSignal): AsyncIterable<TokenChunk>;
    dumpConfig(): LLMConfig;
    private buildBody;
    private buildHeaders;
    private streamOnce;
}

export { OpenAI, type OpenAIOptions };
