import { C as CaptureTarget } from '../console-capture-shared-Bo448HHt.js';
export { _ as _getRealConsoleForTests, b as bytesToBase64, d as detectImage, m as makeHostFnContext, p as pushArgs, r as realConsole, a as reflectBoundToReal } from '../console-capture-shared-Bo448HHt.js';
export { H as HostFnContext } from '../types-CO8Ko6DJ.js';
import '@standard-schema/spec';
import 'termish-ts';
import '../errors.js';

/**
 * Host-realm console capture — Node variant.
 *
 * Two channels share the same `OutputPart` pipeline:
 *
 * 1. **Implicit (ALS-gated global proxy):** `installConsoleProxy()`
 *    swaps `globalThis.console` once for a Proxy that reads its capture
 *    target from `AsyncLocalStorage`. Inside `runWithCapture(target,
 *    fn)`, every `console.log` / `.warn` / `.error` / `.info` anywhere
 *    in the host process — agent code, registered host fns, helper
 *    libraries — pushes into `target.outputs`. Outside any active ALS
 *    context, calls fall through to the original real console.
 *
 * 2. **Explicit (per-fn `ctx.console`):** `makeHostFnContext({outputs,
 *    signal})` builds a `HostFnContext` whose `.console` closes over
 *    the outputs array directly (no ALS). Used by registered host fns
 *    that opt in via `wantsContext: true` — required when the host
 *    realm is a browser (no `node:async_hooks`), useful elsewhere when
 *    the embedder wants the explicit channel.
 *
 * The realm-agnostic surface — `detectImage`, `pushArgs`,
 * `bytesToBase64`, `makeHostFnContext`, etc. — lives in
 * `console-capture-shared` and is re-exported below.
 */

/** Install the global console proxy. Idempotent — calling repeatedly is
 *  a no-op after the first install. */
declare function installConsoleProxy(): void;
/** Run `fn` with `target` bound as the active capture target. Any
 *  `console.log` (etc.) on the proxy that fires synchronously, in an
 *  awaited continuation, or through a registered host fn called from
 *  this chain pushes into `target.outputs`. */
declare function runWithCapture<T>(target: CaptureTarget, fn: () => Promise<T>): Promise<T>;

export { CaptureTarget, installConsoleProxy, runWithCapture };
