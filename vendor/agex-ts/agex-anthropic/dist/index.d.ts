import { LLMClient, LLMRequest, TokenChunk, LLMConfig } from 'agex-ts/types';

/**
 * Anthropic Messages API client implementing agex-ts's `LLMClient`.
 *
 * Builds the request from the agex `LLMRequest` (system + neutral
 * turns), applies prompt caching breakpoints, defaults extended
 * thinking on and `tool_choice` to `any`, fires `fetch` with
 * `stream: true`, and runs the response through the SSE → stream
 * translator → tool-call parser pipeline to yield `TokenChunk`s.
 *
 * No SDK dependency — `fetch` only, runs anywhere it's available
 * (Node 20+, browsers, edge runtimes).
 */

interface AnthropicOptions {
    /** Model id. Defaults to `claude-sonnet-4-5`. */
    readonly model?: string;
    /** API key. Sent as `x-api-key`. Required for the public endpoint;
     *  optional when paired with a custom `fetchImpl` that injects auth
     *  on the way out (e.g. a proxy bridge). */
    readonly apiKey?: string;
    /** API base URL. Defaults to `https://api.anthropic.com/v1`. */
    readonly baseUrl?: string;
    /** Per-request timeout. Defaults to 90s. */
    readonly timeoutMs?: number;
    /** Enable Claude's extended thinking (Claude 4+). When on, the
     *  model emits native thinking blocks (with replayable signatures)
     *  and the action tool schemas drop the `thinking` parameter.
     *  Defaults to `true`. */
    readonly nativeThinking?: boolean;
    /** Token budget for extended thinking. Anthropic requires >= 1024.
     *  Ignored when `nativeThinking` is false. Defaults to 2048. */
    readonly thinkingBudget?: number;
    /** Cap on output tokens. Defaults to 16k. */
    readonly maxTokens?: number;
    /** Extra fields merged into the request body (e.g. `temperature`,
     *  `top_p`, `top_k`). Wins over computed defaults. */
    readonly extras?: Readonly<Record<string, unknown>>;
    /** Browser-flavored opt-in: send the
     *  `anthropic-dangerous-direct-browser-access: true` header so the
     *  request is allowed to come straight from a browser context.
     *  Anthropic only honors this in trusted browser contexts. */
    readonly browserDirectAccess?: boolean;
    /** Override `fetch` for tests / custom transports. Defaults to the
     *  global `fetch`. */
    readonly fetchImpl?: typeof fetch;
    /**
     * Custom HTTP headers, merged into the provider's defaults.
     *
     * - String value sets / overrides the header.
     * - `null` value DELETES a default header. Useful for compat
     *   endpoints that don't allow certain headers in CORS preflight
     *   (e.g. OpenRouter's Anthropic-compat endpoint rejects
     *   `anthropic-version`; pass `headers: { 'anthropic-version': null }`).
     *
     * Header names are lowercased to match `fetch`'s case-insensitive
     * handling — both `'Content-Type'` and `'content-type'` override the
     * same default. For more invasive request shaping (auth schemes,
     * URL rewriting, body transforms), use `fetchImpl` instead.
     */
    readonly headers?: Readonly<Record<string, string | null>>;
}
declare class Anthropic implements LLMClient {
    readonly model: string;
    private readonly apiKey;
    private readonly baseUrl;
    private readonly timeoutMs;
    private readonly nativeThinking;
    private readonly thinkingBudget;
    private readonly maxTokens;
    private readonly extras;
    private readonly browserDirectAccess;
    private readonly fetchImpl;
    private readonly headerOverrides;
    constructor(opts?: AnthropicOptions);
    complete(request: LLMRequest, signal?: AbortSignal): AsyncIterable<TokenChunk>;
    dumpConfig(): LLMConfig;
    private buildBody;
    private buildHeaders;
    private streamOnce;
}

export { Anthropic, type AnthropicOptions };
