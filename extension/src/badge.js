/**
 * The toolbar button on a tab the person shared: a badge, and a title
 * that says with whom, so the person sees which of their tabs an agent
 * can read.
 */

/** The button's title on a tab that isn't shared. */
export const TITLE = "Share this tab with agex.studio";

const LOOK = {
    shared: { text: "on", color: "#2563eb" },
    waiting: { text: "…", color: "#6b7280" },
};

/**
 * The badge on `tab`: shared with a session, waiting for the studio to
 * say which, or none.
 *
 * @param {number} tab @param {"shared" | "waiting" | null} kind @param {string} [title]
 */
export async function badge(tab, kind, title = TITLE) {
    const look = kind === null ? null : LOOK[kind];
    await Promise.all([
        chrome.action.setBadgeText({ tabId: tab, text: look?.text ?? "" }),
        ...(look ? [chrome.action.setBadgeBackgroundColor({ tabId: tab, color: look.color })] : []),
        chrome.action.setTitle({ tabId: tab, title }),
    ]).catch(() => {}); // the tab closed meanwhile
}
