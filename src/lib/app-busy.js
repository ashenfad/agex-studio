/**
 * Work an app marks in flight (`agex.busy(promise)`), and what the live
 * preview does when the app's database changes under it.
 *
 * The page counts the promises it was given that haven't settled yet,
 * and posts the count (`agex-busy`) each time it changes. A restore
 * reloads the app whatever it is doing: the person asked for it. A sync
 * that brought another device's changes reloads an idle app, and offers
 * the reload to one with work in flight, which a reload would cut off.
 * The offer stays once the work settles, until the person takes it or
 * the page loads again: a reload then would land as the person reads
 * what the work did or starts on the next thing.
 */

/**
 * What the preview does when its app's database changed under it. A sync
 * while a reload is already offered keeps offering it, busy or not: the
 * offer stands until the person takes it.
 *
 * @param {import("./db-restore.svelte.js").DbChange} cause
 * @param {number} busy the app's work in flight
 * @param {boolean} [offered] whether a reload is offered already
 * @returns {"reload" | "offer"}
 */
export function afterDbChange(cause, busy, offered = false) {
    return cause === "sync" && (busy > 0 || offered) ? "offer" : "reload";
}

/**
 * The count an `agex-busy` message carries: a whole number above 0, or
 * 0 for anything else.
 *
 * @param {unknown} value
 */
export function busyCount(value) {
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
}

/** @typedef {{ busy: number, offered: boolean }} LiveBusy */

/** @type {(() => LiveBusy) | null} */
let _liveBusy = null;

/** The live preview says how to read its app's busy state, or that it's gone (null).
 *  @param {(() => LiveBusy) | null} fn */
export function setLiveBusy(fn) {
    _liveBusy = fn;
}

/** The live preview's app: its work in flight, and whether a reload a
 *  sync brought is offered rather than done; null without a preview. */
export function liveBusy() {
    return _liveBusy === null ? null : _liveBusy();
}
