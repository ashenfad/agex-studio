/**
 * Which app database each session names: a registry on a branch of the
 * store of its own, `dbs/registry`.
 *
 * An app's database is external state: an undo doesn't rewind it, a
 * fork shares it, and bundles and publishing never carry it. So the
 * link from a session to its database can't live in the session's
 * history, where undoing past the turn that made the app would forget
 * it and leave the data unnamed. It lives here instead:
 *
 * - `session/<name>` → the database's id (`db-<hex>`), minted on first
 *   use and never spelled from a session name, so a fork can name the
 *   same database and a rename or a delete leaves it be;
 * - `db/<id>` → `{ branch }`, the store branch holding the database's
 *   changeset log (`db/<id>/0`).
 *
 * Neither branch name is a session id (both hold a `/`), so the store
 * never lists them as sessions, and sync, which pushes sessions and
 * their `appdata/` branches by name, leaves them on this device.
 */

import { BranchMovedError } from "@agex-ts/kvgit";

/** @typedef {import("@agex-ts/world").Store} Store */
/** @typedef {import("@agex-ts/kvgit").Worktree<unknown>} Worktree */

/** The registry's branch. */
export const REGISTRY = "dbs/registry";

/** The prefix of every database's log branch. */
export const DB_BRANCHES = "db/";

/**
 * Database `id`'s log branch: `db/<id>/0`, its first epoch. Later
 * epochs (a new snapshot and the log since it) are `db/<id>/<n>`, and a
 * git remote can't hold `db/<id>` beside refs under it, so even the
 * first log sits one level down.
 * @param {string} id
 */
export const dbBranch = (id) => `${DB_BRANCHES}${id}/0`;

/** The registry key naming session `name`'s database. @param {string} name */
const sessionKey = (name) => `session/${name}`;

/** The registry key recording database `id`. @param {string} id */
const dbKey = (id) => `db/${id}`;

/** How many times a registry write is redone after another tab's lands first. */
const ATTEMPTS = 5;

/**
 * A database as the registry names it.
 * @typedef {{ id: string, branch: string }} DbRef
 */

/** A new database's id: `db-` and 16 random hex digits. */
export function newDbId() {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    return `db-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Session `name`'s database in `read` (a snapshot or a worktree of the
 * registry), or null if it names none.
 *
 * @param {{ get(key: string): Promise<unknown> }} read
 * @param {string} name
 * @returns {Promise<DbRef | null>}
 */
async function lookup(read, name) {
    const id = await read.get(sessionKey(name));
    if (typeof id !== "string") return null;
    const record = /** @type {{ branch?: unknown } | undefined} */ (await read.get(dbKey(id)));
    return { id, branch: typeof record?.branch === "string" ? record.branch : dbBranch(id) };
}

/**
 * Session `name`'s database, or null if it names none yet. Creates
 * nothing.
 *
 * @param {Store} store
 * @param {string} name
 */
export async function dbOf(store, name) {
    if (!(await store.repo.branches.has(REGISTRY))) return null;
    return lookup(await store.repo.snapshot({ branch: REGISTRY }), name);
}

/**
 * Change the registry with `fn`, committing what it set or deleted. A
 * commit another tab's write beat is redone from the new tip, so `fn`
 * must decide from what it reads, not from what it read before.
 *
 * @template T
 * @param {Store} store
 * @param {(wt: Worktree) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function edit(store, fn) {
    for (let attempt = 1; ; attempt++) {
        const wt = await store.repo.worktree(REGISTRY, { create: true });
        const out = await fn(wt);
        if (wt.status().clean) return out;
        try {
            await wt.commit({ onMoved: "raise", info: { tool: "studio.dbs" } });
            return out;
        } catch (e) {
            if (!(e instanceof BranchMovedError) || attempt >= ATTEMPTS) throw e;
        }
    }
}

/**
 * Name a new database for session `name` in `wt`. @param {Worktree} wt
 * @param {string} name
 * @returns {DbRef}
 */
function mint(wt, name) {
    const id = newDbId();
    const branch = dbBranch(id);
    wt.set(dbKey(id), { branch });
    wt.set(sessionKey(name), id);
    return { id, branch };
}

/**
 * Session `name`'s database, named now if it names none: the same one
 * in every tab, whichever names it first.
 *
 * @param {Store} store
 * @param {string} name
 * @returns {Promise<DbRef>}
 */
export async function ensureDb(store, name) {
    return (await dbOf(store, name)) ?? edit(store, async (wt) => (await lookup(wt, name)) ?? mint(wt, name));
}

/**
 * Make session `to` (a fork of `from`) name `from`'s database, naming
 * one for `from` first if it has none, so the two share it whichever
 * of them uses it first.
 *
 * @param {Store} store
 * @param {string} from
 * @param {string} to
 * @returns {Promise<DbRef>}
 */
export async function shareDb(store, from, to) {
    return edit(store, async (wt) => {
        const ref = (await lookup(wt, from)) ?? mint(wt, from);
        wt.set(sessionKey(to), ref.id);
        return ref;
    });
}

/**
 * Drop session `name`'s entry (it is being deleted). Its database stays,
 * with its log, until a sweep deletes the databases no session names.
 * What the entry named, and whether another session still names it;
 * null if it named none.
 *
 * @param {Store} store
 * @param {string} name
 * @returns {Promise<{ ref: DbRef, named: boolean } | null>}
 */
export async function unlinkDb(store, name) {
    if (!(await store.repo.branches.has(REGISTRY))) return null;
    return edit(store, async (wt) => {
        const ref = await lookup(wt, name);
        if (ref === null) return null;
        await wt.delete(sessionKey(name));
        return { ref, named: (await namersIn(wt, ref.id)).length > 0 };
    });
}

/**
 * The sessions naming database `id`, sorted.
 *
 * @param {Store} store
 * @param {string} id
 */
export async function sessionsNaming(store, id) {
    if (!(await store.repo.branches.has(REGISTRY))) return [];
    return namersIn(await store.repo.snapshot({ branch: REGISTRY }), id);
}

/**
 * @param {{ keys(): Promise<string[]>, getMany(keys: Iterable<string>): Promise<Map<string, unknown>> }} read
 * @param {string} id
 */
async function namersIn(read, id) {
    const keys = (await read.keys()).filter((k) => k.startsWith("session/"));
    const values = await read.getMany(keys);
    return keys.filter((k) => values.get(k) === id).map((k) => k.slice("session/".length)).sort();
}
