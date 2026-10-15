/**
 * Desktop notifications, shown only while the studio's tab is open (no
 * service worker, no push): a turn that ended while the person wasn't
 * looking (see `status.js`), when they turned `notifyOnFinish` on; and
 * what an app asks for with `notify(title, body)`. Either needs the
 * browser's permission, which the person grants from the settings (a
 * click there is the gesture a browser asks for). Clicking one brings
 * the window forward on the session it came from.
 */

import { messageText } from "agex-ts";
import { getSettings } from "./settings.js";

/** What an app may show: this many notifications a minute, per session. */
export const APP_NOTIFY_MAX = 5;
const APP_NOTIFY_WINDOW_MS = 60_000;

/** The browser's permission for notifications, or "unsupported".
 *  @returns {NotificationPermission | "unsupported"} */
export function notificationPermission() {
    return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

/** Ask the browser for permission (call it from a click); what it
 *  says. */
export async function requestNotificationPermission() {
    if (typeof Notification === "undefined") return "unsupported";
    try {
        return await Notification.requestPermission();
    } catch {
        return Notification.permission;
    }
}

/** What clicking a notification does with its session's name, after
 *  the window comes forward. @type {(session: string) => void} */
let activate = () => {};

/** Set what clicking a notification does. @param {(session: string) => void} fn */
export function onNotificationClick(fn) {
    activate = fn;
}

/** @param {string} text @param {number} max */
function cap(text, max) {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Show a notification for `session`, if the browser allows it; whether
 * it was shown. A notification has no `tag`: some platforms swallow a
 * tagged one that replaces another rather than showing it.
 *
 * @param {string} session @param {string} title @param {string} body
 */
function show(session, title, body) {
    if (notificationPermission() !== "granted") return false;
    try {
        const n = new Notification(cap(title, 100), { body: cap(body, 250) });
        n.onclick = () => {
            window.focus();
            activate(session);
            n.close();
        };
        return true;
    } catch (e) {
        // a browser that shows them only from a service worker (Android's Chrome)
        console.warn("couldn't show a notification:", e);
        return false;
    }
}

/** The first line of the agent's last words in a run, if it said any.
 *  @param {import("agex-ts").Run | undefined} run */
export function lastReply(run) {
    for (const message of [...(run?.messages ?? [])].reverse()) {
        if (message.role !== "assistant") continue;
        const line = messageText(message).trim().split("\n")[0]?.trim() ?? "";
        if (line !== "") return line;
    }
    return "";
}

/**
 * What a turn's notification says: the session's title, and the first
 * line of the agent's reply, or how a turn that went wrong ended.
 *
 * @param {{ title: string, status: string, reply: string, error: string | null }} turn
 */
export function turnNotice({ title, status, reply, error }) {
    let body = reply || "Finished.";
    if (status === "failed" || status === "interrupted") body = error ? error.charAt(0).toUpperCase() + error.slice(1) : `The turn ended ${status}.`;
    else if (status === "cancelled") body = "Stopped.";
    return { title: title || "agex studio", body };
}

/**
 * A turn of `session` ended while the person wasn't looking: tell them,
 * when they turned it on and the browser allows it. Whether it was
 * shown.
 *
 * @param {{ session: string, title: string, status: string, reply: string, error: string | null }} turn
 */
export function notifyTurnEnded(turn) {
    if (!getSettings().notifyOnFinish) return false;
    const { title, body } = turnNotice(turn);
    return show(turn.session, title, body);
}

/** When each session's app last showed notifications, for the cap.
 *  @type {Map<string, number[]>} */
const appShown = new Map();

/**
 * Show what the app of `session` asked for with `notify`: only when the
 * browser already allows notifications (an app's request isn't a click
 * on the studio, so it can't ask), and up to `APP_NOTIFY_MAX` a minute.
 * Whether it was shown, and why not.
 *
 * @param {{ session: string, title: string, body: string }} ask
 * @param {number} [now]
 * @returns {{ shown: boolean, reason: string | null }}
 */
export function appNotify({ session, title, body }, now = Date.now()) {
    const permission = notificationPermission();
    if (permission === "unsupported") return { shown: false, reason: "this browser doesn't show notifications" };
    if (permission !== "granted") {
        return { shown: false, reason: "notifications aren't allowed: the person can turn them on in the studio's settings" };
    }
    const recent = (appShown.get(session) ?? []).filter((t) => now - t < APP_NOTIFY_WINDOW_MS);
    if (recent.length >= APP_NOTIFY_MAX) {
        appShown.set(session, recent);
        return { shown: false, reason: `at most ${APP_NOTIFY_MAX} notifications a minute: try again shortly` };
    }
    if (!show(session, title || "agex studio", body)) return { shown: false, reason: "the browser didn't show it" };
    appShown.set(session, [...recent, now]);
    return { shown: true, reason: null };
}
