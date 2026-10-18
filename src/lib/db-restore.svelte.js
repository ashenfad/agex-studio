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
 * from before it.
 */

/** The channel restores are announced on, across the origin's tabs. */
const CHANNEL = "agex-db-restored";

/**
 * A checkpoint as the question names it.
 * @typedef {{ id: string, label: string, auto: boolean, time: number }} AskedCheckpoint
 */

class DbRestores {
    /**
     * Restores the agent asks for, waiting on the person: by the session
     * whose app's database it is (a delegate asks for its lead's), each
     * with the session that asked.
     * @type {Record<string, { checkpoint: AskedCheckpoint, asker: string, answer: (yes: boolean) => void }>}
     */
    asking = $state({});
    /** The last restore this page heard of: its database's id, and a
     *  count past which an app built before it reloads. */
    restored = $state({ count: 0, id: /** @type {string | null} */ (null) });
    /** @type {BroadcastChannel | null} */
    #channel = null;

    constructor() {
        if (typeof BroadcastChannel !== "function") return;
        this.#channel = new BroadcastChannel(CHANNEL);
        // in Node (tests), an open channel would keep the process alive
        /** @type {{ unref?: () => void }} */ (/** @type {unknown} */ (this.#channel)).unref?.();
        this.#channel.onmessage = (e) => {
            if (typeof e.data?.id === "string") this.#heard(e.data.id);
        };
    }

    /**
     * Ask the person whether session `owner`'s app database may go back
     * to `checkpoint`, for session `asker` (the agent's, or a
     * delegate's): true if they allow it. One question per database at a
     * time.
     *
     * @param {string} owner @param {string} asker @param {AskedCheckpoint} checkpoint
     * @returns {Promise<boolean>}
     */
    ask(owner, asker, checkpoint) {
        if (this.asking[owner] !== undefined) {
            return Promise.reject(new Error("another restore of this database is waiting on the person"));
        }
        return new Promise((resolve) => {
            this.asking[owner] = {
                checkpoint,
                asker,
                answer: (yes) => {
                    delete this.asking[owner];
                    resolve(yes);
                },
            };
        });
    }

    /** Session `asker`'s turn ended: a question it left open is a no. @param {string} asker */
    cancel(asker) {
        for (const open of Object.values(this.asking)) if (open.asker === asker) open.answer(false);
    }

    /** Database `id` was restored here: its apps reload, in every tab. @param {string} id */
    announce(id) {
        this.#heard(id);
        this.#channel?.postMessage({ id });
    }

    /** @param {string} id */
    #heard(id) {
        this.restored = { count: this.restored.count + 1, id };
    }
}

/** This page's restores. */
export const dbRestores = new DbRestores();
