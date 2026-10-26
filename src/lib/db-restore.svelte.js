/**
 * Restoring an app's database to a checkpoint, as the page sees it.
 *
 * A restore discards everything written since the checkpoint, possibly
 * by the person using the app right now, so the agent's restores wait
 * for the person's say: the question shows with the app (`AppPreview`),
 * as an app's asking to use the model does, and goes unanswered (a no)
 * if the turn that asked ends first. A restore the person starts from
 * the session dialog is their say already.
 *
 * After any restore the apps on that database reload, here and in
 * every other tab (a `BroadcastChannel`): what they hold in memory is
 * from before it. A sync that brought another device's changes to a
 * database is announced the same way, as a sync: an app with work in
 * flight (`agex.busy`) is offered the reload instead (`app-busy.js`).
 */

/** The channel restores are announced on, across the origin's tabs. */
const CHANNEL = "agex-db-restored";

/**
 * Why a database changed under its apps: the person (or the agent, with
 * their say) restored it, or a sync brought another device's changes.
 * @typedef {"restore" | "sync"} DbChange
 */

/**
 * A checkpoint as the question names it.
 * @typedef {{ id: string, label: string, auto: boolean, time: number }} AskedCheckpoint
 */

class DbRestores {
    /**
     * Restores the agent asks for, waiting on the person: by the
     * database's id (forks may share one), each with the session that
     * asked.
     * @type {Record<string, { checkpoint: AskedCheckpoint, asker: string, answer: (yes: boolean) => void }>}
     */
    asking = $state({});
    /** The last restore (or sync that changed a database) this page
     *  heard of: its database's id, why it changed, and a count past
     *  which an app built before it reloads. */
    restored = $state({ count: 0, id: /** @type {string | null} */ (null), cause: /** @type {DbChange} */ ("restore") });
    /** @type {BroadcastChannel | null} */
    #channel = null;

    constructor() {
        if (typeof BroadcastChannel !== "function") return;
        this.#channel = new BroadcastChannel(CHANNEL);
        // in Node (tests), an open channel would keep the process alive
        /** @type {{ unref?: () => void }} */ (/** @type {unknown} */ (this.#channel)).unref?.();
        this.#channel.onmessage = (e) => {
            if (typeof e.data?.id === "string") this.#heard(e.data.id, e.data.cause === "sync" ? "sync" : "restore");
        };
    }

    /**
     * Ask the person whether app database `id` may go back to
     * `checkpoint`, for session `asker` (the agent's, or a delegate's):
     * true if they allow it. One question per database at a time, from
     * whichever session sharing it asks.
     *
     * @param {string} id @param {string} asker @param {AskedCheckpoint} checkpoint
     * @returns {Promise<boolean>}
     */
    ask(id, asker, checkpoint) {
        if (this.asking[id] !== undefined) {
            return Promise.reject(new Error("another restore of this database is waiting on the person"));
        }
        return new Promise((resolve) => {
            this.asking[id] = {
                checkpoint,
                asker,
                answer: (yes) => {
                    delete this.asking[id];
                    resolve(yes);
                },
            };
        });
    }

    /** Session `asker`'s turn ended: a question it left open is a no. @param {string} asker */
    cancel(asker) {
        for (const open of Object.values(this.asking)) if (open.asker === asker) open.answer(false);
    }

    /**
     * Database `id` was restored here, or a sync here changed it: its
     * apps reload, in every tab (a busy one, after a sync, is offered
     * the reload).
     * @param {string} id @param {DbChange} [cause]
     */
    announce(id, cause = "restore") {
        this.#heard(id, cause);
        this.#channel?.postMessage({ id, cause });
    }

    /** @param {string} id @param {DbChange} cause */
    #heard(id, cause) {
        this.restored = { count: this.restored.count + 1, id, cause };
    }
}

/** This page's restores. */
export const dbRestores = new DbRestores();
