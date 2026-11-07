/**
 * The agent's store, across the sandbox's wall. The sandboxed page runs
 * agex-ts but may keep nothing (its origin is opaque: no IndexedDB), so
 * its kvgit store is a `KVStore` that asks the offscreen document, which
 * keeps the real one on the extension's IndexedDB. Each call is one
 * `postMessage` round trip; `keys` and `items` come back whole.
 */

/** The `KVStore` methods the offscreen document serves. */
export const KV_METHODS = ["get", "set", "remove", "has", "getMany", "setMany", "removeMany", "cas", "casMany", "keys", "items", "clear"];

/**
 * A `KVStore` whose every call is `ask({ kv, args })`, answered by
 * `serveKv` on the other side.
 *
 * @param {(msg: { kv: string, args: unknown[] }) => Promise<any>} ask
 * @returns {import("@agex-ts/kvgit").KVStore}
 */
export function remoteKv(ask) {
    const call = (/** @type {string} */ kv, /** @type {unknown[]} */ ...args) => ask({ kv, args });
    return {
        get: (key) => call("get", key),
        set: (key, value) => call("set", key, value),
        remove: (key) => call("remove", key),
        has: (key) => call("has", key),
        getMany: (keys) => call("getMany", [...keys]),
        setMany: (items) => call("setMany", [...items]),
        removeMany: (keys) => call("removeMany", [...keys]),
        cas: (key, value, expected) => call("cas", key, value, expected),
        casMany: (expected, writes, removes) => call("casMany", expected, writes, removes === undefined ? undefined : [...removes]),
        async *keys(prefix) {
            yield* /** @type {string[]} */ (await call("keys", prefix));
        },
        async *items(prefix) {
            yield* /** @type {[string, Uint8Array][]} */ (await call("items", prefix));
        },
        clear: () => call("clear"),
    };
}

/**
 * Answer one `remoteKv` call from `kv`, the real store.
 *
 * @param {import("@agex-ts/kvgit").KVStore} kv @param {{ kv: string, args: any[] }} msg
 */
export async function serveKv(kv, { kv: method, args }) {
    if (!KV_METHODS.includes(method)) throw new Error(`no store method ${method}`);
    if (method === "keys" || method === "items") {
        const out = [];
        for await (const x of /** @type {any} */ (kv)[method](...args)) out.push(x);
        return out;
    }
    return /** @type {any} */ (kv)[method](...args);
}
