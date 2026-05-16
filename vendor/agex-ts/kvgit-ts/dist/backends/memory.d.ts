import { K as KVStore } from '../types-CSsD35si.js';

/**
 * In-process KV store backed by a `Map`. Useful for tests, dev-mode
 * agents, and as the reference implementation against which other
 * backends are tested.
 *
 * Operations are synchronous internally but exposed as `async` to
 * match the `KVStore` interface — user code is uniform across
 * backends.
 */
declare class Memory implements KVStore {
    #private;
    get(key: string): Promise<Uint8Array | null>;
    set(key: string, value: Uint8Array): Promise<void>;
    remove(key: string): Promise<void>;
    has(key: string): Promise<boolean>;
    getMany(keys: Iterable<string>): Promise<Map<string, Uint8Array>>;
    setMany(items: Iterable<readonly [string, Uint8Array]>): Promise<void>;
    removeMany(keys: Iterable<string>): Promise<void>;
    cas(key: string, value: Uint8Array, expected: Uint8Array | null): Promise<boolean>;
    keys(prefix?: string): AsyncIterable<string>;
    items(prefix?: string): AsyncIterable<readonly [string, Uint8Array]>;
    clear(): Promise<void>;
}

export { Memory };
