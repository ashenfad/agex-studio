/**
 * The page's side of the app databases: the tab's database worker
 * (`db-worker.js`), started on first use, and a client for each
 * database a session here has used, connected on first use and kept
 * until no session here needs it.
 *
 * Which database a session uses is the registry's to say (`app-db.js`):
 * a fork shares its parent's, and deleting a session drops its entry.
 * The database itself, its file and its log, stays after the last
 * session naming it is deleted, for a sweep of the databases no session
 * names to delete.
 */

import { connect } from "@agex-ts/kvsql/client";
import { ensureDb, shareDb, unlinkDb } from "./app-db.js";
import { openStore } from "./store.js";

/** @typedef {import("@agex-ts/kvsql/client").DatabaseClient} DatabaseClient */
/** @typedef {import("@agex-ts/kvsql/client").WorkerLike} WorkerLike */
/** @typedef {import("./app-db.js").DbRef} DbRef */

/** How a database names itself in its errors. */
export const DB_LABEL = "agex.db";

/** The tab's database worker, as Vite bundles it. */
async function startWorker() {
    const { default: url } = await import("./db-worker.js?worker&url");
    return new Worker(url, { type: "module", name: "agex-db" });
}

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
    /** @type {Promise<WorkerLike> | null} */
    #worker = null;
    /** By database id. @type {Map<string, Held>} */
    #held = new Map();
    /** Each session's database, once looked up. @type {Map<string, Promise<DbRef>>} */
    #refs = new Map();
    /** Sessions deleted here, whose databases are never asked for again. @type {Set<string>} */
    #forgotten = new Set();

    /**
     * @param {{ store?: () => Promise<import("@agex-ts/world").Store>, start?: () => Promise<WorkerLike>, connect?: typeof connect }} [deps]
     *   the store the registry is on, how the worker starts and how a
     *   client connects to it (each replaceable in tests)
     */
    constructor({ store = openStore, start = startWorker, connect: connectTo = connect } = {}) {
        this.#store = store;
        this.#start = start;
        this.#connect = connectTo;
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
     * one client. A deleted session has none.
     *
     * @param {string} name
     * @returns {Promise<DatabaseClient>}
     */
    async dbFor(name) {
        this.#refuseForgotten(name);
        const ref = await this.#refOf(name);
        // deleted while its database was looked up: `forget` unlinks it
        this.#refuseForgotten(name);
        let held = this.#held.get(ref.id);
        if (held === undefined) {
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
