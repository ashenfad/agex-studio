/**
 * Is the studio actually in front of the user right now?
 *
 * "On screen" = the tab is visible AND the window has focus. Visibility
 * alone misses switching to another app/window (the tab stays "visible"
 * but unfocused); focus alone misses switching tabs within the same
 * window. Both together mean "the user is looking at us."
 *
 * Plain on-demand check (no state, no listeners) shared by the
 * notification gate (notify.js) and the unseen-result logic
 * (session-runtime / ChatShell) so they agree on what "the user saw it"
 * means — a turn that finishes while the user is tabbed/app'd away counts
 * as unseen even if its session is the foreground one.
 *
 * @returns {boolean}
 */
export function isOnScreen() {
    if (typeof document === "undefined") return true;
    const visible = document.visibilityState !== "hidden";
    const focused =
        typeof document.hasFocus !== "function" || document.hasFocus();
    return visible && focused;
}
