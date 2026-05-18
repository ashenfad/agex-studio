import { a0 as ToolName, g as TokenChunk } from '../types-MortsIN-.js';
import '@standard-schema/spec';
import 'termish-ts';
import '../errors.js';

/**
 * Provider-agnostic event vocabulary that the tool-call parser
 * consumes. Each provider package translates its native streaming
 * events (Anthropic `content_block_*`, OpenAI `delta.tool_calls`,
 * Gemini `parts[]`) into this small union; the shared parser then
 * turns it into the `TokenChunk` stream the agent loop knows about.
 *
 * The vocabulary is deliberately minimal: just the four cadences
 * needed to assemble agex-ts emissions across providers — tool
 * calls (start / arg deltas / end), text content (deltas + final
 * part), thinking content (deltas + final part with optional
 * signature), and a usage-token holder that providers populate as
 * the stream progresses.
 */

interface ToolCallStart {
    readonly type: 'toolCallStart';
    readonly callId: string;
    readonly toolName: ToolName;
    /** Per-call opaque signature the provider wants round-tripped on
     *  subsequent turns (Gemini's `thoughtSignature`). The parser
     *  threads this onto the built Emission so the renderer can place
     *  it correctly on the next request. `undefined` for providers
     *  that don't sign (Anthropic puts signatures on separate
     *  thinking blocks; OpenAI Chat Completions doesn't sign). */
    readonly signature?: Uint8Array;
}
interface ToolCallArgDelta {
    readonly type: 'toolCallArgDelta';
    readonly callId: string;
    readonly argumentChunk: string;
}
interface ToolCallEnd {
    readonly type: 'toolCallEnd';
    readonly callId: string;
}
interface TextDelta {
    readonly type: 'textDelta';
    readonly content: string;
}
interface TextPartEvent {
    readonly type: 'textPart';
    readonly text: string;
}
interface ThinkingDelta {
    readonly type: 'thinkingDelta';
    readonly content: string;
}
interface ThinkingPartEvent {
    readonly type: 'thinkingPart';
    readonly text?: string;
    readonly signature?: Uint8Array;
    readonly redacted?: boolean;
}
type ToolCallEvent = ToolCallStart | ToolCallArgDelta | ToolCallEnd | TextDelta | TextPartEvent | ThinkingDelta | ThinkingPartEvent;
/** Shared mutable holder providers populate from their stream's
 *  usage events (Anthropic message_start/delta, OpenAI's final
 *  chunk.usage, Gemini's usageMetadata). Read by the client after
 *  the stream closes to surface token totals on the trailing
 *  TokenChunk. */
interface UsageHolder {
    inputTokens: number | null;
    outputTokens: number | null;
}

/**
 * Streaming JSON string-value extractor.
 *
 * Parses a streaming JSON object incrementally and yields deltas for
 * each top-level string value as its decoded content grows.
 * Non-string values (numbers, booleans, null, nested arrays/objects)
 * are parsed and skipped — no deltas emitted for them. The final
 * authoritative parse happens after the stream closes via
 * `JSON.parse` on the buffered raw text.
 *
 * Use case: Anthropic streams a tool_use block's `input` as
 * `input_json_delta` chunks that may split at any byte boundary,
 * including mid-escape and mid-`\\uXXXX`. Feeding those chunks
 * through `JsonStringExtractor` lets the agent stream the model's
 * `code` / `commands` / `thinking` / `title` strings to the UI in
 * real time, before the tool call finishes.
 *
 * TS port of agex-py's `agex.llm.formats.json_stream`.
 */
interface JsonStringDelta {
    readonly key: string;
    readonly content: string;
    readonly done: boolean;
}
declare class JsonStringExtractor {
    private state;
    private currentKey;
    private keyBuf;
    private valueBuf;
    private escape;
    private unicodeHex;
    private unicodePending;
    private skipDepth;
    private skipInStr;
    private skipEsc;
    /** Feed a chunk of JSON text; collect deltas as strings grow/close.
     *  Tolerant of chunk boundaries at any position, including
     *  mid-escape and mid-`\\uXXXX`. */
    feed(chunk: string): JsonStringDelta[];
    private consume;
    private consumeInString;
    private consumeSkip;
}

/**
 * Convert a stream of provider-agnostic `ToolCallEvent`s into the
 * `TokenChunk`s that agex-ts's task loop consumes.
 *
 * Two cadences:
 *
 *  1. **Streaming chunks** — for each tool call's JSON args, the
 *     `JsonStringExtractor` emits per-key string deltas as the model
 *     writes. Each delta becomes a `TokenChunk` whose `type` is the
 *     per-tool mapped name (`title` / `thinking` / `ts` / `terminal`
 *     / `filePath` / `fileSearch` / `fileContent`) so callers can
 *     forward UI text in real time via `onToken`.
 *
 *  2. **Final emission** — at `ToolCallEnd`, we re-parse the buffered
 *     raw JSON and build the authoritative `Emission`, then emit one
 *     final `TokenChunk { type: 'emission', done: true, emission }`
 *     that the task loop slots into the `ActionEvent`. Re-parsing
 *     covers non-string fields (`mode`, `matchAll`) that the
 *     streaming extractor skips.
 *
 *  TextPart and ThinkingPart events from the translator each emit
 *  their own `emission` token at a fresh emission index, so they
 *  ride alongside tool calls in the order the model produced them.
 */

declare function parseToolEvents(events: AsyncIterable<ToolCallEvent>): AsyncIterable<TokenChunk>;

/**
 * Server-Sent Events (SSE) line parser.
 *
 * Reads a `ReadableStream<Uint8Array>` (the body of a `fetch` response
 * with `stream: true`) and yields the payload of each `data:` line.
 * Skips comments, empty lines, and other SSE fields. Stops on
 * `[DONE]` per the SSE-with-LLMs convention.
 *
 * Buffer-bounded so a malformed stream that never emits a newline
 * can't grow unbounded.
 */
declare function parseSseEvents(body: ReadableStream<Uint8Array>): AsyncIterable<string>;

/**
 * Small HTTP / streaming helpers shared by every LLM provider
 * package. Lifted out of each provider's `client.ts` so bug fixes
 * (and the SSE-payload-parsing convention) live in one place.
 */
/** Walk an SSE-line iterator (each yielded string is one `data:`
 *  payload), JSON-parse each non-empty payload, and yield the
 *  resulting object. Drops payloads that fail to parse — providers
 *  occasionally emit keep-alive comments or unexpected text frames
 *  that aren't worth crashing the stream over. */
declare function sseLinesToEventDicts(lines: AsyncIterable<string>): AsyncIterable<unknown>;
/** Read a `fetch` response body as text without throwing. Used to
 *  surface error-response bodies in thrown errors when an API call
 *  fails. */
declare function safeReadText(response: Response): Promise<string>;
/** Best-effort heuristic for "is this a transient network error
 *  worth retrying?" `fetch` rejects on connection errors with a
 *  `TypeError` whose message names the cause; DNS failures, RST
 *  resets, and TLS errors all surface as TypeError. `AbortError`
 *  comes from timeouts and explicit cancellation — those are NOT
 *  transient (caller intent is "stop"). */
declare function isTransientNetworkError(err: unknown): boolean;
/** Promise-based sleep that honors an AbortSignal. Used between
 *  retry attempts. Rejects with an aborted error if the signal
 *  fires; otherwise resolves after `ms`. */
declare function sleep(ms: number, signal?: AbortSignal): Promise<void>;

export { type JsonStringDelta, JsonStringExtractor, type TextDelta, type TextPartEvent, type ThinkingDelta, type ThinkingPartEvent, type ToolCallArgDelta, type ToolCallEnd, type ToolCallEvent, type ToolCallStart, type UsageHolder, isTransientNetworkError, parseSseEvents, parseToolEvents, safeReadText, sleep, sseLinesToEventDicts };
