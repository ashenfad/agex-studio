import { K as KVStore } from '../types-CSsD35si.js';

/**
 * IndexedDB-backed `KVStore` for browsers (and Node with a shim).
 *
 * Two pieces of discipline matter, both ported from kvgit-py's IDB
 * backend:
 *
 * 1. **Handle `onblocked` explicitly.** When another connection holds
 *    the database open with an incompatible version, IDB fires
 *    `onblocked` instead of resolving. Without an explicit handler the
 *    open promise never settles. We reject with an actionable message.
 *
 * 2. **Attach IDB request handlers synchronously, before any `await`.**
 *    The browser's microtask queue can complete an IDB request between
 *    request creation and handler attachment if you `await` in the
 *    middle, silently losing the result. All `IDBRequest` ops in this
 *    file create the request, attach `onsuccess`/`onerror`, and only
 *    *then* await — usually wrapped in a Promise that ties resolution
 *    to the transaction's `oncomplete` event.
 *
 * Beyond those, this backend is a thin shim over IDB. Values are
 * stored as `Uint8Array` directly (IDB's structured-clone handles
 * binary natively — no base64).
 */

interface IndexedDBOptions {
    /** IndexedDB database name. Each name is an independent persistent store. */
    dbName?: string;
    /** Object store name within the database. */
    storeName?: string;
}
/**
 * IndexedDB-backed KV store.
 *
 * Construct via the async `IndexedDB.open(opts?)` factory. The
 * underlying `IDBDatabase` is opened (and the object store created if
 * needed) before the instance is returned, so subsequent operations
 * can be synchronous up to the IDB boundary.
 */
declare class IndexedDB implements KVStore {
    #private;
    private constructor();
    static open(opts?: IndexedDBOptions): Promise<IndexedDB>;
    /** Close the underlying IDB connection. */
    close(): void;
    /**
     * Delete an IndexedDB database entirely. Returns when the deletion
     * succeeds. Rejects if the deletion is blocked by an open connection.
     */
    static deleteDatabase(dbName: string): Promise<void>;
    get(key: string): Promise<Uint8Array | null>;
    has(key: string): Promise<boolean>;
    getMany(keys: Iterable<string>): Promise<Map<string, Uint8Array>>;
    set(key: string, value: Uint8Array): Promise<void>;
    setMany(items: Iterable<readonly [string, Uint8Array]>): Promise<void>;
    remove(key: string): Promise<void>;
    removeMany(keys: Iterable<string>): Promise<void>;
    /**
     * Atomic compare-and-swap.
     *
     * Read + conditional write happen in a single `readwrite`
     * transaction. IDB serializes `readwrite` transactions on the same
     * object store, so concurrent CAS calls (even from other workers
     * sharing the database) are safely linearized.
     */
    cas(key: string, value: Uint8Array, expected: Uint8Array | null): Promise<boolean>;
    keys(prefix?: string): AsyncIterable<string>;
    items(prefix?: string): AsyncIterable<readonly [string, Uint8Array]>;
    clear(): Promise<void>;
}

export { IndexedDB, type IndexedDBOptions };
