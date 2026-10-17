/**
 * The page's side of the app databases: the tab's database worker
 * (`db-worker.js`), started on first use, and a client for each
 * database a session here has used, connected on first use and kept
 * until no session here needs it.
 *
 * Which database a session uses is the registry's to say (`app-db.js`):
 * a fork shares its parent's, and deleting a session drops its entry. A
 * delegate (`lead.scout`) works for the session it was asked by, and
 * uses that session's database: the registry names top-level sessions
 * only.
 * The database itself, its file and its log, stays after the last
 * session naming it is deleted, for a sweep of the databases no session
 * names to delete.
 */

import { connect } from "@agex-ts/kvsql/client";
import { dbOf, ensureDb, sessionsNaming, shareDb, unlinkDb } from "./app-db.js";
import { askPersist } from "./persist.js";
import { openStore } from "./store.js";
import { sweepTestDbs } from "./test-dbs.js";

/** @typedef {import("@agex-ts/kvsql/client").DatabaseClient} DatabaseClient */
/** @typedef {import("@agex-ts/kvsql/client").WorkerLike} WorkerLike */
/** @typedef {import("./app-db.js").DbRef} DbRef */

/** How a database names itself in its errors. */
export const DB_LABEL = "agex.db";

/**
 * The session whose database session `name` uses: itself, or for a
 * delegate (`lead.scout.notes`), the top-level session it works for.
 * @param {string} name
 */
export const dbOwner = (name) => name.split(".")[0] ?? name;

/** The tab's database worker, as Vite bundles it. */
async function startWorker() {
    const { default: url } = await import("./db-worker.js?worker&url");
    return new Worker(url, { type: "module", name: "agex-db" });
}

/**
 * A database as the session dialog shows it: its id, its file's size,
 * its tables, and the sessions naming it.
 * @typedef {{ id: string, bytes: number, tables: string[], sessions: string[] }} DbSummary
 */

/**
 * A database's client, and the sessions here that have asked for it.
 * @typedef {{ ref: DbRef, client: Promise<DatabaseClient>, users: Set<string> }} Held
 */

export class AppDbs {
    /** @type {() => Promise<import("@agex-ts/world").Store>} */
    #store;
    /** @type {() => Promise<WorkerLike>} */
    #start;
    /** @type {typeof connect} */
    #connect;
    /** @type {() => Promise<boolean>} */
    #persist;
    /** @type {() => Promise<unknown>} */
    #sweep;
    /** Whether this page has swept the copies closed tabs left. */
    #swept = false;
    /** @type {Promise<WorkerLike> | null} */
    #worker = null;
    /** Whether persistent storage has been asked for on this page. */
    #askedPersist = false;
    /** By database id. @type {Map<string, Held>} */
    #held = new Map();
    /** Each session's database, once looked up. @type {Map<string, Promise<DbRef>>} */
    #refs = new Map();
    /** Sessions deleted here, whose databases are never asked for again. @type {Set<string>} */
    #forgotten = new Set();

    /**
     * @param {{ store?: () => Promise<import("@agex-ts/world").Store>, start?: () => Promise<WorkerLike>, connect?: typeof connect, persist?: () => Promise<boolean>, sweep?: () => Promise<unknown> }} [deps]
     *   the store the registry is on, how the worker starts, how a
     *   client connects to it, how persistent storage is asked for, and
     *   how test copies left by closed tabs are swept (each replaceable
     *   in tests)
     */
    constructor({ store = openStore, start = startWorker, connect: connectTo = connect, persist = askPersist, sweep = sweepTestDbs } = {}) {
        this.#store = store;
        this.#start = start;
        this.#connect = connectTo;
        this.#persist = persist;
        this.#sweep = sweep;
    }

    /** The worker, started once; a start that failed is tried again next time. */
    #workerNow() {
        const starting = (this.#worker ??= this.#start());
        starting.catch(() => {
            if (this.#worker === starting) this.#worker = null;
        });
        return starting;
    }

    /** Session `name`'s database as the registry names it (named now if
     *  none is yet). @param {string} name */
    #refOf(name) {
        let ref = this.#refs.get(name);
        if (ref === undefined) {
            ref = this.#store().then((store) => ensureDb(store, name));
            this.#refs.set(name, ref);
            ref.catch(() => {
                if (this.#refs.get(name) === ref) this.#refs.delete(name);
            });
        }
        return ref;
    }

    /**
     * Session `name`'s database client: its database named in the
     * registry if it has none yet, the worker started and the client
     * connected on first use. Sessions naming the same database share
     * one client, as do a session and its delegates (`dbOwner`). A
     * deleted session has none.
     *
     * @param {string} session
     * @returns {Promise<DatabaseClient>}
     */
    async dbFor(session) {
        const name = dbOwner(session);
        this.#refuseForgotten(name);
        const ref = await this.#refOf(name);
        // deleted while its database was looked up: `forget` unlinks it
        this.#refuseForgotten(name);
        let held = this.#held.get(ref.id);
        if (held === undefined) {
            // the browser's storage is the database's only copy until sync
            // carries it: ask that it be kept, once a page, when an app
            // first keeps data
            if (!this.#askedPersist) {
                this.#askedPersist = true;
                void this.#persist().catch(() => {});
            }
            /** @type {Held} */
            const made = {
                ref,
                client: this.#workerNow().then((worker) =>
                    this.#connect(worker, { id: ref.id, branch: ref.branch, label: DB_LABEL }, {
                        onFlushError: (e) => console.warn(`${DB_LABEL} (${ref.id}): a flush failed; it is retried later:`, e),
                    }),
                ),
                users: new Set(),
            };
            made.client.catch(() => {
                if (this.#held.get(ref.id) === made) this.#held.delete(ref.id);
            });
            this.#held.set(ref.id, made);
            held = made;
        }
        held.users.add(name);
        return held.client;
    }

    /** @param {string} name */
    #refuseForgotten(name) {
        if (this.#forgotten.has(name)) throw new Error(`${DB_LABEL}: session ${name} is deleted`);
    }

    /**
     * A database of a test's own: a copy of session `name`'s (a
     * delegate's lead's) as it stands now, transactions not yet flushed
     * included, or an empty one if the session has none yet or `empty`
     * is asked. It is detached: what the test writes is recorded in no
     * log and never reaches the session's database. The caller deletes
     * it (`delete()`) when the test ends.
     *
     * @param {string} name
     * @param {{ empty?: boolean }} [options]
     * @returns {Promise<DatabaseClient>}
     */
    async testDb(name, { empty = false } = {}) {
        if (!this.#swept) {
            this.#swept = true;
            void this.#sweep().catch((e) => console.warn(`${DB_LABEL}: sweeping old test copies failed:`, e));
        }
        const bytes = crypto.getRandomValues(new Uint8Array(8));
        const id = `test-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
        const config = { id, label: DB_LABEL, detached: true };
        const owner = dbOwner(name);
        // looking names no database: a session without one tests on an empty one
        if (!empty && !this.#forgotten.has(owner) && (await dbOf(await this.#store(), owner)) !== null) {
            // made by the worker holding the session's database, in OPFS
            await (await this.dbFor(owner)).copy(config);
        }
        return this.#connect(await this.#workerNow(), config);
    }

    /**
     * Session `name`'s database as the session dialog shows it, or null
     * if it has none yet (looking names none).
     *
     * @param {string} name
     * @returns {Promise<DbSummary | null>}
     */
    async describe(name) {
        const owner = dbOwner(name);
        const store = await this.#store();
        const ref = await dbOf(store, owner);
        if (ref === null) return null;
        const db = await this.dbFor(owner);
        const [size, tables, sessions] = await Promise.all([
            db.query("SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()"),
            // the app's own: not SQLite's (`sqlite_*`) nor the log's (`_kvsql_*`)
            db.query("SELECT name FROM sqlite_schema WHERE type = 'table' AND substr(name, 1, 7) NOT IN ('sqlite_', '_kvsql_') ORDER BY name"),
            sessionsNaming(store, ref.id),
        ]);
        return {
            id: ref.id,
            bytes: Number(size.rows[0]?.bytes ?? 0),
            tables: tables.rows.map((r) => String(r.name)),
            sessions,
        };
    }

    /**
     * Session `name`'s database as a standalone SQLite file, without the
     * log's own tables, for any SQLite tool to open.
     *
     * @param {string} name
     */
    async exportFile(name) {
        return (await this.dbFor(name)).export();
    }

    /** The database ids this page holds a client for, each with the
     *  sessions using it. */
    held() {
        return new Map([...this.#held].map(([id, h]) => [id, [...h.users].sort()]));
    }

    /**
     * Session `name` no longer needs its database here (it was closed
     * or deleted): the client goes once no session here uses it, which
     * flushes and, in the tab writing the database, closes the file.
     *
     * @param {string} name
     */
    async release(name) {
        this.#refs.delete(name);
        /** @type {Held[]} */
        const unused = [];
        for (const [id, held] of this.#held) {
            if (!held.users.delete(name) || held.users.size > 0) continue;
            this.#held.delete(id);
            unused.push(held);
        }
        await Promise.all(
            unused.map(async ({ ref, client }) => {
                const open = await client.catch(() => null);
                await open?.close().catch((e) => console.warn(`${DB_LABEL} (${ref.id}): closing failed:`, e));
            }),
        );
    }

    /**
     * Fork `to` of session `from` names the same database as `from`. A
     * database this page looked up for `to` before is let go, so `to`'s
     * next use connects to `from`'s.
     *
     * Another tab that looked `to` up first keeps what it found, so
     * share before the fork exists, when no tab can have used it.
     *
     * @param {string} from
     * @param {string} to
     */
    async share(from, to) {
        await shareDb(await this.#store(), from, to);
        await this.release(to);
    }

    /**
     * Session `name` is deleted: its registry entry goes and its client
     * here is released. Its database stays, with its log, for a sweep of
     * the databases no session names (another session may still name it).
     * A lookup still in flight lands first, so the entry it makes goes
     * too, and the session's database is never asked for here again.
     *
     * @param {string} name
     */
    async forget(name) {
        this.#forgotten.add(name);
        await this.#refs.get(name)?.catch(() => null);
        await unlinkDb(await this.#store(), name);
        await this.release(name);
    }
}

/** This page's app databases. */
export const appDbs = new AppDbs();
