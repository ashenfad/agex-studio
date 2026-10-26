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
 *
 * What a database's older epochs, or a deleted database's log, alone
 * held stays in the store until a sweep: the worker asks for one
 * (`store-sweep.js`) when kvsql deletes either.
 *
 * It serves the procedures an app's kv stores run on (`app-kv.js`):
 * every tab's worker the same ones, since whichever holds a database
 * runs its calls.
 *
 * A test's copy (`detached: true` in its config) has no log: its file
 * is in OPFS under `agex-db-tests/<id>` (`test-dbs.js`), written by the
 * worker holding the database copied, which may be another tab's, and
 * removed when the test deletes it.
 */

import { Repo } from "@agex-ts/kvgit";
import { IndexedDB } from "@agex-ts/kvgit/backends/idb";
import { OpfsDirectory, serve } from "@agex-ts/kvsql";
import { KV_PROCEDURES } from "./app-kv.js";
import { STORE_DB } from "./store-name.js";
import { Sweeper } from "./store-sweep.js";
import { TEST_DB_ROOT } from "./test-dbs.js";

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

/** Sweeps of the store, after kvsql deleted a log's epochs. */
const sweeper = new Sweeper(async () => (await repo()).gc());

/** @typedef {import("@agex-ts/kvsql").DatabaseConfig} DbConfig */

/** Remove directory `id` of OPFS directory `parent`, if it's there. @param {string} parent @param {string} id */
async function removeDir(parent, id) {
    const root = await OpfsDirectory.at(parent);
    try {
        await root.handle.removeEntry(id, { recursive: true });
    } catch (e) {
        if (!(e instanceof DOMException && e.name === "NotFoundError")) throw e;
    }
}

serve(async (/** @type {DbConfig} */ config) => {
    const detached = config.detached === true;
    const parent = detached ? TEST_DB_ROOT : ROOT;
    return {
        dir: await OpfsDirectory.at(parent, config.id),
        // a test's copy has no log
        ...(!detached && { repo: await repo(), epochsDeleted: () => sweeper.request() }),
        // the log's branch is deleted by kvsql itself; the store is shared
        // with the sessions, so only the database's directory is its own
        destroy: async () => {
            await removeDir(parent, config.id);
            if (!detached) sweeper.request();
        },
    };
}, { procedures: KV_PROCEDURES });
