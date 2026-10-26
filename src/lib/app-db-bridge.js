/**
 * The studio's side of an app's `agex.db` calls (the shim in
 * `app-html.js`): each `agex-db` message is a call on a database
 * client, answered by an `agex-db-result` carrying its value or its
 * error.
 *
 * An app's kv store (`agex.kvStore`) comes the same way, as the call
 * `kv`: its method, then `{ store, ... }`, run as one of the database's
 * procedures (`app-kv.js`).
 *
 * Which database answers is the host's to say, from the frame the
 * message came from, never from anything in the message: the preview
 * answers on its session's database, a hidden test on a scratch one.
 */

import { KV_METHODS, KV_WRITES, kvCall } from "./app-kv.js";
import { errorText } from "./errors.js";

/** @typedef {import("@agex-ts/kvsql/client").DatabaseClient} DatabaseClient */

/** The calls an app may make. */
const OPS = new Set(["query", "transaction", "kv"]);

/**
 * An error as the app's page rebuilds it: its name, its message, and a
 * failed transaction's statement index.
 *
 * @param {unknown} e
 * @returns {{ name: string, message: string, index?: number }}
 */
export function dbError(e) {
    const name = e instanceof Error ? e.name : "Error";
    const index = /** @type {{ index?: unknown }} */ (e)?.index;
    return typeof index === "number" ? { name, message: errorText(e), index } : { name, message: errorText(e) };
}

/**
 * Whether an app's `agex-db` call `data`, answered with `reply`, may
 * have changed the database: it succeeded, and changed rows, or ran
 * anything but a plain read (a schema change changes no rows).
 *
 * @param {{ op?: unknown, args?: unknown }} data
 * @param {{ value: unknown, error: unknown }} reply
 */
export function mayHaveWritten(data, reply) {
    if (reply.error !== null) return false;
    // a store's write, unless a comparison failed and it wrote nothing
    if (data.op === "kv") return KV_WRITES.has(String(Array.isArray(data.args) ? data.args[0] : "")) && reply.value !== false;
    const results = Array.isArray(reply.value) ? reply.value : [reply.value];
    if (results.some((r) => Number(/** @type {{ changes?: unknown } | null} */ (r)?.changes ?? 0) > 0)) return true;
    const args = Array.isArray(data.args) ? data.args : [];
    const sqls = data.op === "transaction" ? (Array.isArray(args[0]) ? args[0] : []).map((s) => (Array.isArray(s) ? s[0] : s)) : [args[0]];
    return sqls.some((sql) => !/^\s*(SELECT|EXPLAIN|VALUES)\b/i.test(String(sql ?? "")));
}

/**
 * Answer the app's `agex-db` message `data` on the database `db` gives:
 * the reply to post back to its frame. A call that isn't one of
 * `agex.db`'s is answered with an error, as is any the database fails.
 *
 * @param {{ id?: unknown, op?: unknown, args?: unknown }} data
 * @param {() => Promise<DatabaseClient>} db
 * @returns {Promise<{ type: "agex-db-result", id: unknown, value: unknown, error: ReturnType<typeof dbError> | null }>}
 */
export async function answerDb(data, db) {
    const { id, op, args } = data;
    try {
        if (typeof op !== "string" || !OPS.has(op) || !Array.isArray(args)) {
            throw new TypeError(`agex.db has no call ${JSON.stringify(op)}: use agex.db.query or agex.db.transaction`);
        }
        if (op === "kv" && !(typeof args[0] === "string" && KV_METHODS.has(args[0]) && args[1] !== null && typeof args[1] === "object")) {
            throw new TypeError(`agex.kvStore has no call ${JSON.stringify(args[0])}`);
        }
        const client = await db();
        const value =
            op === "query"
                ? await client.query(/** @type {string} */ (args[0]), /** @type {any} */ (args[1] ?? null))
                : op === "kv"
                  ? await kvCall(client, /** @type {string} */ (args[0]), /** @type {Record<string, unknown>} */ (args[1]))
                  : await client.transaction(/** @type {any} */ (args[0]));
        return { type: "agex-db-result", id, value, error: null };
    } catch (e) {
        return { type: "agex-db-result", id, value: null, error: dbError(e) };
    }
}
