import { RuntimeAdapter } from 'agex-ts/types';

/**
 * TS-to-JS transform run on the host *before* code is shipped to the
 * worker.
 *
 * Default: `ts-blank-space`, the same lightweight type-stripper
 * `evalRuntime` uses. Whitespace-preserving, zero wasm download,
 * runs in microseconds. Throws on non-erasable TS (enum, namespace,
 * decorators, parameter properties) — fine because the agent's primer
 * already steers away from those forms.
 *
 * Embedders that need fuller TS coverage (or full bundling for
 * `helpers/*.ts` imports later) can pass their own `transform`:
 * `(code) => string | Promise<string>`. agex-studio plans to wire
 * `esbuild-wasm` here. The runtime-worker package itself stays
 * dependency-light by not importing esbuild.
 *
 * Running the transform on the host (not inside the worker) keeps
 * the worker bundle tiny, surfaces syntax errors before we pay the
 * cost of message-passing, and lets embedders amortize one-time
 * setup (esbuild-wasm initialization) on their side instead of
 * inside every fresh worker.
 */
/** Function signature for a TS → JS transform. */
type TransformFn = (code: string) => string | Promise<string>;
declare const defaultTransform: TransformFn;

/**
 * `workerRuntime` — `RuntimeAdapter` that runs each `ts` emission
 * inside a Web Worker.
 *
 * High-level flow per `execute`:
 *
 *   1. Lazily spawn a Worker (on first call, or after a previous
 *      worker was terminated by timeout / abort). Wait for the
 *      worker to post `ready`.
 *   2. Run the configured `transform` on the host side (default
 *      `ts-blank-space`). Surface syntax errors before paying
 *      message-passing cost.
 *   3. `postMessage({ type: 'execute', code, ... })`. Stream
 *      incoming `output` messages into a local buffer. Resolve when
 *      a `result` message arrives.
 *   4. If the per-emission `timeoutMs` fires *or* `ctx.signal`
 *      aborts: `worker.terminate()`, drop the worker, return an
 *      `ExecResult` carrying any outputs collected before the kill
 *      plus a `CancelledError` (for abort) or generic timeout
 *      `Error` (for the budget). The next `execute` spawns a fresh
 *      worker.
 *
 * Cooperative cancellation is a follow-up — today the adapter only
 * does the hard-terminate path, which is enough to honor wall-clock
 * budgets and external aborts.
 *
 * What gets bridged today: `fs` / `cache` (per-execute context),
 * registered fns, registered namespaces, and registered classes.
 * For classes the agent sees a Proxy-backed constructor: `new
 * MyClass(args)` posts `newInstance` to the host (which parks a
 * real instance in the per-execute table), and method calls on the
 * Proxy post `instanceCall` carrying the assigned `instanceId`.
 * Static methods on the class itself dispatch through `target:
 * 'cls'`. Instance state lives entirely host-side; per-emission
 * cleanup releases everything when the execute settles.
 */

interface WorkerRuntimeOptions {
    /** URL the host should hand to `new Worker(...)`. Defaults to the
     *  bundled `worker.js` shipped alongside this module — resolves
     *  via `new URL('./worker.js', import.meta.url)`, which Vite,
     *  webpack, esbuild, and modern browsers all understand. Override
     *  if you're shipping the worker file from a different origin or
     *  embedding agex inside an app with a custom asset pipeline. */
    readonly workerUrl?: string | URL;
    /** TS → JS transform run on the host before code is shipped to
     *  the worker. Defaults to `ts-blank-space` (lightweight type
     *  stripping; matches `evalRuntime`). Pass your own to swap in
     *  e.g. `esbuild-wasm` for fuller TS coverage. */
    readonly transform?: TransformFn;
    /** Per-emission wall-clock budget, in milliseconds. Hitting it
     *  terminates the worker; the next emission spawns a fresh one.
     *  Default `5000`. */
    readonly timeoutMs?: number;
    /**
     * Route the agent's `fetch(...)` calls for path-shaped URLs (no
     * scheme, starts with `/`) to the agent's VFS. Recovers agex-py's
     * "registered libraries see the VFS" property — Arquero's
     * `loadCSV`, Plotly's loaders, and any other library function
     * that internally fetches a URL will read from VFS instead of
     * hitting the host's HTTP origin.
     *
     * - `true` — every path-absolute URL is tried against VFS first;
     *   falls through to real network on miss. Use when the agent
     *   doesn't talk to a same-origin API (the common case).
     * - `string[]` — only these prefixes go to VFS; everything else
     *   (including `/api/...`) passes through unchanged. Use when
     *   your app serves an API the agent might want to call. A
     *   path that matches a prefix but isn't in VFS returns a 404
     *   Response (it was an explicit miss, not "fall through and
     *   try the network").
     * - `false` (default) — current behavior: every fetch hits the
     *   network, agent uses `fs.read` explicitly for VFS access.
     *
     * Only path-absolute URLs (`/foo`) are considered — relative
     * (`foo`, `./foo`) and scheme-relative (`//host/foo`) URLs are
     * always passed through to the real `fetch`.
     *
     * Only `GET` and `HEAD` requests are routed; other methods always
     * pass through to real `fetch` (writing to VFS via fetch is
     * outside the natural shape).
     *
     * When enabled, a short note is appended to the agent's primer
     * so the agent knows the VFS is reachable via `fetch` (and via
     * registered libraries that use it).
     */
    readonly routeFetchToVfs?: boolean | ReadonlyArray<string>;
}
declare function workerRuntime(opts?: WorkerRuntimeOptions): RuntimeAdapter;

export { type TransformFn, type WorkerRuntimeOptions, defaultTransform, workerRuntime };
