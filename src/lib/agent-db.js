/**
 * `db`, a host object: the session's app database, for the agent's
 * code. It is the database the session's app reaches as `agex.db`
 * (`app-db-clients.js`), so the agent can see what the app stored,
 * debug it, seed it and migrate it. Its writes go through the same
 * worker, lock and log as the app's.
 *
 * A delegate's code reaches its lead's database, as its app does. A
 * world that isn't a studio session (a task's scratch world, which can
 * inherit the agent's host objects) has none: its calls are refused
 * rather than naming a database for it.
 *
 * Checkpoints are kvsql's: `checkpoint(label)` names the database's
 * state now, and the database takes one itself before each schema
 * change. `restore(id)` goes back to one, discarding everything written
 * since, so it waits for the person to allow it (`db-restore.svelte.js`);
 * the app reloads after.
 */

import { hostFactory, typedHost } from "@agex-ts/world";
import { z } from "zod";
import { appDbs as defaultDbs, dbOwner } from "./app-db-clients.js";
import { dbRestores } from "./db-restore.svelte.js";
import { openStore } from "./store.js";

/** @typedef {import("@agex-ts/world").Workspace} Workspace */
/** @typedef {import("@agex-ts/kvsql/client").DatabaseClient} DatabaseClient */
/** @typedef {import("@agex-ts/kvsql/client").Checkpoint} Checkpoint */

/** A checkpoint as the agent's code sees it: its time as an ISO string. @param {Checkpoint} c */
const shown = (c) => ({ id: c.id, label: c.label, auto: c.auto, time: new Date(c.time).toISOString(), seq: c.seq });

/** One session's app database, as the agent's code reaches it. */
export class AgentDb {
    /** @type {Promise<DatabaseClient> | null} */
    #client = null;

    /**
     * @param {Workspace} ws
     * @param {{ dbs?: Pick<import("./app-db-clients.js").AppDbs, "dbFor" | "restore">, store?: () => Promise<import("@agex-ts/world").Store>, ask?: typeof dbRestores.ask }} [deps]
     */
    constructor(ws, { dbs = defaultDbs, store = openStore, ask = (owner, asker, cp) => dbRestores.ask(owner, asker, cp) } = {}) {
        this._ws = ws;
        this._dbs = dbs;
        this._store = store;
        this._ask = ask;
    }

    /** The session's database client: once its session is known to be
     *  one of the studio's. A lookup that failed is tried again. */
    _db() {
        const opening = (this.#client ??= (async () => {
            const owner = dbOwner(this._ws.session);
            const store = await this._store();
            if (!(await store.repo.branches.has(owner))) {
                throw new Error("db: this world isn't a studio session, so it has no app database");
            }
            return this._dbs.dbFor(owner);
        })());
        opening.catch(() => {
            if (this.#client === opening) this.#client = null;
        });
        return opening;
    }

    /**
     * Run one statement as a transaction: `{ rows, changes,
     * lastInsertRowid }`.
     *
     * @param {string} sql
     * @param {unknown[] | Record<string, unknown> | null} [params]
     */
    query = async (sql, params = null) => (await this._db()).query(sql, /** @type {any} */ (params ?? null));

    /**
     * Run statements as one transaction, all or none: each one's result.
     * A statement is `[sql, params?]`, or its SQL alone.
     *
     * @param {(string | [string, (unknown[] | Record<string, unknown> | null)?])[]} statements
     */
    transaction = async (statements) =>
        (await this._db()).transaction(/** @type {any} */ (statements.map((s) => (typeof s === "string" ? [s] : s))));

    /**
     * The app's tables, views, indexes and triggers, each with its SQL:
     * `sqlite_schema` without SQLite's own (`sqlite_*`) and the log's
     * (`_kvsql_*`), which can't be queried.
     */
    tables = async () => {
        const { rows } = await (await this._db()).query(
            "SELECT type, name, tbl_name AS \"table\", sql FROM sqlite_schema WHERE substr(name, 1, 7) NOT IN ('sqlite_', '_kvsql_') ORDER BY tbl_name, type = 'table' DESC, name",
        );
        return rows;
    };

    /**
     * Name the database's state now, to `restore` to later: `{ id,
     * label, auto, time, seq }`.
     *
     * @param {string} [label] what it's before, say
     */
    checkpoint = async (label = "") => shown(await (await this._db()).checkpoint(label));

    /**
     * The database's checkpoints, oldest first: those taken with
     * `checkpoint`, and the last ten the database took itself before
     * schema changes (`auto`, labelled with the change).
     */
    checkpoints = async () => (await (await this._db()).checkpoints()).map(shown);

    /**
     * Bring the database back to checkpoint `id`, discarding everything
     * written since: once the person allows it, which they are asked to
     * in the app's tab (a database already there needs no asking). The
     * app reloads after. `{ how, undone }`: how many transactions were
     * undone.
     *
     * @param {string} id
     */
    restore = async (id) => {
        const db = await this._db();
        const checkpoint = (await db.checkpoints()).find((c) => c.id === id);
        if (checkpoint === undefined) {
            throw new Error(`db.restore: there's no checkpoint ${JSON.stringify(id)}; db.checkpoints() lists them`);
        }
        const info = await db.info();
        if (info.base !== checkpoint.commit || info.pendingCount > 0) {
            const owner = dbOwner(this._ws.session);
            const { label, auto, time } = checkpoint;
            if (!(await this._ask(owner, this._ws.session, { id, label, auto, time }))) {
                throw new Error(
                    "db.restore: the person kept the database as it is: they didn't allow the restore (or the turn ended before they answered). Don't ask again unless they say so.",
                );
            }
        }
        const result = await this._dbs.restore(this._ws.session, id);
        return { how: result.how, undone: result.undone, checkpoint: shown(result.checkpoint) };
    };
}

const params = z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())]).nullish();

/** `db` as the profile grants it: one per session, its arguments
 *  checked (the database checks the rest). */
export function dbHost() {
    return typedHost(hostFactory((ws) => new AgentDb(ws)), {
        query: { args: { sql: z.string(), params } },
        transaction: {
            args: { statements: z.array(z.union([z.string(), z.tuple([z.string()]).rest(z.unknown())])) },
        },
        tables: {},
        checkpoint: { args: { label: z.string().optional() } },
        checkpoints: {},
        restore: { args: { id: z.string() } },
    });
}
