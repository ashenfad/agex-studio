import { C as CaptureTarget } from '../console-capture-shared-Bo448HHt.js';
export { _ as _getRealConsoleForTests, b as bytesToBase64, d as detectImage, m as makeHostFnContext, p as pushArgs, r as realConsole, a as reflectBoundToReal } from '../console-capture-shared-Bo448HHt.js';
export { H as HostFnContext } from '../types-CO8Ko6DJ.js';
import '@standard-schema/spec';
import 'termish-ts';
import '../errors.js';

/**
 * Host-realm console capture — browser variant.
 *
 * `node:async_hooks` (and therefore `AsyncLocalStorage`) doesn't exist
 * in browsers / Workers, so the implicit capture path can't work. This
 * module ships:
 *
 * - `installConsoleProxy()` as a no-op (no ALS to gate on).
 * - `runWithCapture(target, fn)` as `fn()` — runs the user code
 *   straight through with no per-call store. Agent-code `console.log`
 *   inside the worker realm continues to capture via the in-Worker
 *   `makeConsole` (which doesn't depend on this module). Host-fn
 *   capture in the host realm requires the registered fn to opt in to
 *   `wantsContext: true` and use `ctx.console` — that path lives
 *   entirely in `makeHostFnContext` and works here.
 * - The full `pushArgs` / `detectImage` / `bytesToBase64` /
 *   `makeHostFnContext` surface unchanged, re-exported from
 *   `console-capture-shared`.
 *
 * Selected via `package.json`'s `"browser"` export condition.
 */

declare function installConsoleProxy(): void;
declare function runWithCapture<T>(_target: CaptureTarget, fn: () => Promise<T>): Promise<T>;

export { CaptureTarget, installConsoleProxy, runWithCapture };
