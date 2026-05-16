// src/backends/idb.ts
var DEFAULT_DB_NAME = "kvgit-ts";
var DEFAULT_STORE_NAME = "kv";
var SCHEMA_VERSION = 1;
var IndexedDB = class _IndexedDB {
  #db;
  #storeName;
  constructor(db, storeName) {
    this.#db = db;
    this.#storeName = storeName;
  }
  static async open(opts = {}) {
    const dbName = opts.dbName ?? DEFAULT_DB_NAME;
    const storeName = opts.storeName ?? DEFAULT_STORE_NAME;
    const db = await new Promise((resolve, reject) => {
      const req = globalThis.indexedDB.open(dbName, SCHEMA_VERSION);
      req.onupgradeneeded = () => {
        const upgradedDb = req.result;
        if (!upgradedDb.objectStoreNames.contains(storeName)) {
          upgradedDb.createObjectStore(storeName);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
      req.onblocked = () => reject(
        new Error(
          `IndexedDB open of '${dbName}' is blocked. Close other tabs / windows holding the database open and reload, or restart the browser.`
        )
      );
    });
    return new _IndexedDB(db, storeName);
  }
  /** Close the underlying IDB connection. */
  close() {
    this.#db.close();
  }
  /**
   * Delete an IndexedDB database entirely. Returns when the deletion
   * succeeds. Rejects if the deletion is blocked by an open connection.
   */
  static async deleteDatabase(dbName) {
    return new Promise((resolve, reject) => {
      const req = globalThis.indexedDB.deleteDatabase(dbName);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error ?? new Error("IndexedDB deleteDatabase failed"));
      req.onblocked = () => reject(
        new Error(`IndexedDB delete of '${dbName}' is blocked. Close other tabs / connections.`)
      );
    });
  }
  // ---------- Internal: tx helper ----------
  #tx(mode) {
    const tx = this.#db.transaction(this.#storeName, mode);
    return { store: tx.objectStore(this.#storeName), tx };
  }
  // ---------- Reads ----------
  async get(key) {
    const { store, tx } = this.#tx("readonly");
    return new Promise((resolve, reject) => {
      const req = store.get(key);
      req.onsuccess = () => {
        const r = req.result;
        resolve(r === void 0 ? null : r);
      };
      req.onerror = () => reject(req.error);
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    });
  }
  async has(key) {
    const { store, tx } = this.#tx("readonly");
    return new Promise((resolve, reject) => {
      const req = store.count(key);
      req.onsuccess = () => resolve(req.result > 0);
      req.onerror = () => reject(req.error);
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    });
  }
  async getMany(keys) {
    const keyArr = [...keys];
    if (keyArr.length === 0) return /* @__PURE__ */ new Map();
    const { store, tx } = this.#tx("readonly");
    return new Promise((resolve, reject) => {
      const result = /* @__PURE__ */ new Map();
      for (const key of keyArr) {
        const req = store.get(key);
        req.onsuccess = () => {
          if (req.result !== void 0) result.set(key, req.result);
        };
        req.onerror = () => reject(req.error);
      }
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    });
  }
  // ---------- Writes ----------
  async set(key, value) {
    const { store, tx } = this.#tx("readwrite");
    return new Promise((resolve, reject) => {
      const req = store.put(value, key);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    });
  }
  async setMany(items) {
    const itemArr = [...items];
    if (itemArr.length === 0) return;
    const { store, tx } = this.#tx("readwrite");
    return new Promise((resolve, reject) => {
      for (const [k, v] of itemArr) {
        const req = store.put(v, k);
        req.onerror = () => reject(req.error);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    });
  }
  async remove(key) {
    const { store, tx } = this.#tx("readwrite");
    return new Promise((resolve, reject) => {
      const req = store.delete(key);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    });
  }
  async removeMany(keys) {
    const keyArr = [...keys];
    if (keyArr.length === 0) return;
    const { store, tx } = this.#tx("readwrite");
    return new Promise((resolve, reject) => {
      for (const k of keyArr) {
        const req = store.delete(k);
        req.onerror = () => reject(req.error);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    });
  }
  // ---------- CAS ----------
  /**
   * Atomic compare-and-swap.
   *
   * Read + conditional write happen in a single `readwrite`
   * transaction. IDB serializes `readwrite` transactions on the same
   * object store, so concurrent CAS calls (even from other workers
   * sharing the database) are safely linearized.
   */
  async cas(key, value, expected) {
    const { store, tx } = this.#tx("readwrite");
    return new Promise((resolve, reject) => {
      let casResult = false;
      const readReq = store.get(key);
      readReq.onsuccess = () => {
        const current = readReq.result === void 0 ? null : readReq.result;
        if (bytesEqual(current, expected)) {
          const writeReq = store.put(value, key);
          writeReq.onerror = () => reject(writeReq.error);
          casResult = true;
        }
      };
      readReq.onerror = () => reject(readReq.error);
      tx.oncomplete = () => resolve(casResult);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    });
  }
  // ---------- Iteration ----------
  // ----- Iteration design note -----
  //
  // Both `keys()` and `items()` materialize the result set inside the
  // IDB transaction's lifetime, then yield from memory. True
  // cursor-streaming (yield each row from inside the cursor callback)
  // is possible but conflicts with two of this file's discipline rules
  // (handler-attach-synchronously, no-await-in-tx) — the consumer's
  // pull rate would dictate when `cursor.continue()` runs, and any
  // delay risks the tx auto-committing mid-iteration.
  //
  // For our usage patterns — bounded HAMT walks, prefix-scoped GC
  // sweeps — the consumer always drains the iterator anyway, so
  // streaming's memory benefit doesn't materialize. We pay the
  // materialization cost knowingly. Revisit if a real consumer
  // genuinely benefits from backpressure-friendly streaming.
  async *keys(prefix) {
    const { store, tx } = this.#tx("readonly");
    const range = prefix !== void 0 ? prefixRange(prefix) : null;
    const collected = await new Promise((resolve, reject) => {
      const req = range !== null ? store.getAllKeys(range) : store.getAllKeys();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    });
    for (const k of collected) yield String(k);
  }
  async *items(prefix) {
    const { store, tx } = this.#tx("readonly");
    const range = prefix !== void 0 ? prefixRange(prefix) : null;
    const collected = await new Promise((resolve, reject) => {
      const items = [];
      const req = range !== null ? store.openCursor(range) : store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          items.push([String(cursor.key), cursor.value]);
          cursor.continue();
        } else {
          resolve(items);
        }
      };
      req.onerror = () => reject(req.error);
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    });
    for (const item of collected) yield item;
  }
  async clear() {
    const { store, tx } = this.#tx("readwrite");
    return new Promise((resolve, reject) => {
      const req = store.clear();
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    });
  }
};
function bytesEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function prefixRange(prefix) {
  return IDBKeyRange.bound(prefix, `${prefix}\uFFFF`, false, false);
}

export { IndexedDB };
//# sourceMappingURL=idb.js.map
//# sourceMappingURL=idb.js.map