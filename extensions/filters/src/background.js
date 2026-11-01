/**
 * The site-filter extension's service worker. It answers the extension's
 * own pages (`runtime.sendMessage`), and nothing from the web: the
 * manifest names no `externally_connectable`.
 */

/** What each message from the extension's pages may ask, by its `op`.
 *  @type {Record<string, (msg: { op: string, [arg: string]: unknown }) => Promise<unknown>>} */
const OPS = {
    /** That the worker is up, and which build it is. */
    ping: async () => ({ version: chrome.runtime.getManifest().version }),
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    // only the extension's own pages: a content script's sender is the site's page
    if (sender.id !== chrome.runtime.id || sender.origin !== self.location.origin) return;
    const op = Object.hasOwn(OPS, msg?.op) ? OPS[msg.op] : undefined;
    if (op === undefined) return;
    op(msg).then((value) => reply({ value }), (e) => reply({ error: String(e?.message ?? e) }));
    return true;
});
