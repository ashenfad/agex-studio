import { K as KVStore } from '../types-CSsD35si.js';

/**
 * Browser-condition stub for the sqlite backend.
 *
 * The real `kvgit-ts/backends/sqlite` module imports `node:module` to
 * load `node:sqlite` — both Node-only. When a browser bundler (Vite,
 * Rollup, esbuild, webpack) resolves this sub-path under the
 * `"browser"` exports condition, it picks this file instead, so
 * `node:module` never enters the browser import graph.
 *
 * The stub preserves the public shape (a `Sqlite` class with an async
 * `open` factory) so type-only consumers compile cleanly. Calling
 * `Sqlite.open` at runtime throws — but in practice this only fires
 * if a browser app explicitly opts into `storage: 'sqlite'`, which
 * doesn't make sense in a browser anyway.
 */

interface SqliteOptions {
    path?: string;
    wal?: boolean;
}
declare class Sqlite implements KVStore {
    private constructor();
    static open(_opts?: SqliteOptions): Promise<Sqlite>;
    get(_key: string): Promise<Uint8Array | null>;
    set(_key: string, _value: Uint8Array): Promise<void>;
    remove(_key: string): Promise<void>;
    has(_key: string): Promise<boolean>;
    getMany(_keys: Iterable<string>): Promise<Map<string, Uint8Array>>;
    setMany(_items: Iterable<readonly [string, Uint8Array]>): Promise<void>;
    removeMany(_keys: Iterable<string>): Promise<void>;
    cas(_key: string, _value: Uint8Array, _expected: Uint8Array | null): Promise<boolean>;
    keys(_prefix?: string): AsyncIterable<string>;
    items(_prefix?: string): AsyncIterable<readonly [string, Uint8Array]>;
    clear(): Promise<void>;
}

export { Sqlite, type SqliteOptions };
