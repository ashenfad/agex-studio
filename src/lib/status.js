/**
 * A session's status, as its row in the session list and the tab's icon
 * show it: `working` while a turn or a fold runs; `attention` when a turn
 * ended failed or interrupted while the person wasn't looking; `unseen`
 * when a turn ended, otherwise, while they weren't. Kept in the page
 * only, never stored.
 */

/** @typedef {"working" | "attention" | "unseen"} Status */

/** What each status says, for a tooltip. @type {Record<Status, string>} */
export const STATUS_TITLES = {
    working: "Working…",
    attention: "Ended with an error while you were away",
    unseen: "Finished while you were away",
};

/**
 * Whether the person can see the page: its tab visible and its window
 * focused. A tab stays visible behind another app's window, so
 * visibility alone isn't enough; `hasFocus()` is false in a hidden tab
 * too. Outside a browser, always.
 *
 * @param {Pick<Document, "visibilityState" | "hasFocus"> | undefined} [doc]
 */
export function onScreen(doc = globalThis.document) {
    if (doc === undefined) return true;
    return doc.visibilityState !== "hidden" && doc.hasFocus();
}

/**
 * Whether the person is looking at a session: it's the one shown, and
 * the page is on screen. A turn that ends while they aren't leaves the
 * session unseen.
 *
 * @param {boolean} current whether the session is the one shown
 * @param {Pick<Document, "visibilityState" | "hasFocus"> | undefined} [doc]
 */
export function looking(current, doc = globalThis.document) {
    return current && onScreen(doc);
}

/**
 * @typedef {{ busy: boolean, folding: boolean, attention: boolean, unseen: boolean }} StatusSource
 */

/** A session's status, or null when there's nothing to say.
 *  @param {StatusSource} s @returns {Status | null} */
export function statusOf(s) {
    if (s.busy || s.folding) return "working";
    if (s.attention) return "attention";
    if (s.unseen) return "unseen";
    return null;
}

/** The most pressing of several sessions' statuses: working, then
 *  attention, then unseen. @param {Iterable<StatusSource>} sessions
 *  @returns {Status | null} */
export function overall(sessions) {
    /** @type {Status | null} */
    let best = null;
    for (const s of sessions) {
        const status = statusOf(s);
        if (status === "working") return status;
        if (status === "attention" || (status === "unseen" && best === null)) best = status;
    }
    return best;
}
