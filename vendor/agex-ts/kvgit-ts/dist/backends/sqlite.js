import { createRequire } from 'module';

// src/backends/sqlite.ts
var localRequire = createRequire(import.meta.url);
var _DatabaseSync = null;
function loadDatabaseSync() {
  if (_DatabaseSync === null) {
    const mod = localRequire("node:sqlite");
    _DatabaseSync = mod.DatabaseSync;
  }
  return _DatabaseSync;
}
var SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value BLOB NOT NULL
  ) WITHOUT ROWID;
`;
var Sqlite = class _Sqlite {
  #db;
  #getStmt;
  #setStmt;
  #removeStmt;
  #hasStmt;
  #allKeysStmt;
  #allItemsStmt;
  #prefixKeysStmt;
  #prefixItemsStmt;
  #clearStmt;
  #casUpdateStmt;
  #casInsertIfAbsentStmt;
  constructor(db) {
    this.#db = db;
    this.#getStmt = db.prepare("SELECT value FROM kv WHERE key = ?");
    this.#setStmt = db.prepare(
      "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    );
    this.#removeStmt = db.prepare("DELETE FROM kv WHERE key = ?");
    this.#hasStmt = db.prepare("SELECT 1 AS present FROM kv WHERE key = ? LIMIT 1");
    this.#allKeysStmt = db.prepare("SELECT key FROM kv");
    this.#allItemsStmt = db.prepare("SELECT key, value FROM kv");
    this.#prefixKeysStmt = db.prepare("SELECT key FROM kv WHERE key >= ? AND key < ?");
    this.#prefixItemsStmt = db.prepare("SELECT key, value FROM kv WHERE key >= ? AND key < ?");
    this.#clearStmt = db.prepare("DELETE FROM kv");
    this.#casUpdateStmt = db.prepare("UPDATE kv SET value = ? WHERE key = ? AND value = ?");
    this.#casInsertIfAbsentStmt = db.prepare("INSERT OR IGNORE INTO kv (key, value) VALUES (?, ?)");
  }
  static async open(opts = {}) {
    const path = opts.path ?? ":memory:";
    const DatabaseSync = loadDatabaseSync();
    const db = new DatabaseSync(path);
    if ((opts.wal ?? true) && path !== ":memory:") {
      db.exec("PRAGMA journal_mode = WAL");
    }
    db.exec(SCHEMA_DDL);
    return new _Sqlite(db);
  }
  close() {
    this.#db.close();
  }
  // ---------- Reads ----------
  async get(key) {
    const row = this.#getStmt.get(key);
    if (row === void 0) return null;
    return toFreshUint8Array(row.value);
  }
  async has(key) {
    return this.#hasStmt.get(key) !== void 0;
  }
  async getMany(keys) {
    const out = /* @__PURE__ */ new Map();
    for (const key of keys) {
      const row = this.#getStmt.get(key);
      if (row !== void 0) out.set(key, toFreshUint8Array(row.value));
    }
    return out;
  }
  // ---------- Writes ----------
  async set(key, value) {
    this.#setStmt.run(key, value);
  }
  async setMany(items) {
    const arr = [...items];
    if (arr.length === 0) return;
    this.#db.exec("BEGIN");
    try {
      for (const [k, v] of arr) this.#setStmt.run(k, v);
      this.#db.exec("COMMIT");
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    }
  }
  async remove(key) {
    this.#removeStmt.run(key);
  }
  async removeMany(keys) {
    const arr = [...keys];
    if (arr.length === 0) return;
    this.#db.exec("BEGIN");
    try {
      for (const k of arr) this.#removeStmt.run(k);
      this.#db.exec("COMMIT");
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    }
  }
  // ---------- CAS ----------
  async cas(key, value, expected) {
    if (expected === null) {
      const r2 = this.#casInsertIfAbsentStmt.run(key, value);
      return Number(r2.changes) === 1;
    }
    const r = this.#casUpdateStmt.run(value, key, expected);
    return Number(r.changes) === 1;
  }
  // ---------- Iteration ----------
  async *keys(prefix) {
    const rows = prefix !== void 0 ? this.#prefixKeysStmt.all(prefix, prefixUpperBound(prefix)) : this.#allKeysStmt.all();
    for (const row of rows) yield row.key;
  }
  async *items(prefix) {
    const rows = prefix !== void 0 ? this.#prefixItemsStmt.all(prefix, prefixUpperBound(prefix)) : this.#allItemsStmt.all();
    for (const row of rows) yield [row.key, toFreshUint8Array(row.value)];
  }
  async clear() {
    this.#clearStmt.run();
  }
};
function toFreshUint8Array(v) {
  return new Uint8Array(v);
}
function prefixUpperBound(prefix) {
  return `${prefix}\uFFFF`;
}

export { Sqlite };
//# sourceMappingURL=sqlite.js.map
//# sourceMappingURL=sqlite.js.map