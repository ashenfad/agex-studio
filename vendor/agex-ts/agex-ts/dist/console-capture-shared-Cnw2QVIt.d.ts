import { v as OutputPart, I as ImageFormat, H as HostFnContext } from './types-BdbZoJfu.js';

/**
 * Realm-agnostic surface for host-realm console capture.
 *
 * Sits underneath the two `console-capture.{ts,browser.ts}` variants
 * selected by `package.json`'s `"browser"` export condition. The
 * variants supply `installConsoleProxy` / `runWithCapture` (ALS-backed
 * on Node, stubs in the browser) and re-export everything below.
 *
 * Both channels (the ALS-gated global proxy and the explicit per-fn
 * `ctx.console`) route through `pushArgs` → `detectImage`, so an
 * image-shaped value pushed through either path produces an `image`
 * `OutputPart` indistinguishable from the other. Anything that doesn't
 * detect as an image flows through `safeStringifyArgs` to a `text`
 * part.
 *
 * Image detection rules (`detectImage`):
 * - `{format: 'png'|'jpeg'|'webp', data: <non-empty string>}`
 * - `data:image/(png|jpeg|webp);base64,...` strings
 * - `Uint8Array` whose first ~12 bytes match a PNG / JPEG / WebP magic
 *
 * Mixed args split into ordered parts: `console.log('shot:', bytes)`
 * → text part `'shot:'` + image part. All-text args still join into a
 * single text part (preserves the standard `console.log` convention).
 */

interface CaptureTarget {
    readonly outputs: OutputPart[];
    /** When true, captured calls also mirror to the original real
     *  console (useful when debugging tests). */
    readonly passConsole: boolean;
}
declare const realConsole: Console;
/** Proxy fall-through for the unrouted Console methods (`table`,
 *  `time`, `dir`, `group`, ...). Browser Console implementations
 *  validate the `this` binding against an internal slot and throw
 *  `TypeError: Illegal invocation` if these methods are invoked with
 *  `this === <Proxy>`. Re-binding to `realConsole` before returning
 *  the function makes the call site's implicit `this` harmless. */
declare function reflectBoundToReal(target: object, prop: string | symbol, receiver: unknown): unknown;
/** Build a per-host-fn context. Used by registered fns that opt in via
 *  `wantsContext: true`. The console closes over `outputs` directly
 *  (no ALS lookup) so it works in browser hosts too. */
declare function makeHostFnContext(args: {
    outputs: OutputPart[];
    signal: AbortSignal;
    passConsole?: boolean;
}): HostFnContext;
/** Walk `args`, route image-shaped values to `image` parts and
 *  everything else to a single `text` part (joined per console.log
 *  convention). Mixed args split: text-then-image-then-text yields
 *  three parts in order. Non-`log` levels prefix the text part with
 *  `[level]` for parity with the worker's in-realm console behavior. */
declare function pushArgs(target: CaptureTarget, level: 'log' | 'warn' | 'error' | 'info', args: ReadonlyArray<unknown>): void;
/** Three-rule image detector. Returns `null` for non-image values. */
declare function detectImage(value: unknown): {
    format: ImageFormat;
    data: string;
} | null;
/** Convert bytes to base64. Uses `Buffer` on Node, falls back to
 *  `btoa(String.fromCharCode(...))` in browser/Worker realms. */
declare function bytesToBase64(bytes: Uint8Array): string;
/** Test-only escape hatch: read the captured real console reference
 *  (held before the proxy install). Tests use this to spy on
 *  fall-through behavior without going through the proxy. */
declare function _getRealConsoleForTests(): Console;

export { type CaptureTarget as C, _getRealConsoleForTests as _, reflectBoundToReal as a, bytesToBase64 as b, detectImage as d, makeHostFnContext as m, pushArgs as p, realConsole as r };
