import { V as VirtualFileSystem } from '../types-MortsIN-.js';
import '@standard-schema/spec';
import 'termish-ts';
import '../errors.js';

/**
 * Module loader bridging the agent's VFS to userspace JS execution.
 *
 * The JS engine has no idea our `VirtualFileSystem` exists — when
 * agent code says `import { x } from '/helpers/foo'`, the engine has
 * no plug point that lets us route the path to our in-memory FS.
 *
 * The "obvious" fix — rewrite `import` statements into dynamic
 * `import()` of `data:application/javascript;base64,...` URLs — is
 * cleaner because it gives us real ESM semantics. But Node's
 * `new AsyncFunction(...)` has no module context attached, so calls
 * to `import()` from inside it throw "A dynamic import callback was
 * not specified." Working around it requires Node 21+ (`vm.compileFunction`
 * + `importModuleDynamically`) or Node 22.5+ (`vm.constants.USE_MAIN_
 * CONTEXT_DEFAULT_LOADER`). Browser-side it'd be fine, but we want one
 * implementation across both.
 *
 * **Strategy:** userspace ESM emulation. Each helper file becomes an
 * async function that captures its `export`s into an object; user
 * `import` statements get rewritten to destructure from a pre-loaded
 * module map. Works in any JS environment (browser, Node 20+, edge
 * runtimes, Workers).
 *
 * **Trade-offs vs real ESM (data: URLs in a Worker realm):**
 *   - ✅ Works everywhere, no Node version gates
 *   - ✅ No engine module context required
 *   - ✅ Full re-export shapes supported: `export { x }`,
 *     `export { x as y }`, `export * from '...'`, `export * as ns
 *     from '...'`, default re-exports
 *   - ✅ Top-level `await` works inside helpers — each helper is
 *     an async function we `await` before its dependents load,
 *     so `export const data = await fetch(...)` resolves correctly
 *     across the import graph
 *   - ❌ No live bindings — `export let x = 0` followed by mutation
 *     in the helper isn't visible to importers (we copy values at
 *     load time). Workaround: wrap mutable state in an object so
 *     it's shared by reference. Rare in agent-written helpers (they
 *     trend toward pure functions and constants).
 *   - ❌ No `import.meta` or import attributes — agents don't use
 *     these.
 *   - ❌ Cyclic helper imports throw a clear error rather than
 *     supporting real ESM's temporal-dead-zone partial-binding
 *     semantics. Agents don't write cyclic helpers in practice.
 *
 * **Stack traces:** every helper script gets a `//# sourceURL=`
 * pragma so engine-reported file names use the agent's original
 * VFS path. Line/column numbers preserved by `ts-blank-space`
 * (whitespace substitution, no AST rewriting).
 *
 * **Path resolution:**
 *   - Absolute (`/helpers/foo`): VFS-relative; tried with `.ts`,
 *     `.js`, `.mjs` extensions if the exact name doesn't exist.
 *   - Relative (`./other`, `../shared/x`): resolved relative to the
 *     containing helper's directory.
 *   - Anything else (`react`, `node:fs`, `https://...`): not handled
 *     here. The user code's import is left unchanged, which will
 *     fail at execution time (no engine module loader). evalRuntime
 *     is documented as no-isolation; production sandboxing belongs
 *     to runtime-worker.
 *
 * **Cycles:** detected during recursive resolution and rejected
 * with a clear error. Real ESM allows synchronous cycles; userspace
 * emulation can't easily replicate the partial-evaluation semantics,
 * so we don't try.
 *
 * **Regex-vs-real-parser caveat:** the import/export rewriting is
 * regex-based, not AST-based. This is fine in practice because
 * agent-written helpers are short, idiomatic, and don't contain
 * pathological cases — but a few fragile spots exist:
 *
 *   - An `import` or `export` statement appearing inside a string
 *     literal or comment can fool the matcher. (`const s = "import
 *     { x } from '/p'"` would attempt to load `/p` from the VFS.)
 *   - Multi-line `export default` expressions truncate at the
 *     first newline. Single-line forms — including IIFEs and
 *     inline objects — work fine.
 *   - Re-exports from non-VFS paths (`export { x } from 'react'`)
 *     are rewritten to `__exports.X = __modules['react'].X`,
 *     which throws at runtime since `react` isn't in the modules
 *     map. Helpers that re-export from npm-style packages aren't
 *     supported.
 *
 * If/when these bite real agent code, the answer is to swap the
 * regex passes for an AST walk (e.g. via `oxc-parser` or
 * `@babel/parser`'s lightweight estree mode). For now they
 * haven't surfaced.
 */

/** Result of preprocessing a single user `ts_action` body. */
interface PreparedScript {
    /** The script with its `import` statements replaced by lookups
     *  into the injected `__modules` map. */
    readonly code: string;
    /** Module map to inject as the `__modules` parameter. Maps
     *  resolved VFS path → exports object. */
    readonly modules: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}
/** Wire-friendly form of a prepared script — same import-rewriting
 *  but helpers are returned as JS source strings rather than
 *  pre-evaluated exports objects. The worker runtime ships these
 *  across the postMessage boundary (function exports don't
 *  structured-clone, but strings do) and AsyncFunction-evaluates
 *  each helper in its own realm to populate the modules map. */
interface PreparedForWire {
    /** Same as `PreparedScript.code`. */
    readonly code: string;
    /** Helpers in dependency order — each entry's body may reference
     *  earlier entries via `__modules['/path']`. The worker iterates
     *  in order, evaluating each into a fresh `__exports` object,
     *  registering it under `path`. */
    readonly helpers: ReadonlyArray<{
        /** Resolved VFS path (without extension if the user code
         *  imported without one) — the key the agent's rewritten code
         *  uses to look this module up in `__modules`. */
        readonly path: string;
        /** Body of an `async function(__exports, __modules) { ... }`
         *  that populates `__exports` and returns it. */
        readonly body: string;
    }>;
}
/** Top-level JS/TS imports we recognize and rewrite. */
interface ImportStatement {
    /** Char-offset start in the source. */
    readonly start: number;
    /** Char-offset end (exclusive) in the source. */
    readonly end: number;
    /** The path as written between quotes. */
    readonly path: string;
    /** Parsed clause: what the import binds. */
    readonly binding: ImportBinding;
    /** True when this is `export ... from` rather than `import` —
     *  treated as a graph edge for path resolution but skipped on
     *  the user-script rewrite (re-exports aren't valid in a script
     *  context). */
    readonly isReexport: boolean;
}
type ImportBinding = {
    kind: 'named';
    entries: ReadonlyArray<{
        source: string;
        local: string;
    }>;
} | {
    kind: 'namespace';
    local: string;
} | {
    kind: 'default';
    local: string;
} | {
    kind: 'mixed';
    defaultLocal: string;
    entries: ReadonlyArray<{
        source: string;
        local: string;
    }>;
} | {
    kind: 'sideEffect';
};
/** Rewrite `import` statements in user code to `const { ... } =
 *  __modules['/path']` lookups. Helpers (and helper-of-helpers,
 *  transitively) are pre-loaded; the returned `modules` map should
 *  be passed as the `__modules` parameter when invoking the
 *  resulting AsyncFunction.
 *
 *  When `registeredValues` is supplied, agent code (and helpers)
 *  can also write `import * as math from 'math'` for any name in
 *  the registration table. The map's values are passed to helpers
 *  as `__registered`; agent main code already has the values in
 *  scope as globals (the runtime injects them), so no wiring is
 *  needed there. */
declare function prepareScript(source: string, fs: VirtualFileSystem, registeredValues?: ReadonlyMap<string, unknown>, opts?: PrepareScriptOptions): Promise<PreparedScript>;
/** Optional knobs for `prepareScript`. */
interface PrepareScriptOptions {
    /** Names that are URL-shipped (lazy-loaded). The rewriter emits
     *  `const x = await __load('name')` for these, instead of the
     *  sync `__registered['name']` lookup used for host-bound names.
     *  Omit when no URL-shipped registrations are in scope. */
    readonly urlNames?: ReadonlySet<string>;
    /** Lazy module loader. Called by the agent's emitted code when
     *  it imports a URL-shipped name; should return the resolved
     *  module value (cached after first call). evalRuntime supplies
     *  one that imports via Node's dynamic-import at first call;
     *  `prepareScript`'s default is a synchronous lookup against
     *  `registeredValues` so existing tests / single-realm callers
     *  who pre-resolve still work. */
    readonly load?: (name: string) => Promise<unknown>;
}
/** Wire-friendly variant of `prepareScript`: same rewriting +
 *  recursive helper resolution, but each helper body is returned as
 *  a string instead of evaluated locally. The runtime adapter on
 *  the receiving side (today: `agex-runtime-worker`) iterates the
 *  list in order, AsyncFunction-evaluates each body to get its
 *  exports, and registers them under `path` in its own
 *  `__modules` map.
 *
 *  The `transform` parameter handles TS → JS conversion of helper
 *  source files. evalRuntime passes `tsBlankSpace`; workerRuntime
 *  passes its configurable transform (default ts-blank-space, can
 *  be swapped for esbuild-wasm).
 *
 *  The optional `registeredNames` set lets agent code reach
 *  registered fns / classes / namespaces via natural `import`
 *  statements: `import * as math from 'math'` rewrites to
 *  `const math = math` (a no-op rebind, since `math` is already
 *  in scope). Without this set, `import` statements with
 *  non-VFS specifiers pass through unchanged and fail at runtime
 *  with `SyntaxError: Cannot use import statement outside a module`. */
declare function prepareScriptForWire(source: string, fs: VirtualFileSystem, transform: (src: string) => string | Promise<string>, registeredNames?: ReadonlySet<string>, urlNames?: ReadonlySet<string>): Promise<PreparedForWire>;
/** Find top-level static module-graph edges in the source — both
 *  `import` statements and `export ... from` re-exports. */
declare function parseImports(source: string): ImportStatement[];

export { type PrepareScriptOptions, type PreparedForWire, type PreparedScript, parseImports, prepareScript, prepareScriptForWire };
