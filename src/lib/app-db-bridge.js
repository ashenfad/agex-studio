/**
 * The studio's side of an app's `agex.db` calls (the shim in
 * `app-html.js`): each `agex-db` message is a call on a database
 * client, answered by an `agex-db-result` carrying its value or its
 * error.
 *
 * Which database answers is the host's to say, from the frame the
 * message came from, never from anything in the message: the preview
 * answers on its session's database, a hidden test on a scratch one.
 */

import { errorText } from "./errors.js";

/** @typedef {import("@agex-ts/kvsql/client").DatabaseClient} DatabaseClient */

/** The calls an app may make. */
const OPS = new Set(["query", "transaction"]);

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
 * Whether a call's result (`answerDb`'s `value`) changed any rows: a
 * query's, or any statement of a transaction's.
 *
 * @param {unknown} value
 */
export function wroteRows(value) {
    const results = Array.isArray(value) ? value : [value];
    return results.some((r) => Number(/** @type {{ changes?: unknown } | null} */ (r)?.changes ?? 0) > 0);
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
        const client = await db();
        const value =
            op === "query"
                ? await client.query(/** @type {string} */ (args[0]), /** @type {any} */ (args[1] ?? null))
                : await client.transaction(/** @type {any} */ (args[0]));
        return { type: "agex-db-result", id, value, error: null };
    } catch (e) {
        return { type: "agex-db-result", id, value: null, error: dbError(e) };
    }
}
