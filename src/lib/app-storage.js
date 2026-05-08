/**
 * App-storage — per-session key/value bag for iframe apps' localStorage shim.
 *
 * Backed by the parent's `localStorage` directly. Each entry lives at
 * `agex-app:<kernel>:<branch>:<key>` so different sessions don't collide
 * and the py / ts kernels keep separate namespaces (in anticipation of
 * the unified-app split — today everything is `py`).
 *
 * History note: pre-Phase-4 design lived in kvgit's raw KV store under
 * `__app_storage__<branch>`. That worked for the agex-py kernel but
 * would have required a new public API on agex-ts (raw KV access on
 * versioned backends). Moving to the parent's localStorage:
 *
 *   - keeps both kernels uniform (no per-kernel app-storage wiring)
 *   - sidesteps expanding agex-ts's public API
 *   - drops bundle export of app-storage (intentional — the previous
 *     design was non-versioned anyway, so no agent-undo behavior is
 *     lost; bundling can be re-added later by reading back the
 *     prefixed entries if it ever matters)
 *
 * Quota: localStorage is ~5MB per origin in most browsers. The iframe
 * shim already enforces a 5MB-per-bag check (matching the original
 * `app_storage.py` quota), and posts here only when within bounds, so
 * this module doesn't double-enforce. Multi-session users could in
 * theory exhaust origin quota across many bags; that's acceptable
 * given typical usage and is the same constraint anyone using
 * `localStorage` directly would face.
 */

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
 * separate localStorage entry.
 *
 * @param {Kernel} kernel
 * @param {string} branch
 * @param {Record<string, string>} data
 */
export function write(kernel, branch, data) {
    remove(kernel, branch);
    const prefix = _branchPrefix(kernel, branch);
    for (const [k, v] of Object.entries(data)) {
        localStorage.setItem(prefix + k, String(v));
    }
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
