/**
 * A session as it is now, without its history: one commit from the
 * root holding what a commit holds, less what only makes sense with the
 * history behind it.
 *
 * Left out: the cache (it rebuilds), the agent's own git (its commits
 * are in the history that goes), and the studio's record of where each
 * turn started (what undo checks out, also in that history). The files,
 * the conversation, its folds, and the rest stay.
 */

import { CACHE_PREFIX, GIT_KEY, PLANE_PREFIX } from "@agex-ts/world";

/** The studio's per-turn undo points, on its plane. */
const TURNS_PREFIX = `${PLANE_PREFIX}studio/turns/`;

/** Whether a snapshot keeps `key`. @param {string} key */
export function kept(key) {
    return !key.startsWith(CACHE_PREFIX) && key !== GIT_KEY && !key.startsWith(TURNS_PREFIX);
}

/**
 * Branch `branch` (new) at a one-commit snapshot of commit `at`; its
 * head.
 *
 * @param {import("@agex-ts/world").Store} store
 * @param {string} at
 * @param {string} branch
 * @param {Record<string, unknown>} [info]
 */
export async function snapshotBranch(store, at, branch, info = {}) {
    const repo = store.repo;
    const source = await repo.snapshot({ commit: at });
    const keys = (await source.keys()).filter(kept);
    const values = await source.getMany(keys);
    await repo.branches.create(branch);
    const wt = await repo.worktree(branch);
    for (const [key, value] of values) wt.set(key, value);
    const result = await wt.commit({ info: { tool: "studio.snapshot", from: at, ...info } });
    return /** @type {string} */ (result.commit);
}
