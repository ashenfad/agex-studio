/**
 * App-storage — per-session key/value bag for iframe apps' localStorage shim.
 *
 * Backed by the studio's own `localStorage`. Each entry lives at
 * `agex-app:ts:<branch>:<key>` so different sessions don't collide.
 * The `ts` segment is fixed, and stays so the bags already kept are
 * still found.
 *
 * Quota: the iframe shim holds a bag to `APP_STORAGE_QUOTA`, measured
 * as its JSON. The bag reaches the studio in a message the app's page
 * posts, which the app can post itself, so the studio checks it again
 * (`checkBag`) before writing it. Multi-session users could in theory
 * exhaust the origin's quota across many bags; a write that runs out
 * of room leaves the bag as it was.
 */

/** The most a bag holds, as the length of its JSON. */
export const APP_STORAGE_QUOTA = 5 * 1024 * 1024;

const PREFIX = 'agex-app:ts:';

function _branchPrefix(/** @type {string} */ branch) {
    return PREFIX + branch + ':';
}

/**
 * Read all entries for the branch's bag as a flat dict.
 * Empty dict if nothing's stored.
 *
 * @param {string} branch
 * @returns {Record<string, string>}
 */
export function read(branch) {
    const out = /** @type {Record<string, string>} */ ({});
    const prefix = _branchPrefix(branch);
    for (let i = 0; i < localStorage.length; i++) {
        const fullKey = localStorage.key(i);
        if (!fullKey || !fullKey.startsWith(prefix)) continue;
        const appKey = fullKey.slice(prefix.length);
        const val = localStorage.getItem(fullKey);
        if (val !== null) out[appKey] = val;
    }
    return out;
}

/**
 * Replace the branch's bag entirely with the given dict. Wipes
 * any prior entries for the bag, then writes each key/value as a
 * separate localStorage entry. All or nothing: when a write fails (the
 * studio's storage is full), the bag is put back as it was and the
 * error thrown.
 *
 * @param {string} branch
 * @param {Record<string, string>} data
 */
export function write(branch, data) {
    const before = read(branch);
    const prefix = _branchPrefix(branch);
    remove(branch);
    try {
        for (const [k, v] of Object.entries(data)) {
            localStorage.setItem(prefix + k, String(v));
        }
    } catch (e) {
        remove(branch);
        for (const [k, v] of Object.entries(before)) {
            localStorage.setItem(prefix + k, v);
        }
        throw e;
    }
}

/**
 * `data` as a bag fit to write, or null: a plain object of string
 * values whose JSON is within `APP_STORAGE_QUOTA`, as the shim keeps
 * it. Anything else posted as an app's storage is refused whole.
 *
 * @param {unknown} data
 * @returns {Record<string, string> | null}
 */
export function checkBag(data) {
    if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
    if (Object.getPrototypeOf(data) !== Object.prototype && Object.getPrototypeOf(data) !== null) return null;
    const bag = /** @type {Record<string, unknown>} */ (data);
    if (!Object.values(bag).every((v) => typeof v === "string")) return null;
    if (JSON.stringify(bag).length > APP_STORAGE_QUOTA) return null;
    return /** @type {Record<string, string>} */ (bag);
}

/**
 * Remove every entry in the branch's bag.
 *
 * @param {string} branch
 */
export function remove(branch) {
    const prefix = _branchPrefix(branch);
    // Two-pass: collect keys, then delete. localStorage indices shift
    // when we remove during iteration, so the single-pass form would
    // skip entries.
    const toDelete = [];
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) toDelete.push(k);
    }
    for (const k of toDelete) localStorage.removeItem(k);
}

/**
 * Copy all entries from one branch's bag to another, so a
 * fork's app starts with the same saved state as the session it came
 * from.
 *
 * @param {string} srcBranch
 * @param {string} dstBranch
 */
export function copy(srcBranch, dstBranch) {
    const data = read(srcBranch);
    if (Object.keys(data).length === 0) return;
    write(dstBranch, data);
}
