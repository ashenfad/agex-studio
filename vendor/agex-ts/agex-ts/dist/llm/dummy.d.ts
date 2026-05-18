import { L as LLMClient, u as LLMResponse, $ as NeutralTurn, t as LLMRequest, g as TokenChunk, s as LLMConfig } from '../types-BdbZoJfu.js';
import '@standard-schema/spec';
import 'termish-ts';
import '../errors.js';

/**
 * `Dummy` — first-class shipped test double for `LLMClient`.
 *
 * Cycles through a scripted sequence of `LLMResponse | Error` items.
 * An `Error` entry is thrown on that turn — useful for simulating
 * provider failures mid-task.
 *
 * Inspection state on every instance:
 *   `callCount`, `allSystems`, `allEvents`
 * lets tests assert against what the agent sent. Subsequent commits
 * will add `allRenderedMessages` once the wire-format renderer
 * exists; for v1 the render-pass hook is a no-op extension point.
 *
 * Designed to be both internal (agex-ts's own integration tests)
 * and public (downstream consumers writing tests for THEIR agents
 * without spending tokens). Lives in core, not in any provider
 * package, because it has no provider dep.
 */

interface DummyOptions {
    /** Scripted responses cycled by `callCount % len`. An `Error` entry
     *  is thrown on that turn. Defaults to a single one-emission
     *  response that just calls `taskSuccess(null)`. */
    readonly responses?: ReadonlyArray<LLMResponse | Error>;
    /** Surfaced via `dumpConfig()`. */
    readonly model?: string;
    /** Surfaced via `dumpConfig()`. Default `60`. */
    readonly timeoutSeconds?: number;
}
declare class Dummy implements LLMClient {
    readonly model: string;
    readonly timeoutSeconds: number;
    /** Scripted response sequence. */
    responses: ReadonlyArray<LLMResponse | Error>;
    /** Number of `complete()` calls observed. Useful for tests asserting
     *  that the agent's loop made the expected number of turns. */
    callCount: number;
    /** Every `system` string the agent passed in, in order. */
    allSystems: string[];
    /** Every `turns` array the agent passed in, in order. The first
     *  turn is always the per-task user message. Tests inspect
     *  these to verify what the agent actually saw. */
    allTurns: NeutralTurn[][];
    constructor(opts?: DummyOptions);
    complete(request: LLMRequest, signal?: AbortSignal): AsyncIterable<TokenChunk>;
    dumpConfig(): LLMConfig;
    static fromConfig(config: LLMConfig): Dummy;
}

export { Dummy, type DummyOptions };
