/**
 * Sync's bookkeeping that needs no page: what a session's sync state
 * says of the repo, and the sync heads kept with no repo named, which a
 * change of repo would leave wrong.
 */

import { clearSyncHead } from "@agex-ts/kvgit";
import { readLocal, writeLocal } from "./local.js";

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
 * Make repo `name` the one noted. A sync head says what a branch last
 * shared with a repo, and each is kept under the repo it's with, so
 * another repo never reads it, and a repo connected again picks up
 * where it left off. Heads kept before that are under no repo, and are
 * taken up by the first repo to sync the branch: they were the noted
 * repo's, so when the repo noted differs, they go, and the new repo
 * doesn't take each branch as one it lost. With none noted (heads
 * recorded before the repo was), they're `name`'s. Whether the repo
 * noted changed.
 *
 * @param {{ store: import("@agex-ts/kvgit").KVStore, branches: { list(): Promise<string[]> } }} repo
 * @param {string} name
 * @param {{ get(): string | null, set(name: string): void }} noted where the repo is noted
 */
export async function adoptRepo(repo, name, noted) {
    const was = noted.get();
    if (was === name) return false;
    if (was !== null) {
        // a remote with no id names the heads kept under none
        for (const branch of await repo.branches.list()) await clearSyncHead(repo.store, branch, {});
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
            return readLocal(key) ?? page;
        },
        set(value) {
            page = value;
            writeLocal(key, value);
        },
    };
}
