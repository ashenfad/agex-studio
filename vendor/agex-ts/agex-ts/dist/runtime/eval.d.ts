import { R as RuntimeAdapter } from '../types-MortsIN-.js';
import '@standard-schema/spec';
import 'termish-ts';
import '../errors.js';

/**
 * `evalRuntime` — same-realm `RuntimeAdapter` used by tests and by
 * embedders that explicitly opt out of worker isolation.
 *
 * What it does:
 * - Strips TypeScript type annotations via `ts-blank-space` so the
 *   agent can emit idiomatic typed code (the schemas advertise
 *   "TypeScript" — this delivers on that). Whitespace-preserving:
 *   line/column positions in stack traces match the original code.
 * - Evaluates the emitted code via `new AsyncFunction(...)` so the
 *   code can use `await` and the injected names land directly in
 *   scope (no `with` block needed).
 * - Injects the active policy's `fns` and `namespaces` as
 *   identifiers — same as the worker runtime would expose, just
 *   without the message-passing layer.
 * - Injects `taskSuccess`, `taskFail`, `cache`, `fs`
 *   — the standard task-loop bindings the agent's emitted code
 *   expects.
 * - Installs a process-wide ALS-gated `console` proxy so `console.log`
 *   from agent code AND from registered host fns dispatched on this
 *   call chain captures into the result's `outputs` array. Image-
 *   shaped values (`{format,data}`, data URLs, PNG/JPEG/WebP
 *   `Uint8Array`s) become `image` parts; everything else flows
 *   through `safeStringifyArgs` to a `text` part.
 *
 * What it explicitly does NOT do:
 * - No bundling / esbuild — `ts-blank-space` strips types only. Full
 *   TS features that aren't erasable as types (enum, namespace,
 *   decorators, parameter properties) throw a syntax error. Modern
 *   TS style avoids these and the primer flags them.
 * - No sandboxing. The code runs in the host realm with full access
 *   to the surrounding closures. Use this for tests or for trusted
 *   embedders only.
 * - No tick limit. Wall-clock `timeoutMs` is the only enforcement.
 */

interface EvalRuntimeOptions {
    /** Per-emission wall-clock budget in milliseconds. Default `5000`. */
    readonly timeoutMs?: number;
    /** When true, console.* calls also pass through to the host's
     *  console (useful when debugging tests). Default `false`. */
    readonly passConsole?: boolean;
}
declare function evalRuntime(opts?: EvalRuntimeOptions): RuntimeAdapter;

export { type EvalRuntimeOptions, evalRuntime };
