/**
 * Persistent storage for the studio's origin: whether the browser keeps
 * its data (sessions, app databases) until the person clears it, rather
 * than clearing it when space runs low. Until sync carries an app's
 * database, the browser's storage is its only copy.
 */

/**
 * Whether the browser has made this origin's storage persistent; null
 * where it can't say.
 *
 * @param {{ persisted?: () => Promise<boolean> } | undefined} [storage]
 * @returns {Promise<boolean | null>}
 */
export async function isPersisted(storage = globalThis.navigator?.storage) {
    try {
        return typeof storage?.persisted === "function" ? await storage.persisted() : null;
    } catch {
        return null;
    }
}

/**
 * Ask the browser to make this origin's storage persistent; whether it
 * is now. Chromium decides at once, by how the site is used; Firefox
 * asks the person; Safari grants it to a site added to the home screen.
 *
 * @param {{ persist?: () => Promise<boolean> } | undefined} [storage]
 * @returns {Promise<boolean>}
 */
export async function askPersist(storage = globalThis.navigator?.storage) {
    try {
        return typeof storage?.persist === "function" ? await storage.persist() : false;
    } catch {
        return false;
    }
}
