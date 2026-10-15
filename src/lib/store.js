/**
 * The world's store, on IndexedDB, and what the studio keeps of its own
 * in it.
 *
 * A session is a branch of the store. What the studio keeps of its own
 * goes on the session's `studio` plane, so it rewinds with a checkout
 * and comes along on a fork: `meta` (title, when it was made and last
 * used), `turns/<runId>` (the head a turn started from, which is what
 * undoing that turn checks out), `source` (where an imported session
 * came from), `published` (the gist it was published to) and
 * `delegates/<name>` (each delegate asked, and whether its answer was
 * read).
 */

import { IndexedDB } from "@agex-ts/kvgit/backends/idb";
import { Store } from "@agex-ts/world";

/** @typedef {import("@agex-ts/world").Workspace} Workspace */

/** The IndexedDB database every session lives in. */
export const DB_NAME = "agex-studio";

/** The plane the studio keeps its own records on. */
export const PLANE = "studio";

/** @type {Promise<Store> | null} */
let opening = null;

/** The store, opened once. */
export function openStore() {
    opening ??= IndexedDB.open({ dbName: DB_NAME }).then((kv) => Store.open(kv));
    return opening;
}

/**
 * A session as the list shows it. `source` says where an imported one
 * came from (the head of the bundle it was made from), so opening the
 * same bundle again finds it: kept on the plane apart from `meta`,
 * which a turn and a rename rewrite.
 * @typedef {{ name: string, title: string, createdAt: number, updatedAt: number, source?: SessionSource }} SessionInfo
 * @typedef {{ head: string, gist?: import("./gist.js").GistRef & { pinned: boolean } }} SessionSource
 */

/** A new session's name: a session id, never a delegate's (no dot). */
export function newName() {
    return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Session `ws` as the list shows it. @param {Workspace} ws */
export async function metaOf(ws) {
    const plane = ws.plane(PLANE);
    const meta = /** @type {Partial<SessionInfo> | null} */ (await plane.get("meta"));
    const source = /** @type {SessionInfo["source"] | null} */ (await plane.get("source"));
    return {
        name: ws.session,
        title: meta?.title ?? "",
        createdAt: meta?.createdAt ?? 0,
        updatedAt: meta?.updatedAt ?? meta?.createdAt ?? 0,
        ...(source && { source }),
    };
}

/**
 * Make `child`, just forked, a session of its own: `meta` its record,
 * `source` where it came from (an import's bundle), else none, and never
 * what its parent published; committed as `tool`.
 *
 * @param {Workspace} child
 * @param {Record<string, unknown>} meta
 * @param {SessionSource | undefined} source
 * @param {string} tool
 */
export async function settleFork(child, meta, source, tool) {
    const plane = child.plane(PLANE);
    plane.set("meta", meta);
    if (source !== undefined) plane.set("source", source);
    else await plane.delete("source");
    await plane.delete("published");
    await child.autoCommit({ tool });
}
