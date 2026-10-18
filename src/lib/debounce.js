/**
 * Jobs by key, each run a moment after its last call, but no later than
 * `most` after the first call since it last ran: a key called again and
 * again, faster than its delay, still runs.
 */
export class Debouncer {
    /** @type {Map<string, { timer: ReturnType<typeof setTimeout>, first: number }>} */
    #pending = new Map();

    /** @param {number} most */
    constructor(most) {
        this.most = most;
    }

    /**
     * Run `job` for `key` after `delay`, in place of one scheduled
     * already, or sooner, once `most` has passed since the first call.
     * @param {string} key @param {number} delay @param {() => void} job
     */
    schedule(key, delay, job) {
        const now = Date.now();
        const pending = this.#pending.get(key);
        const first = pending?.first ?? now;
        clearTimeout(pending?.timer);
        const timer = setTimeout(
            () => {
                this.#pending.delete(key);
                job();
            },
            Math.max(0, Math.min(delay, first + this.most - now)),
        );
        this.#pending.set(key, { timer, first });
    }

    /** Drop every job scheduled. */
    clear() {
        for (const p of this.#pending.values()) clearTimeout(p.timer);
        this.#pending.clear();
    }
}
