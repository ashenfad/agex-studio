/**
 * Which app database each session names: a registry on a branch of the
 * store of its own, `dbs/registry`.
 *
 * An app's database is external state: an undo doesn't rewind it, a
 * fork shares it (or takes a copy of its own), and bundles and
 * publishing never carry it. So the
 * link from a session to its database can't live in the session's
 * history, where undoing past the turn that made the app would forget
 * it and leave the data unnamed. It lives here instead:
 *
 * - `session/<name>` → the database's id (`db-<hex>`), named on first
 *   use, so a fork can name the same database and a delete leaves it
 *   be. A session's first database takes an id hashed from the
 *   session's name, so two devices that each first use a synced
 *   session name the same database, whose logs sync merges, rather
 *   than two that a merged registry would have to choose between. A
 *   fork's own copy, made on one device, takes a random id;
 * - `db/<id>` → `{ branch }`, the store branch holding the database's
 *   changeset log (`db/<id>/0`).
 *
 * Neither branch name is a session id (both hold a `/`), so the store
 * never lists them as sessions; the sync takes them up apart from the
 * sessions (`db-sync.js`).
 */

import { BranchMovedError } from "@agex-ts/kvgit";

/** @typedef {import("@agex-ts/world").Store} Store */
/** @typedef {import("@agex-ts/kvgit").Worktree<unknown>} Worktree */
/** @typedef {import("@agex-ts/kvgit").Repo<unknown>} Repo */

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

/**
 * The id of session `name`'s first database: `db-` and 16 hex digits
 * of a hash of the name, the same on every device.
 * @param {string} name
 */
export async function firstDbId(name) {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`agex.db/${name}`));
    return `db-${Array.from(new Uint8Array(hash, 0, 8), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** A random database id: `db-` and 16 hex digits. */
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
 * Change the registry in `repo` with `fn`, committing what it set or
 * deleted. A commit another tab's write beat is redone from the new
 * tip, so `fn` must decide from what it reads, not from what it read
 * before.
 *
 * @template T
 * @param {Repo} repo
 * @param {(wt: Worktree) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function edit(repo, fn) {
    for (let attempt = 1; ; attempt++) {
        const wt = await repo.worktree(REGISTRY, { create: true });
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
 * Name session `name`'s first database in `wt`. @param {Worktree} wt
 * @param {string} name
 * @returns {Promise<DbRef>}
 */
async function mint(wt, name) {
    const id = await firstDbId(name);
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
    return (await dbOf(store, name)) ?? edit(store.repo, async (wt) => (await lookup(wt, name)) ?? mint(wt, name));
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
    return edit(store.repo, async (wt) => {
        const ref = (await lookup(wt, from)) ?? (await mint(wt, from));
        wt.set(sessionKey(to), ref.id);
        return ref;
    });
}

/**
 * Make session `to` (a fork, before it exists) name database `ref`, a
 * copy made for it whose log is already on `ref.branch`.
 *
 * @param {Store} store
 * @param {string} to
 * @param {DbRef} ref
 */
export async function nameDb(store, to, ref) {
    await edit(store.repo, async (wt) => {
        wt.set(dbKey(ref.id), { branch: ref.branch });
        wt.set(sessionKey(to), ref.id);
    });
}

/**
 * Drop session `name`'s entry (it is being deleted). Its database stays,
 * with its log, until a sweep deletes the databases no session names
 * (`appDbs.sweepUnnamed`).
 * What the entry named, and whether another session still names it;
 * null if it named none.
 *
 * @param {Store} store
 * @param {string} name
 * @returns {Promise<{ ref: DbRef, named: boolean } | null>}
 */
export async function unlinkDb(store, name) {
    if (!(await store.repo.branches.has(REGISTRY))) return null;
    return edit(store.repo, async (wt) => {
        const ref = await lookup(wt, name);
        if (ref === null) return null;
        await wt.delete(sessionKey(name));
        return { ref, named: (await namersIn(wt, ref.id)).length > 0 };
    });
}

/**
 * Sessions `names`' entries in the registry in `repo`, each with the
 * record of the database it names: what a sync keeps of the sessions
 * here (`keepEntries`).
 *
 * @param {Repo} repo
 * @param {string[]} names
 * @returns {Promise<Map<string, { id: string, record: unknown }>>}
 */
export async function entriesOf(repo, names) {
    /** @type {Map<string, { id: string, record: unknown }>} */
    const out = new Map();
    if (!(await repo.branches.has(REGISTRY))) return out;
    const read = await repo.snapshot({ branch: REGISTRY });
    for (const name of names) {
        const id = await read.get(sessionKey(name));
        if (typeof id === "string") out.set(name, { id, record: await read.get(dbKey(id)) });
    }
    return out;
}

/**
 * Put back the entries of `entries` (from `entriesOf`) the registry in
 * `repo` no longer has, of sessions still in it: another device that
 * deleted a session for good, from its sync repo's trash, takes its
 * entry from the merged registry, though the session lives on here.
 * Whether any came back.
 *
 * @param {Repo} repo
 * @param {Map<string, { id: string, record: unknown }>} entries
 */
export async function keepEntries(repo, entries) {
    if (entries.size === 0) return false;
    return edit(repo, async (wt) => {
        let back = false;
        for (const [name, { id, record }] of entries) {
            // gone here meanwhile, its entry went with it
            if ((await wt.get(sessionKey(name))) !== undefined || !(await repo.branches.has(name))) continue;
            wt.set(sessionKey(name), id);
            if ((await wt.get(dbKey(id))) === undefined && record !== undefined) wt.set(dbKey(id), record);
            back = true;
        }
        return back;
    });
}

/**
 * The databases the registry records that no session names: a session
 * deleted for good (here, or from the sync repo's trash) leaves its
 * database so. A copy made for a fork is recorded with its name, in one
 * step, so a copy not yet named isn't among them.
 *
 * @param {Store} store
 * @returns {Promise<DbRef[]>}
 */
export async function unnamedDbs(store) {
    if (!(await store.repo.branches.has(REGISTRY))) return [];
    const read = await store.repo.snapshot({ branch: REGISTRY });
    const keys = await read.keys();
    const values = await read.getMany(keys);
    const named = new Set(keys.filter((k) => k.startsWith("session/")).map((k) => values.get(k)));
    return keys
        .filter((k) => k.startsWith("db/") && !named.has(k.slice("db/".length)))
        .map((k) => {
            const id = k.slice("db/".length);
            const record = /** @type {{ branch?: unknown } | undefined} */ (values.get(k));
            return { id, branch: typeof record?.branch === "string" ? record.branch : dbBranch(id) };
        });
}

/**
 * Drop database `id`'s record, its database deleted, unless a session
 * names it again; whether it went.
 *
 * @param {Store} store
 * @param {string} id
 */
export async function dropDbRecord(store, id) {
    return edit(store.repo, async (wt) => {
        if ((await namersIn(wt, id)).length > 0) return false;
        await wt.delete(dbKey(id));
        return true;
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
