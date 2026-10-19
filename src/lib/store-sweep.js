import { Debouncer } from "./debounce.js";

/** How long after the last ask a sweep runs. */
export const SWEEP_DELAY = 60_000;

/** The longest a sweep waits while asks keep coming. */
const SWEEP_MAX_WAIT = 10 * 60_000;

/**
 * Sweeps of the store (kvgit's `gc`), asked for when something large
 * went from it (a database's older epochs, a deleted database): one a
 * while after the last ask rather than one per ask, since a sweep reads
 * every commit in the store and its writers wait while it runs. What
 * went less than an hour ago stays for a later sweep (undo's redo still
 * reaches it).
 */
export class Sweeper {
    #asks = new Debouncer(SWEEP_MAX_WAIT);

    /** @param {() => Promise<unknown>} sweep @param {number} [delay] */
    constructor(sweep, delay = SWEEP_DELAY) {
        this.sweep = sweep;
        this.delay = delay;
    }

    /** Sweep a while from now. */
    request() {
        this.#asks.schedule("sweep", this.delay, () => {
            void this.sweep().catch((e) => console.warn("sweeping the store failed:", e));
        });
    }

    /** Drop a sweep asked for. */
    clear() {
        this.#asks.clear();
    }
}
