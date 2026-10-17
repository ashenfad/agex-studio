/**
 * The app databases' worker: one per tab, serving every database the
 * tab connects to (`app-db-clients.js`), with one tab's worker writing
 * each database at a time (kvsql's Web Lock per database).
 *
 * A database's file is in the origin-private file system, under
 * `agex-db/<id>`; its changeset log is a branch of the studio's own
 * store, on the IndexedDB database every session lives in, so the logs
 * sit beside the sessions and sync from there without moving. The
 * branch comes in the database's config, as the registry names it.
 *
 * kvgit writes through compare-and-swap and its GC lease, both kept in
 * the store itself, so this worker's handle on the store and the
 * page's (and other tabs') write beside each other safely.
 */

import { Repo } from "@agex-ts/kvgit";
import { IndexedDB } from "@agex-ts/kvgit/backends/idb";
import { OpfsDirectory, serve } from "@agex-ts/kvsql";
import { STORE_DB } from "./store-name.js";

/** The OPFS directory every database's directory is made in. */
const ROOT = "agex-db";

/**
 * The store's repository, opened once for the worker and shared by
 * every database it opens: the log is bytes, stored as they are.
 *
 * @type {Promise<Repo<Uint8Array>> | null}
 */
let opening = null;

function repo() {
    opening ??= IndexedDB.open({ dbName: STORE_DB })
        .then((kv) => Repo.open(kv, { codec: "bytes" }))
        .catch((e) => {
            opening = null;
            throw e;
        });
    return opening;
}

serve(async (config) => ({
    dir: await OpfsDirectory.at(ROOT, config.id),
    repo: await repo(),
    // the log's branch is deleted by kvsql itself; the store is shared
    // with the sessions, so only the database's directory is its own
    async destroy() {
        const root = await OpfsDirectory.at(ROOT);
        try {
            await root.handle.removeEntry(config.id, { recursive: true });
        } catch (e) {
            if (!(e instanceof DOMException && e.name === "NotFoundError")) throw e;
        }
    },
}));
