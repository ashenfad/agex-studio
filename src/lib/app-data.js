/**
 * An app's saved data (its localStorage, as the studio keeps it: see
 * `app-storage.js`) on a branch of its own, `appdata/<session>`, so it
 * syncs between devices beside the session without being part of it:
 * the session's history, its bundles and what it publishes don't carry
 * it.
 *
 * The branch's one value, `bag`, is the app's storage as a dict with
 * `at`, when it was written on the device that wrote it: two devices
 * that both wrote settle on the later (last writer wins). A session
 * name can't hold a `/`, so the branch is never listed as a session.
 */

/** The branches' prefix. */
export const APP_DATA = "appdata/";

/** Session `name`'s app-data branch. @param {string} name */
export const appBranch = (name) => `${APP_DATA}${name}`;

/**
 * @typedef {{ bag: Record<string, string>, at: number }} AppData
 */

/**
 * The app data a commit or a branch holds, or null for none.
 *
 * @param {import("@agex-ts/world").Store} store
 * @param {{ branch: string } | { commit: string }} ref
 * @returns {Promise<AppData | null>}
 */
export async function readAppData(store, ref) {
    if ("branch" in ref && !(await store.repo.branches.has(ref.branch))) return null;
    const value = /** @type {any} */ (await (await store.repo.snapshot(ref)).get("bag"));
    if (value === undefined || value === null || typeof value.bag !== "object") return null;
    return { bag: value.bag, at: typeof value.at === "number" ? value.at : 0 };
}

/** @param {Record<string, string>} a @param {Record<string, string>} b */
function same(a, b) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

/**
 * Commit `data` to session `name`'s app-data branch when it differs
 * from what the branch holds (creating the branch for data that isn't
 * empty); whether it committed.
 *
 * @param {import("@agex-ts/world").Store} store
 * @param {string} name
 * @param {AppData} data
 */
export async function commitAppData(store, name, data) {
    const branch = appBranch(name);
    const held = await readAppData(store, { branch });
    if (held === null && Object.keys(data.bag).length === 0) return false;
    if (held !== null && same(held.bag, data.bag)) return false;
    const wt = await store.repo.worktree(branch, { create: true });
    wt.set("bag", { bag: data.bag, at: data.at });
    await wt.commit({ info: { tool: "studio.app-data", at: data.at } });
    return true;
}

/**
 * Point session `name`'s app-data branch at `commit` (another device's,
 * which needn't descend from it).
 *
 * @param {import("@agex-ts/world").Store} store
 * @param {string} name
 * @param {string} commit
 */
export async function moveAppData(store, name, commit) {
    const branch = appBranch(name);
    if (await store.repo.branches.has(branch)) await store.repo.branches.delete(branch);
    await store.repo.branches.create(branch, commit);
}
