/**
 * Error hierarchy for agex-ts.
 *
 * Two flavors:
 *
 * 1. **Task-control errors** (`TaskFailError`, `CancelledError`) are
 *    thrown from inside a `ts` emission by the agent's call to the
 *    injected `taskFail()` (or by the runtime when a task is
 *    cancelled). They carry a brand symbol so the runtime adapter
 *    can recognize them across realms (a worker can't share
 *    `instanceof` with the host, but it can inspect a property tag).
 *
 * 2. **Framework errors** (`AgentError` and its subclasses) are
 *    thrown by agex-ts itself — registration violations, runtime
 *    transport failures, schema mismatches. Provider/runtime errors
 *    classify as `TransientError` (retry candidate) or `FatalError`
 *    (reraise immediately).
 */
/** Brand symbol identifying task-control errors across realms. */
declare const TASK_CONTROL_BRAND = "__agex_task_control__";
interface BrandedTaskError extends Error {
    readonly [TASK_CONTROL_BRAND]: 'fail' | 'cancelled';
}
/** Returns true if `e` is a task-control error from any realm. */
declare function isTaskControlError(e: unknown): e is BrandedTaskError;
/** Thrown by `taskFail(message)` inside a `ts` emission. */
declare class TaskFailError extends Error {
    readonly [TASK_CONTROL_BRAND]: "fail";
    constructor(message: string);
}
/** Raised when a task is aborted via the host `AbortSignal`. */
declare class CancelledError extends Error {
    readonly [TASK_CONTROL_BRAND]: "cancelled";
    constructor(message?: string);
}
/**
 * Cross-realm cancellation check.
 *
 * `instanceof CancelledError` only works for cancellations constructed
 * on the host side. Errors crossing a worker boundary lose their
 * prototype: `agex-runtime-worker` builds a plain `Error` with
 * `name = 'CancelledError'` inside the worker (see `makeCancelledError`),
 * serializes it across `postMessage`, and the host rebuilds it as a
 * plain `Error` with the right `name` but no `CancelledError` prototype.
 * `instanceof` would miss those, leaving the dispatcher to misclassify
 * a worker-originated cancellation as a recoverable agent-code error.
 *
 * Use this helper at any check-by-name site; reserve `instanceof
 * CancelledError` for places that genuinely care about the host-side
 * type identity.
 */
declare function isCancelledError(e: unknown): boolean;
/** Base for framework-internal errors. */
declare class AgentError extends Error {
    constructor(message: string);
}
/** Validation failed on registration input (bad include/exclude pattern,
 *  missing required field, conflicting names, etc.). */
declare class RegistrationError extends AgentError {
    constructor(message: string);
}
/** Schema validation failed on a task input or output. */
declare class SchemaError extends AgentError {
    readonly issues: ReadonlyArray<{
        path: ReadonlyArray<PropertyKey>;
        message: string;
    }>;
    constructor(message: string, issues: ReadonlyArray<{
        path: ReadonlyArray<PropertyKey>;
        message: string;
    }>);
}
/** Provider/runtime error worth retrying (timeouts, rate limits,
 *  transient network failures). The agent loop reads the optional
 *  `retryAfterMs` hint when scheduling retry. */
declare class TransientError extends AgentError {
    readonly retryAfterMs?: number;
    constructor(message: string, opts?: {
        cause?: unknown;
        retryAfterMs?: number;
    });
}
/** Provider/runtime error that should be reraised, not retried
 *  (4xx, parse errors, configuration errors). */
declare class FatalError extends AgentError {
    constructor(message: string, opts?: {
        cause?: unknown;
    });
}

export { AgentError, type BrandedTaskError, CancelledError, FatalError, RegistrationError, SchemaError, TASK_CONTROL_BRAND, TaskFailError, TransientError, isCancelledError, isTaskControlError };
