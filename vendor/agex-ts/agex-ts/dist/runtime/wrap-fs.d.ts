import { FileSystem } from 'termish-ts';

/**
 * `wrapAgentFs(fs)` — ergonomic wrapper around the underlying
 * `FileSystem` protocol that the agent sees as `fs`.
 *
 * The termish-ts `FileSystem` protocol is bytes-only by design (it's
 * a general async-storage abstraction; backends shouldn't care about
 * JS-specific encodings). But agents reach for whichever ecosystem's
 * file-IO convention comes to mind first — Node, Deno, browser web
 * APIs — and they're not always the same person across turns. This
 * wrapper accepts the most common reflexes and routes them all to
 * the bytes-only protocol underneath:
 *
 *   const text = await fs.read(path, 'utf8')     // Node-style with encoding
 *   const text = await fs.readFile(path, 'utf8') // Node-standard alias
 *   const text = await fs.readText(path)         // Deno-flavored shortcut
 *
 *   await fs.write(path, 'hello')                // Node-style, string ok
 *   await fs.writeFile(path, 'hello')            // Node-standard alias
 *   await fs.writeText(path, 'hello')            // Deno-flavored shortcut
 *
 * Bytes-form still works identically for code that wants the raw
 * form: `fs.read(path)` / `fs.write(path, bytes)` / `fs.readFile(path)`
 * / `fs.writeFile(path, bytes)`.
 *
 * Used at the agex injection boundary in both `evalRuntime` (host
 * realm) and `agex-runtime-worker` (the bridged fs proxy that runs
 * in the worker realm). Same wrapper, same agent-visible surface.
 */

/**
 * Wrap a bytes-only `FileSystem`-shaped object so the agent can use
 * the conventional `fs.read(path, 'utf8')` / `fs.write(path, str)`
 * patterns. The returned object proxies all other methods through
 * unchanged.
 *
 * Accepts a structural subset of `FileSystem` so the wrapper works
 * equally well over the host's real VFS (eval runtime) and the
 * RPC-bridged proxy (worker runtime). Either way the underlying
 * `read`/`write` are invoked with bytes; the wrapper handles the
 * string<->bytes shuffle.
 */
declare function wrapAgentFs<F extends Pick<FileSystem, 'read' | 'write'>>(fs: F): F;

export { wrapAgentFs };
