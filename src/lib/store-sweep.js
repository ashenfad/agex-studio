import { Debouncer } from "./debounce.js";

/** How long after the last ask a sweep runs. */
export const SWEEP_DELAY = 60_000;

/** The longest a sweep waits while asks keep coming. */
const SWEEP_MAX_WAIT = 10 * 60_000;

/**
 * How long after a sweep it sweeps again: past the hour a sweep keeps
 * what went, by kvgit's default `minAge`.
 */
export const SWEEP_AGAIN = 61 * 60_000;

/**
 * Sweeps of the store (kvgit's `gc`), asked for when something large
 * went from it (a database's older epochs, a deleted database): one a
 * while after the last ask rather than one per ask, since a sweep reads
 * every commit in the store and its writers wait while it runs. What
 * was written less than an hour before stays at a sweep (undo's redo
 * still reaches it), so each one asked for is followed by one more an
 * hour on, which takes what that one kept. A page closed first leaves
 * it for a later sweep.
 */
export class Sweeper {
    #asks = new Debouncer(SWEEP_MAX_WAIT);
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    #again;

    /**
     * @param {() => Promise<unknown>} sweep
     * @param {{ delay?: number, again?: number }} [timing]
     */
    constructor(sweep, { delay = SWEEP_DELAY, again = SWEEP_AGAIN } = {}) {
        this.sweep = sweep;
        this.delay = delay;
        this.again = again;
    }

    /** Sweep a while from now, and again an hour after. */
    request() {
        this.#asks.schedule("sweep", this.delay, () => {
            this.#run();
            clearTimeout(this.#again);
            this.#again = setTimeout(() => this.#run(), this.again);
        });
    }

    #run() {
        void this.sweep().catch((e) => console.warn("sweeping the store failed:", e));
    }

    /** Drop the sweeps asked for. */
    clear() {
        this.#asks.clear();
        clearTimeout(this.#again);
    }
}
