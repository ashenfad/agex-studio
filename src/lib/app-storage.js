/**
 * App-storage — per-session key/value bag for iframe apps' localStorage shim.
 *
 * Backed by the studio's own `localStorage`. Each entry lives at
 * `agex-app:<kernel>:<branch>:<key>` so different sessions don't
 * collide; every bag today is the `ts` kernel's.
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

const PREFIX = 'agex-app:';
const SEP = ':';

/** @typedef {'py' | 'ts'} Kernel */

function _branchPrefix(/** @type {Kernel} */ kernel, /** @type {string} */ branch) {
    return PREFIX + kernel + SEP + branch + SEP;
}

/**
 * Read all entries for the (kernel, branch) bag as a flat dict.
 * Empty dict if nothing's stored.
 *
 * @param {Kernel} kernel
 * @param {string} branch
 * @returns {Record<string, string>}
 */
export function read(kernel, branch) {
    const out = /** @type {Record<string, string>} */ ({});
    const prefix = _branchPrefix(kernel, branch);
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
 * Replace the (kernel, branch) bag entirely with the given dict. Wipes
 * any prior entries for the bag, then writes each key/value as a
 * separate localStorage entry. All or nothing: when a write fails (the
 * studio's storage is full), the bag is put back as it was and the
 * error thrown.
 *
 * @param {Kernel} kernel
 * @param {string} branch
 * @param {Record<string, string>} data
 */
export function write(kernel, branch, data) {
    const before = read(kernel, branch);
    const prefix = _branchPrefix(kernel, branch);
    remove(kernel, branch);
    try {
        for (const [k, v] of Object.entries(data)) {
            localStorage.setItem(prefix + k, String(v));
        }
    } catch (e) {
        remove(kernel, branch);
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
 * Remove every entry in the (kernel, branch) bag.
 *
 * @param {Kernel} kernel
 * @param {string} branch
 */
export function remove(kernel, branch) {
    const prefix = _branchPrefix(kernel, branch);
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
 * Total bytes consumed by the (kernel, branch) bag — sum of app-key
 * lengths and value lengths (excludes the prefix, since that's
 * implementation detail, not user-meaningful storage).
 *
 * Used by the session drawer to render the "· app" badge and by the
 * session-settings modal to render the reset confirmation copy.
 *
 * @param {Kernel} kernel
 * @param {string} branch
 * @returns {number}
 */
export function size(kernel, branch) {
    let total = 0;
    const prefix = _branchPrefix(kernel, branch);
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith(prefix)) continue;
        const v = localStorage.getItem(k);
        total += (k.length - prefix.length) + (v ? v.length : 0);
    }
    return total;
}

/**
 * Copy all entries from one (kernel, branch) bag to another. Used by
 * `forkSession` so the fork's app starts with the same saved state as
 * the source.
 *
 * Both branches are assumed to live under the same kernel — forks
 * don't migrate kernels.
 *
 * @param {Kernel} kernel
 * @param {string} srcBranch
 * @param {string} dstBranch
 */
export function copy(kernel, srcBranch, dstBranch) {
    const data = read(kernel, srcBranch);
    if (Object.keys(data).length === 0) return;
    write(kernel, dstBranch, data);
}

/**
 * Wipe every app-storage entry across all sessions. Used by the
 * "Purge all data" flow alongside IDB / cache deletion. Preserves
 * unrelated localStorage entries (settings, API keys, UI prefs).
 */
export function clearAll() {
    const toDelete = [];
    for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(PREFIX)) toDelete.push(k);
    }
    for (const k of toDelete) localStorage.removeItem(k);
}
