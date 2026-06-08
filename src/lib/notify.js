/**
 * Desktop notifications for off-screen session completions.
 *
 * When a session finishes a turn while its result isn't on screen — a
 * different session is foreground, or the tab is hidden — fire a browser
 * notification so the user knows to come back. Clicking it focuses the
 * window and switches to that session.
 *
 * Scope honesty: the Notification API delivers while the tab is *open*
 * but backgrounded (and on most desktops while another app is focused).
 * It does NOT fire once the tab is closed — that needs a service worker
 * with Push, which is out of scope here. So this is "ping me when I've
 * tabbed away," not a true background push.
 *
 * Imperative singleton (no runes) so it can be driven from the plain
 * session-runtime loop. Gated on an opt-in settings flag plus the
 * platform permission grant.
 */

import { getSettings } from "./settings.js";

/** @type {((branch: string) => void) | null} */
let _onActivate = null;

export function notificationsSupported() {
    return typeof window !== "undefined" && "Notification" in window;
}

/** @returns {NotificationPermission} */
export function notificationPermission() {
    return notificationsSupported() ? Notification.permission : "denied";
}

/** Prompt for permission. Resolves to the resulting permission string.
 *  Safe to call when already granted/denied (returns the current state).
 */
export async function requestNotificationPermission() {
    if (!notificationsSupported()) return "denied";
    try {
        return await Notification.requestPermission();
    } catch {
        return Notification.permission;
    }
}

/** Register what happens when a notification is clicked — typically
 *  "switch the foreground session to `branch`." Set once from the shell. */
export function setNotificationActivateHandler(fn) {
    _onActivate = fn;
}

/**
 * Fire a completion notification, if appropriate. No-op unless the user
 * opted in, permission is granted, and the result is genuinely off-screen
 * (not the foreground session, or the tab is hidden).
 *
 * @param {{ branch: string, title?: string, foreground: boolean }} info
 */
export function notifyTurnComplete({ branch, title, foreground }) {
    if (!notificationsSupported()) return;
    if (Notification.permission !== "granted") return;
    if (!getSettings().notifyOnFinish) return;
    const hidden =
        typeof document !== "undefined" &&
        document.visibilityState === "hidden";
    // On screen = this session is foreground AND the tab is visible.
    // Only notify when at least one of those isn't true.
    if (foreground && !hidden) return;
    try {
        const n = new Notification("agex.studio", {
            body: `${title || "A session"} finished working`,
            // Per-session tag coalesces repeated finishes so a chatty
            // background session doesn't stack a pile of notifications.
            tag: `agex-session-${branch}`,
        });
        n.onclick = () => {
            try {
                window.focus();
            } catch {}
            if (_onActivate) _onActivate(branch);
            n.close();
        };
    } catch {
        // Construction can throw under some policies; stay silent.
    }
}
