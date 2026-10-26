/**
 * Questions put to the person, one open at a time for each key (an app's
 * session), shown from a table the page reads (`$state`, so the question
 * appears and goes as it opens and closes).
 *
 * A call that needs the person's answer waits on the open question, or
 * opens it; calls that come while it is open wait on the same answer. A
 * call whose signal aborts stops waiting at once, and the question is
 * taken back once no call waits on it.
 */

export class Questions {
    /** The calls waiting on each open question, by key.
     *  @type {Map<string, Set<(yes: boolean) => void>>} */
    #open = new Map();

    /** @param {Record<string, any>} table where each open question is
     *  shown, by key: the question's fields and its `answer` */
    constructor(table) {
        this.table = table;
    }

    /**
     * Wait for the person's answer to `key`'s question, opening it as
     * `question` if none is open. The question shows, with `answer(yes)`,
     * in the table under `key` as this returns.
     *
     * @param {string} key @param {Record<string, unknown>} question @param {AbortSignal} [signal]
     * @returns {Promise<boolean>} rejects with `signal`'s reason when it
     *   aborts first
     */
    wait(key, question, signal) {
        const table = this.table;
        const open = this.#open;
        return new Promise((resolve, reject) => {
            if (signal?.aborted) {
                reject(signal.reason);
                return;
            }
            /** @type {Set<(yes: boolean) => void>} */
            const waiters = open.get(key) ?? new Set();
            /** Close the question, if it is still this one. */
            const close = () => {
                if (open.get(key) !== waiters) return false;
                open.delete(key);
                delete table[key];
                return true;
            };
            if (!open.has(key)) {
                open.set(key, waiters);
                table[key] = {
                    ...question,
                    answer: (/** @type {boolean} */ yes) => {
                        // answered already, or taken back
                        if (close()) for (const waiter of waiters) waiter(yes);
                    },
                };
            }
            const onAbort = () => {
                waiters.delete(waiter);
                if (waiters.size === 0) close();
                reject(signal?.reason);
            };
            /** @param {boolean} yes */
            const waiter = (yes) => {
                signal?.removeEventListener("abort", onAbort);
                resolve(yes);
            };
            waiters.add(waiter);
            signal?.addEventListener("abort", onAbort, { once: true });
        });
    }
}
