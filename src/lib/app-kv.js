/**
 * `agex.kvStore(name?)`: a kvgit `KVStore` an app keeps in its own
 * database, for a store of its own (an agent's world, say) that syncs,
 * forks and restores as the rest of `agex.db` does.
 *
 * Each store is the rows of `_agex_kv` with its name, and each of its
 * calls one procedure run by the database's worker (`db-worker.js`) as
 * one transaction, so `cas` and `casMany` read and write with nothing
 * landing between. The table is made on a store's first call, and again
 * if a restore took it away (`kvCall`).
 */

/** The table every store's keys live in. */
export const KV_TABLE = "_agex_kv";

/** Made when a call finds it missing: a no-op when it's there. */
export const KV_TABLE_SQL = `CREATE TABLE IF NOT EXISTS ${KV_TABLE} (store TEXT NOT NULL, k TEXT NOT NULL, v BLOB NOT NULL, PRIMARY KEY (store, k)) WITHOUT ROWID`;

/** The store `agex.kvStore()` gives without a name. */
export const DEFAULT_STORE = "default";

/** The calls that may change a store. */
export const KV_WRITES = new Set(["set", "setMany", "remove", "removeMany", "cas", "casMany", "clear"]);

/** @typedef {import("@agex-ts/kvsql").Transaction} Transaction */

const MAX_CODE_POINT = 0x10ffff;

/**
 * The least string greater than every string starting with `prefix`:
 * the exclusive upper bound of a prefix scan, or null when nothing is
 * greater and the scan is open above. SQLite compares TEXT as UTF-8
 * bytes, which order as code points do, so it is `prefix` with its last
 * code point bumped by one, carried leftwards past U+10FFFF and stepped
 * over the surrogates; a lone surrogate binds as U+FFFD, though a
 * store's keys and prefixes refuse one.
 *
 * @param {string} prefix
 * @returns {string | null}
 */
export function prefixUpperBound(prefix) {
    const points = Array.from(prefix, (ch) => {
        const cp = /** @type {number} */ (ch.codePointAt(0));
        return cp >= 0xd800 && cp <= 0xdfff ? 0xfffd : cp;
    });
    while (points.length > 0 && points[points.length - 1] === MAX_CODE_POINT) points.pop();
    const last = points.pop();
    if (last === undefined) return null;
    points.push(last + 1 === 0xd800 ? 0xe000 : last + 1);
    return points.map((cp) => String.fromCodePoint(cp)).join("");
}

/** @param {unknown} store @param {string} method */
function storeName(store, method) {
    if (typeof store !== "string" || store === "") throw new TypeError(`kvStore.${method}: the store's name must be a non-empty string`);
    return store;
}

/** An unpaired surrogate, which SQLite would store as U+FFFD. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** @param {unknown} key @param {string} method */
function keyOf(key, method) {
    if (typeof key !== "string") throw new TypeError(`kvStore.${method}: a key must be a string`);
    // two keys would share a row
    if (LONE_SURROGATE.test(key)) throw new TypeError(`kvStore.${method}: a key can't hold an unpaired surrogate`);
    return key;
}

/** @param {unknown} value @param {string} method */
function bytesOf(value, method) {
    if (!(value instanceof Uint8Array)) throw new TypeError(`kvStore.${method}: a value must be a Uint8Array`);
    return value;
}

/** @param {unknown} list @param {string} method @returns {unknown[]} */
function listOf(list, method) {
    if (!Array.isArray(list)) throw new TypeError(`kvStore.${method}: expected a list`);
    return list;
}

/** A row's value: SQLite gives an empty blob back as null. @param {unknown} v */
function rowBytes(v) {
    return v instanceof Uint8Array ? v : new Uint8Array(0);
}

/** @param {Uint8Array} a @param {Uint8Array} b */
function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

/** @param {Transaction} tx @param {string} store @param {string} key @returns {Uint8Array | null} */
function read(tx, store, key) {
    const row = tx.query(`SELECT v FROM ${KV_TABLE} WHERE store = ? AND k = ?`, [store, key]).rows[0];
    return row === undefined ? null : rowBytes(row.v);
}

/** @param {Transaction} tx @param {string} store @param {string} key @param {Uint8Array} value */
function write(tx, store, key, value) {
    tx.query(`INSERT INTO ${KV_TABLE} (store, k, v) VALUES (?, ?, ?) ON CONFLICT (store, k) DO UPDATE SET v = excluded.v`, [store, key, value]);
}

/** @param {Transaction} tx @param {string} store @param {string} key */
function drop(tx, store, key) {
    tx.query(`DELETE FROM ${KV_TABLE} WHERE store = ? AND k = ?`, [store, key]);
}

/** The rows under `prefix` (every row without one), as `[k, v]`. @param {Transaction} tx @param {string} store @param {unknown} prefix @param {boolean} values */
function scan(tx, store, prefix, values) {
    const cols = values ? "k, v" : "k";
    if (prefix === undefined || prefix === null || prefix === "") {
        return tx.query(`SELECT ${cols} FROM ${KV_TABLE} WHERE store = ? ORDER BY k`, [store]).rows;
    }
    const from = keyOf(prefix, values ? "items" : "keys");
    const upper = prefixUpperBound(from);
    return upper === null
        ? tx.query(`SELECT ${cols} FROM ${KV_TABLE} WHERE store = ? AND k >= ? ORDER BY k`, [store, from]).rows
        : tx.query(`SELECT ${cols} FROM ${KV_TABLE} WHERE store = ? AND k >= ? AND k < ? ORDER BY k`, [store, from, upper]).rows;
}

/**
 * The procedures the database's worker serves, one per `KVStore` call,
 * each taking `{ store, ... }`: what the call takes, by name.
 *
 * @type {Record<string, (tx: Transaction, args: any) => unknown>}
 */
export const KV_PROCEDURES = {
    "kv.get"(tx, { store, key }) {
        return read(tx, storeName(store, "get"), keyOf(key, "get"));
    },
    "kv.has"(tx, { store, key }) {
        return read(tx, storeName(store, "has"), keyOf(key, "has")) !== null;
    },
    "kv.getMany"(tx, { store, keys }) {
        const name = storeName(store, "getMany");
        /** @type {[string, Uint8Array][]} */
        const out = [];
        for (const key of listOf(keys, "getMany")) {
            const value = read(tx, name, keyOf(key, "getMany"));
            if (value !== null) out.push([/** @type {string} */ (key), value]);
        }
        return out;
    },
    "kv.set"(tx, { store, key, value }) {
        write(tx, storeName(store, "set"), keyOf(key, "set"), bytesOf(value, "set"));
        return null;
    },
    "kv.setMany"(tx, { store, items }) {
        const name = storeName(store, "setMany");
        for (const item of listOf(items, "setMany")) {
            const [key, value] = listOf(item, "setMany");
            write(tx, name, keyOf(key, "setMany"), bytesOf(value, "setMany"));
        }
        return null;
    },
    "kv.remove"(tx, { store, key }) {
        drop(tx, storeName(store, "remove"), keyOf(key, "remove"));
        return null;
    },
    "kv.removeMany"(tx, { store, keys }) {
        const name = storeName(store, "removeMany");
        for (const key of listOf(keys, "removeMany")) drop(tx, name, keyOf(key, "removeMany"));
        return null;
    },
    "kv.cas"(tx, { store, key, value, expected }) {
        const name = storeName(store, "cas");
        const k = keyOf(key, "cas");
        const v = bytesOf(value, "cas");
        const want = expected === null ? null : bytesOf(expected, "cas");
        const current = read(tx, name, k);
        if (current === null || want === null ? current !== want : !sameBytes(current, want)) return false;
        write(tx, name, k, v);
        return true;
    },
    "kv.casMany"(tx, { store, expected, writes, removes }) {
        const name = storeName(store, "casMany");
        const written = new Set();
        for (const [key] of /** @type {unknown[][]} */ (listOf(writes, "casMany"))) written.add(keyOf(key, "casMany"));
        for (const key of listOf(removes ?? [], "casMany")) {
            if (written.has(key)) throw new TypeError(`kvStore.casMany: ${JSON.stringify(key)} is both written and removed`);
        }
        for (const entry of listOf(expected, "casMany")) {
            const [key, want] = listOf(entry, "casMany");
            const current = read(tx, name, keyOf(key, "casMany"));
            const w = want === null ? null : bytesOf(want, "casMany");
            if (current === null || w === null ? current !== w : !sameBytes(current, w)) return false;
        }
        for (const [key, value] of /** @type {unknown[][]} */ (writes)) write(tx, name, /** @type {string} */ (key), bytesOf(value, "casMany"));
        for (const key of /** @type {unknown[]} */ (removes ?? [])) drop(tx, name, keyOf(key, "casMany"));
        return true;
    },
    "kv.keys"(tx, { store, prefix }) {
        return scan(tx, storeName(store, "keys"), prefix, false).map((row) => row.k);
    },
    "kv.items"(tx, { store, prefix }) {
        return scan(tx, storeName(store, "items"), prefix, true).map((row) => [row.k, rowBytes(row.v)]);
    },
    "kv.clear"(tx, { store }) {
        tx.query(`DELETE FROM ${KV_TABLE} WHERE store = ?`, [storeName(store, "clear")]);
        return null;
    },
};

/** The calls a store takes, by the names an app uses. */
export const KV_METHODS = new Set(Object.keys(KV_PROCEDURES).map((name) => name.slice(3)));

/**
 * Run an app's store call `method` with `args` on database `client`,
 * making the table first if the call found it missing (a first call, or
 * a restore to before there was one).
 *
 * @param {import("@agex-ts/kvsql/client").DatabaseClient} client
 * @param {string} method one of `KV_METHODS`
 * @param {Record<string, unknown>} args
 */
export async function kvCall(client, method, args) {
    try {
        return await client.call(`kv.${method}`, args);
    } catch (e) {
        if (!(e instanceof Error) || !e.message.includes(`no such table: ${KV_TABLE}`)) throw e;
        await client.query(KV_TABLE_SQL);
        return await client.call(`kv.${method}`, args);
    }
}
