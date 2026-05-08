/**
 * Browser-side stub for Node's `module` builtin.
 *
 * agex-ts's bundle has a chunk that imports `createRequire` from
 * Node's `module` to optionally pull in `worker_threads` for the
 * future Node-side workerRuntime target. The code is wrapped in
 * try/catch (fails gracefully on browsers), but the static import
 * itself trips Vite's `__vite-browser-external` stub at build time.
 *
 * This stub is aliased in `vite.config.js` so the static import
 * resolves cleanly. The returned `require` always returns
 * `undefined`, which the caller's try/catch handles as
 * "worker_threads not available, fall back to whatever else."
 *
 * Remove this stub (and the alias) once agex-ts ships a
 * browser-friendly bundle that doesn't reach for `node:module`.
 */
export function createRequire() {
    return () => undefined;
}
