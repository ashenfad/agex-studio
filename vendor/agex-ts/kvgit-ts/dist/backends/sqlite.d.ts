import { K as KVStore } from '../types-CSsD35si.js';

/**
 * SQLite-backed `KVStore` for Node, using the built-in `node:sqlite`
 * module.
 *
 * **Requires Node 22.5+** — `node:sqlite` is stable from Node 24+; on
 * 22.5/23 it works but ships behind the `--experimental-sqlite` flag.
 * No native dependencies needed (no `better-sqlite3`, no postinstall
 * compilation).
 *
 * Storage layout: a single `kv` table with `(key TEXT PRIMARY KEY,
 * value BLOB NOT NULL) WITHOUT ROWID`. WITHOUT ROWID makes lookups
 * by primary key slightly faster and cuts space overhead — exactly
 * what a KV store wants.
 *
 * WAL journal mode is enabled by default for file-backed databases:
 * concurrent readers don't block, and writes are durable. Set
 * `wal: false` to fall back to the default rollback journal.
 *
 * CAS is implemented as two atomic single-statement forms — no
 * explicit transactions needed:
 * - `expected === null`: `INSERT OR IGNORE`. The single statement is
 *   atomic; succeeds iff the row was inserted (changes === 1).
 * - `expected` is bytes: `UPDATE WHERE key = ? AND value = ?`. The
 *   row is updated iff the current value matches; changes === 1
 *   signals success.
 *
 * Both forms are race-free against concurrent writers because SQLite
 * serializes writes within a database (single-writer model).
 */

interface SqliteOptions {
    /** Database path. `:memory:` (default) for in-memory, file path
     *  otherwise. File paths persist across handles. */
    path?: string;
    /** Enable WAL journal mode for file-backed databases. Default true.
     *  Ignored for `:memory:`. WAL gives concurrent readers + one writer;
     *  the rollback-journal default serializes all access. */
    wal?: boolean;
}
/**
 * Construct via the async `Sqlite.open(opts?)` factory. The constructor
 * is private; the factory opens the database, applies the WAL pragma,
 * creates the schema if missing, and prepares the statements once.
 */
declare class Sqlite implements KVStore {
    #private;
    private constructor();
    static open(opts?: SqliteOptions): Promise<Sqlite>;
    close(): void;
    get(key: string): Promise<Uint8Array | null>;
    has(key: string): Promise<boolean>;
    getMany(keys: Iterable<string>): Promise<Map<string, Uint8Array>>;
    set(key: string, value: Uint8Array): Promise<void>;
    setMany(items: Iterable<readonly [string, Uint8Array]>): Promise<void>;
    remove(key: string): Promise<void>;
    removeMany(keys: Iterable<string>): Promise<void>;
    cas(key: string, value: Uint8Array, expected: Uint8Array | null): Promise<boolean>;
    keys(prefix?: string): AsyncIterable<string>;
    items(prefix?: string): AsyncIterable<readonly [string, Uint8Array]>;
    clear(): Promise<void>;
}

export { Sqlite, type SqliteOptions };
