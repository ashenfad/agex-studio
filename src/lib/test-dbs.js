/**
 * Where a test's copies of app databases live: OPFS directory
 * `agex-db-tests/<id>`, one per copy, made by whichever tab's worker
 * holds the database copied (`db-worker.js`) and deleted after the
 * test. A tab closed mid-test leaves its copy behind; the sweep removes
 * those.
 */

/** The OPFS directory a test's copies are made in. */
export const TEST_DB_ROOT = "agex-db-tests";

/** A copy no tab has open, untouched this long, was left by a tab that closed mid-test. */
export const STALE_MS = 10 * 60_000;

/**
 * Remove the copies no tab has open (no worker holds or waits for their
 * Web Lock, `kvsql:<id>`) that haven't been written for `STALE_MS`: the
 * age spares a copy just made, which its tab hasn't opened yet.
 * Returns the ids removed.
 *
 * @param {{ root?: Promise<FileSystemDirectoryHandle> | FileSystemDirectoryHandle, locks?: { query(): Promise<{ held?: { name?: string }[], pending?: { name?: string }[] }> }, now?: number }} [deps]
 * @returns {Promise<string[]>}
 */
export async function sweepTestDbs({
    root = globalThis.navigator.storage.getDirectory(),
    locks = globalThis.navigator.locks,
    now = Date.now(),
} = {}) {
    /** @type {FileSystemDirectoryHandle} */
    let dir;
    try {
        dir = await (await root).getDirectoryHandle(TEST_DB_ROOT);
    } catch (e) {
        if (e instanceof DOMException && e.name === "NotFoundError") return [];
        throw e;
    }
    const snapshot = await locks.query();
    const open = new Set([...(snapshot.held ?? []), ...(snapshot.pending ?? [])].map((lock) => lock.name));
    /** @type {string[]} */
    const removed = [];
    for await (const [id, handle] of /** @type {AsyncIterable<[string, FileSystemHandle]>} */ (/** @type {any} */ (dir).entries())) {
        if (handle.kind !== "directory" || open.has(`kvsql:${id}`)) continue;
        if (now - (await lastWritten(/** @type {FileSystemDirectoryHandle} */ (handle))) < STALE_MS) continue;
        try {
            await dir.removeEntry(id, { recursive: true });
            removed.push(id);
        } catch {
            // opened meanwhile, or gone: a later sweep looks again
        }
    }
    return removed;
}

/** When a copy's files were last written; 0 for none. @param {FileSystemDirectoryHandle} dir */
async function lastWritten(dir) {
    let last = 0;
    for await (const [, handle] of /** @type {AsyncIterable<[string, FileSystemHandle]>} */ (/** @type {any} */ (dir).entries())) {
        if (handle.kind !== "file") continue;
        try {
            last = Math.max(last, (await /** @type {FileSystemFileHandle} */ (handle).getFile()).lastModified);
        } catch {
            // open in a worker: in use now
            return Number.POSITIVE_INFINITY;
        }
    }
    return last;
}
