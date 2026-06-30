/**
 * Cold-start session index — the unified-app drawer's source of truth
 * before any kernel boots.
 *
 * **The localStorage cache is authoritative.** Kernel adapters write
 * through to it on every branch / metadata mutation; cold-start renders
 * directly from `loadCache()`. No reconciliation against the kernel's
 * own substrate is needed in the typical path — the cache becomes the
 * unifying primitive that hides the substrate asymmetry between Py
 * (OPFS / diskcache) and Ts (IndexedDB).
 *
 * The IDB-enumeration helpers in this module (`enumerateBareNames`,
 * `_readBranchNames`, `reconcileCache`, `reconcileWithBareNames`)
 * exist for a future TS-only recovery case: if the localStorage cache
 * is cleared but the Ts kernel's IDB data is intact, the IDB scan
 * lets us rebuild the cache without booting the worker. They are
 * **not used in the primary cold-start path** and are TS-specific in
 * scope (Py's OPFS+diskcache substrate isn't enumerable from JS
 * without booting Pyodide).
 *
 * If you're consuming this module:
 *   - `loadCache()` / `cacheSession()` / `uncacheSession()` /
 *     `clearCache()` are the everyday API. Use these.
 *   - `enumerateBareNames()` and friends are recovery-path only;
 *     reach for them when implementing a TS-side "rebuild cache from
 *     IDB" flow, not as a routine consistency check.
 */

const CACHE_KEY = "agex-sessions-cache";
const BRANCH_HEAD_PREFIX = "__branch_head__";
const KVGIT_OBJECT_STORE = "kv";

/**
 * @typedef {'py' | 'ts'} Kernel
 */

/**
 * @typedef {Object} SessionRecord
 * @property {Kernel} kernel
 * @property {string} branch
 * @property {string} title
 * @property {string} name
 * @property {string} description
 * @property {string} updated
 * @property {boolean} [external]
 * @property {boolean} [starred] - true for sessions the user has
 *     "kept" as an app. Only ever set on ts sessions that have `app/`
 *     files (gated at toggle time); py / non-app sessions never carry it.
 */

/**
 * @typedef {Object} BareName
 * @property {Kernel} kernel
 * @property {string} branch
 */

// ---------------------------------------------------------------------------
// localStorage cache
// ---------------------------------------------------------------------------

/**
 * Read the cached session list. Returns `[]` if the cache is empty,
 * malformed, or unavailable. Never throws.
 *
 * @returns {SessionRecord[]}
 */
export function loadCache() {
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(_isValidRecord);
    } catch {
        return [];
    }
}

/** Replace the entire cache with the given records. Atomic — single
 *  localStorage write so other tabs see a consistent snapshot. */
function _writeCache(/** @type {SessionRecord[]} */ records) {
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(records));
    } catch (err) {
        // QuotaExceeded etc. — log and continue. Worst case, the
        // drawer rebuilds metadata next time the kernel engages.
        console.warn("[agex] session-index cache write failed:", err);
    }
}

/**
 * Insert or update a single session's cache record. Writes the full
 * cache back. Cheap in practice — typical session counts are under
 * 100, well under any localStorage performance concern.
 *
 * @param {SessionRecord} record
 */
export function cacheSession(record) {
    if (!_isValidRecord(record)) return;
    const all = loadCache();
    const idx = all.findIndex(
        (r) => r.kernel === record.kernel && r.branch === record.branch,
    );
    if (idx >= 0) {
        all[idx] = record;
    } else {
        all.push(record);
    }
    _writeCache(all);
}

/**
 * Remove a session from the cache. No-op if it isn't there.
 *
 * @param {Kernel} kernel
 * @param {string} branch
 */
export function uncacheSession(kernel, branch) {
    const all = loadCache();
    const filtered = all.filter(
        (r) => !(r.kernel === kernel && r.branch === branch),
    );
    if (filtered.length !== all.length) _writeCache(filtered);
}

/** Drop every cache record. Used by the "purge all data" flow. */
export function clearCache() {
    try {
        localStorage.removeItem(CACHE_KEY);
    } catch {
        /* swallow — purge is best-effort */
    }
}

/**
 * Replace the entire cache with the given record list. Atomic — one
 * localStorage write. Faster than N `cacheSession` calls when the
 * session-list changes in bulk (e.g., after `refreshSessionList`).
 *
 * Invalid records are silently dropped. Caller is expected to pass a
 * fully-constructed record set; this isn't a partial update.
 *
 * @param {SessionRecord[]} records
 */
export function replaceCache(records) {
    if (!Array.isArray(records)) return;
    const valid = records.filter(_isValidRecord);
    _writeCache(valid);
}

function _isValidRecord(r) {
    return (
        r &&
        typeof r === "object" &&
        (r.kernel === "py" || r.kernel === "ts") &&
        typeof r.branch === "string" &&
        r.branch.length > 0
    );
}

// ---------------------------------------------------------------------------
// Pure-JS IDB enumeration
// ---------------------------------------------------------------------------

/**
 * Inverse mapping: given an IDB database name, classify it as a
 * kvgit-shaped store and return the kernel it belongs to. Returns
 * `null` for databases the studio doesn't own (other apps' data,
 * future / experimental backends, etc.).
 *
 * Conventions:
 *   - `"kvgit"` exactly → py kernel (kvgit-py's default db_name and
 *     what agex-py / studio configure today)
 *   - `"kvgit/<session>"` → ts kernel (agex-ts's `connectState` opens
 *     IDBs at `kvgit/<session>`; for `session="default"` that's
 *     `"kvgit/default"`)
 *
 * @param {string | undefined} dbName
 * @returns {Kernel | null}
 */
export function classifyDbName(dbName) {
    if (typeof dbName !== "string" || dbName.length === 0) return null;
    if (dbName === "kvgit") return "py";
    if (dbName.startsWith("kvgit/")) return "ts";
    return null;
}

/**
 * Enumerate bare branch names across both kernels' stores. Pure JS —
 * no kernel boot needed. Returns the union, filtered to chat-shaped
 * branches.
 *
 * Returns `[]` (silently) if `indexedDB.databases()` is unavailable
 * (older Firefox, hostile environments). The drawer in that case
 * falls back to the localStorage cache alone — degrades correctness
 * for cross-tab cases but stays functional.
 *
 * @returns {Promise<BareName[]>}
 */
export async function enumerateBareNames() {
    if (typeof indexedDB === "undefined" || !indexedDB.databases) return [];
    let dbs;
    try {
        dbs = await indexedDB.databases();
    } catch {
        return [];
    }
    const out = [];
    for (const db of dbs) {
        const kernel = classifyDbName(db.name);
        if (!kernel) continue;
        try {
            const names = await _readBranchNames(db.name);
            for (const branch of names) {
                if (branch.startsWith("chat-")) {
                    out.push({ kernel, branch });
                }
            }
        } catch (err) {
            // Failing to scan one store shouldn't break the union —
            // log and continue.
            console.warn(
                `[agex] session-index IDB scan failed for ${db.name}:`,
                err,
            );
        }
    }
    return out;
}

/**
 * Open `dbName` read-only and list keys with the `__branch_head__`
 * prefix; return the suffix part (the branch name).
 *
 * Doesn't trigger a schema upgrade — opens with no version arg so the
 * existing schema is reused. If the database doesn't exist or has no
 * `kv` object store, returns `[]` (the IDB upgrade callback would fire
 * and create the store, but we abort before writing anything).
 *
 * @param {string} dbName
 * @returns {Promise<string[]>}
 */
async function _readBranchNames(dbName) {
    const db = await new Promise((resolve, reject) => {
        // No version arg: open the existing version (whatever it is).
        // If the DB doesn't exist, it'll be created at version 1 with
        // no object stores — handled below.
        const req = indexedDB.open(dbName);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error("idb open failed"));
        req.onblocked = () => reject(new Error("idb open blocked"));
    });
    try {
        if (!db.objectStoreNames.contains(KVGIT_OBJECT_STORE)) return [];
        const tx = db.transaction(KVGIT_OBJECT_STORE, "readonly");
        const store = tx.objectStore(KVGIT_OBJECT_STORE);
        // Bound a key range for the `__branch_head__` prefix. `'￿'`
        // is the highest BMP code point — well beyond any sensible
        // suffix character.
        const range = IDBKeyRange.bound(
            BRANCH_HEAD_PREFIX,
            BRANCH_HEAD_PREFIX + "￿",
            false,
            false,
        );
        const keys = await new Promise((resolve, reject) => {
            const req = store.getAllKeys(range);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
            tx.onabort = () => reject(tx.error || new Error("tx aborted"));
        });
        return keys
            .map((k) => String(k))
            .map((k) => k.slice(BRANCH_HEAD_PREFIX.length))
            .filter((b) => b.length > 0);
    } finally {
        db.close();
    }
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * Diff cached records against the bare-name enumeration:
 *
 *   - `kept`: cache entries whose (kernel, branch) still exists in
 *     the IDB stores.
 *   - `missing`: bare names from IDB that have no cache entry yet.
 *     Caller (the shell, with help from a kernel adapter) is
 *     expected to fill these in via `cacheSession` once metadata
 *     can be read.
 *
 * Cache entries that no longer exist in IDB (deleted in another tab,
 * etc.) are dropped from `kept` — caller writes the result back via
 * `_writeCache` if it wants the cache to stay in sync. The simpler
 * `pruneCache` helper below combines reconcile + write.
 *
 * @param {SessionRecord[]} cached
 * @param {BareName[]} bare
 * @returns {{ kept: SessionRecord[], missing: BareName[] }}
 */
export function reconcileWithBareNames(cached, bare) {
    const liveSet = new Set(bare.map((b) => `${b.kernel}::${b.branch}`));
    const kept = cached.filter(
        (r) => liveSet.has(`${r.kernel}::${r.branch}`),
    );
    const cachedSet = new Set(
        cached.map((r) => `${r.kernel}::${r.branch}`),
    );
    const missing = bare.filter(
        (b) => !cachedSet.has(`${b.kernel}::${b.branch}`),
    );
    return { kept, missing };
}

/**
 * Convenience wrapper: reconcile the cache against the live IDB
 * enumeration, write the kept records back as the new cache, and
 * return both the kept records and the missing-metadata list.
 *
 * The drawer typically calls this on cold start so the rendered
 * state matches reality and the shell has a precise list of which
 * branches need metadata-fill from a kernel.
 *
 * @returns {Promise<{ kept: SessionRecord[], missing: BareName[] }>}
 */
export async function reconcileCache() {
    const cached = loadCache();
    const bare = await enumerateBareNames();
    const { kept, missing } = reconcileWithBareNames(cached, bare);
    if (kept.length !== cached.length) _writeCache(kept);
    return { kept, missing };
}
