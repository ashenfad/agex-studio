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
import { isOnScreen } from "./presence.js";

/** @type {((branch: string) => void) | null} */
let _onActivate = null;

/** The app glyph from public/favicon.svg — keep in sync. */
const _ICON_PATH =
    "M8,3A2,2 0 0,0 6,5V9A2,2 0 0,1 4,11H3V13H4A2,2 0 0,1 6,15V19A2,2 0 0,0 8,21H10V19H8V14A2,2 0 0,0 6,12A2,2 0 0,0 8,10V5H10V3M16,3A2,2 0 0,1 18,5V9A2,2 0 0,0 20,11H21V13H20A2,2 0 0,0 18,15V19A2,2 0 0,1 16,21H14V19H16V14A2,2 0 0,1 18,12A2,2 0 0,1 16,10V5H14V3H16Z";

/** PNG data URL of the app icon for notifications, rasterized once.
 *  Notification `icon` wants a raster image — SVG icons don't render
 *  reliably across platforms — so we draw the glyph (on a rounded dark
 *  tile, the way an app icon reads) to a canvas. Best-effort: stays null
 *  if any DOM API is missing, in which case notifications fall back to
 *  the browser default. */
let _iconUrl = null;
(function _rasterizeIcon() {
    try {
        if (typeof document === "undefined" || typeof Image === "undefined") {
            return;
        }
        if (typeof document.createElement !== "function") return;
        const size = 192;
        const svg =
            `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">` +
            `<rect width="24" height="24" rx="5" fill="#16213e"/>` +
            `<path fill="#7c6fe0" d="${_ICON_PATH}"/></svg>`;
        const img = new Image();
        img.onload = () => {
            try {
                const canvas = document.createElement("canvas");
                canvas.width = size;
                canvas.height = size;
                const ctx = canvas.getContext("2d");
                if (!ctx) return;
                ctx.drawImage(img, 0, 0, size, size);
                _iconUrl = canvas.toDataURL("image/png");
            } catch {
                // Tainted canvas / unsupported — leave the default icon.
            }
        };
        img.src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    } catch {
        // No DOM — leave _iconUrl null.
    }
})();

/** Opt-in console tracing for diagnosing "why didn't a notification
 *  appear." Enable from the devtools console with
 *  `localStorage.setItem('agex-notify-debug', '1')` (reload not needed),
 *  reproduce, then read the `[notify]` lines. Disable by removing the
 *  key. Off by default so it never spams a normal session. */
function _debug(...args) {
    try {
        if (
            typeof localStorage !== "undefined" &&
            localStorage.getItem("agex-notify-debug") === "1"
        ) {
            console.log("[notify]", ...args);
        }
    } catch {
        // localStorage can throw in locked-down contexts — never let
        // debug tracing affect behavior.
    }
}

/** Snapshot of the inputs that gate a notification, for `_debug`. */
function _env() {
    const doc = typeof document !== "undefined" ? document : null;
    return {
        supported: notificationsSupported(),
        permission: notificationsSupported() ? Notification.permission : "n/a",
        notifyOnFinish: !!getSettings().notifyOnFinish,
        visibilityState: doc ? doc.visibilityState : "n/a",
        hasFocus: doc && typeof doc.hasFocus === "function" ? doc.hasFocus() : "n/a",
    };
}

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
    _debug("turnComplete", { branch, title, foreground, ..._env() });
    if (!notificationsSupported()) {
        _debug("skip: Notification API unsupported");
        return;
    }
    if (Notification.permission !== "granted") {
        _debug("skip: permission is", Notification.permission);
        return;
    }
    if (!getSettings().notifyOnFinish) {
        _debug("skip: notifyOnFinish setting is off");
        return;
    }
    // "On screen" = this session is foreground AND the tab is visible AND
    // the studio window has focus. The focus check matters: switching to
    // another *app or window* leaves the tab "visible" (it's still the
    // active tab of its window) — only `hasFocus()` catches that. It also
    // returns false when the tab is hidden, so it covers tab-switching
    // too. Notify whenever the result isn't on screen by this definition.
    if (foreground && isOnScreen()) {
        _debug("skip: session is on screen (foreground + visible + focused)");
        return;
    }
    try {
        // No `tag`: tagged notifications were silently coalesced rather
        // than re-alerted on at least some platforms (macOS Chrome) even
        // with `renotify: true` — the constructor "succeeds" but nothing
        // pops. Reliability of actually being seen beats deduping; a
        // once-per-completion notification doesn't stack enough to matter.
        const n = new Notification("agex.studio", {
            body: `${title || "A session"} finished working`,
            icon: _iconUrl || undefined,
        });
        n.onclick = () => {
            try {
                window.focus();
            } catch {}
            if (_onActivate) _onActivate(branch);
            n.close();
        };
        _debug("fired session notification");
    } catch (e) {
        // Some platforms reject `new Notification()` (notably Android
        // Chrome, which requires ServiceWorkerRegistration.showNotification).
        // Surface it rather than swallowing — a silent throw here looks
        // exactly like "nothing happened."
        console.warn("[notify] Notification constructor threw:", e);
    }
}

/** Cap a string for use in a notification field — notifications are a
 *  shout, not a document; long payloads get clipped by the OS anyway. */
function _cap(s, max) {
    if (typeof s !== "string") return "";
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Show a notification on behalf of an app running in the preview iframe.
 * The cross-origin sandbox can't construct Notifications itself (and
 * can't even prompt for permission), so the host does it. Caller
 * (AppPreview) owns the rate cap and the permission prompt; this just
 * renders, after a permission re-check. Returns whether it showed.
 *
 * @param {{ title?: string, body?: string, branch: string }} info
 * @returns {boolean}
 */
export function showAppNotification({ title, body, branch }) {
    if (!notificationsSupported()) return false;
    if (Notification.permission !== "granted") return false;
    try {
        // No `tag` — see notifyTurnComplete: tagged notifications were
        // silently coalesced (not re-alerted) on some platforms even with
        // `renotify`, so they never appeared. Showing reliably wins.
        const n = new Notification(_cap(title, 100) || "agex.studio", {
            body: _cap(body, 250),
            icon: _iconUrl || undefined,
        });
        n.onclick = () => {
            try {
                window.focus();
            } catch {}
            if (_onActivate) _onActivate(branch);
            n.close();
        };
        _debug("fired app notification", { branch });
        return true;
    } catch (e) {
        console.warn("[notify] app Notification constructor threw:", e);
        return false;
    }
}
