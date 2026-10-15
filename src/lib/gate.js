/**
 * Who has a session's workspace to itself: a turn, a fold, a sync, or
 * an edit (an undo, a redo, files added, an interrupted turn set aside).
 * One at a time, so none runs beside another and reads or writes the
 * workspace under it.
 *
 * Each taker says what it gives way to: a message sent while a turn
 * holds the session rides that turn as a note, and a fold asked for
 * then isn't wanted at all; it waits for anything else to let go. The
 * check and the take are one step, so nothing can start between them.
 *
 * @typedef {"turn" | "fold" | "sync" | "edit"} Holder
 */

export class Gate {
    /** @type {Holder | null} */
    #holder = null;
    /** Settles when the holder lets go. */
    #free = Promise.resolve();
    /** Called each time the gate is let go. */
    onFree = () => {};

    /** What holds the session now, if anything. */
    get holder() {
        return this.#holder;
    }

    /**
     * Take the gate for `kind`, if nothing holds it: the function that
     * lets it go (once), or null.
     *
     * @param {Holder} kind
     * @returns {(() => void) | null}
     */
    tryTake(kind) {
        if (this.#holder !== null) return null;
        this.#holder = kind;
        /** @type {() => void} */
        let open = () => {};
        this.#free = new Promise((resolve) => (open = resolve));
        let done = false;
        return () => {
            if (done) return;
            done = true;
            this.#holder = null;
            open();
            this.onFree();
        };
    }

    /**
     * Take the gate for `kind`, waiting for whatever holds it to let go;
     * null instead, at once, whenever one of `yieldTo` holds it, or when
     * `ready` says, as the gate comes free, there's nothing to do. Taken,
     * the taker goes ahead: nothing holds the session that won't run.
     *
     * @param {Holder} kind
     * @param {readonly Holder[]} [yieldTo]
     * @param {() => boolean} [ready]
     * @returns {Promise<(() => void) | null>}
     */
    async take(kind, yieldTo = [], ready = () => true) {
        for (;;) {
            if (this.#holder !== null && yieldTo.includes(this.#holder)) return null;
            if (this.#holder === null) return ready() ? this.tryTake(kind) : null;
            await this.#free;
        }
    }

    /**
     * Settles once none of `kinds` holds the gate.
     *
     * @param {readonly Holder[]} kinds
     */
    async clearOf(kinds) {
        while (this.#holder !== null && kinds.includes(this.#holder)) await this.#free;
    }
}

/** A session's workspace is a turn's or a fold's, so what asked for it
 *  doesn't run. */
export class SessionBusy extends Error {
    constructor() {
        super("a turn is running in that session; stop it first");
        this.name = "SessionBusy";
    }
}
