/**
 * The studio's own notes in `localStorage`, read and written where it
 * may be blocked (a private window, site data turned off) or full: a
 * read that fails finds nothing, and a write that fails is dropped, so
 * what it held lasts only as long as the page keeps it.
 */

/** The text kept under `key`, or null. @param {string} key */
export function readLocal(key) {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

/**
 * Keep `value` under `key`: whether it was kept.
 *
 * @param {string} key
 * @param {string} value
 */
export function writeLocal(key, value) {
    try {
        localStorage.setItem(key, value);
        return true;
    } catch {
        return false;
    }
}

/** The JSON kept under `key`, parsed: null when there is none, or it
 *  doesn't parse. @param {string} key @returns {any} */
export function readLocalJson(key) {
    const raw = readLocal(key);
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

/**
 * Keep `value` under `key` as JSON: whether it was kept.
 *
 * @param {string} key
 * @param {unknown} value
 */
export function writeLocalJson(key, value) {
    return writeLocal(key, JSON.stringify(value));
}
