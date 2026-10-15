/**
 * Sync's bookkeeping that needs no page: what a session's sync state
 * says of the repo, and the sync heads a change of repo would leave
 * wrong.
 */

import { clearSyncHead } from "@agex-ts/kvgit";

/**
 * A session's sync, as its row shows it. `held`: whether the repo held
 * the session's branch when last looked at.
 *
 * @typedef {{ state: "pending" | "syncing" | "synced" | "diverged" | "remote-gone" | "error", detail: string, at: number, held: boolean }} SyncState
 */

/**
 * A session's sync state, now `state`. A sync that ended says whether
 * the repo holds the branch (it does once synced or diverged, and
 * doesn't once gone); one waiting, under way or failed says nothing
 * new, so what was known before carries over.
 *
 * @param {SyncState | undefined} prev
 * @param {SyncState["state"]} state
 * @param {string} [detail]
 * @param {number} [at]
 * @returns {SyncState}
 */
export function nextState(prev, state, detail = "", at = Date.now()) {
    const held = state === "synced" || state === "diverged" ? true : state === "remote-gone" ? false : (prev?.held ?? false);
    return { state, detail, at, held };
}

/**
 * Make the store's sync heads repo `name`'s. Each says what a branch
 * last shared with the repo it was recorded against, so read against
 * another repo, every branch would look like one that repo lost: when
 * the repo noted differs, they all go. With none noted (heads recorded
 * before the repo was), they're taken as `name`'s. Whether any went.
 *
 * @param {{ store: import("@agex-ts/kvgit").KVStore, branches: { list(): Promise<string[]> } }} repo
 * @param {string} name
 * @param {{ get(): string | null, set(name: string): void }} noted where the repo is noted
 */
export async function adoptRepo(repo, name, noted) {
    const was = noted.get();
    if (was === name) return false;
    if (was !== null) {
        for (const branch of await repo.branches.list()) await clearSyncHead(repo.store, branch);
    }
    noted.set(name);
    return was !== null;
}

/**
 * A note kept in localStorage under `key`, and in this page's memory
 * too, so it holds for the page's life where localStorage is blocked.
 *
 * @param {string} key
 * @returns {{ get(): string | null, set(value: string): void }}
 */
export function localNote(key) {
    /** @type {string | null} */
    let page = null;
    return {
        get() {
            try {
                return localStorage.getItem(key) ?? page;
            } catch {
                return page;
            }
        },
        set(value) {
            page = value;
            try {
                localStorage.setItem(key, value);
            } catch {
                // noted for this page only
            }
        },
    };
}
