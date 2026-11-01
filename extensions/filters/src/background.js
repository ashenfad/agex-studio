/**
 * The site-filter extension's service worker. It answers the extension's
 * own pages (`runtime.sendMessage`), and nothing from the web: the
 * manifest names no `externally_connectable`.
 */

/** The offscreen document, which frames the sandbox the agent runs in. */
const OFFSCREEN = "offscreen.html";

/** The offscreen document, made if it isn't there (Chrome keeps one at
 *  most). @type {Promise<void> | null} */
let making = null;
async function offscreen() {
    const have = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
    if (have.length > 0) return;
    making ??= chrome.offscreen
        .createDocument({
            url: OFFSCREEN,
            reasons: [chrome.offscreen.Reason.IFRAME_SCRIPTING, chrome.offscreen.Reason.WORKERS],
            justification: "runs the site-filter agent in a sandboxed page, its code in a worker",
        })
        .finally(() => (making = null));
    await making;
}

/**
 * A command for the agent's sandbox, through the offscreen document.
 *
 * @param {string} cmd @param {Record<string, unknown>} [args]
 */
async function agent(cmd, args = {}) {
    await offscreen();
    const answer = await chrome.runtime.sendMessage({ target: "offscreen", cmd, ...args });
    if (answer?.error !== undefined) throw new Error(answer.error);
    return answer?.value;
}

/** What each message from the extension's pages may ask, by its `op`.
 *  @type {Record<string, (msg: { op: string, [arg: string]: unknown }) => Promise<unknown>>} */
const OPS = {
    /** That the worker is up, and which build it is. */
    ping: async () => ({ version: chrome.runtime.getManifest().version }),
    /** The sites with a session. */
    sites: () => agent("sites"),
    /** How many runs a site's session has had. */
    runs: ({ site }) => agent("runs", { site }),
    /** A file of a site's session, as text. */
    read: ({ site, path }) => agent("read", { site, path }),
    /** A turn of a site's session, on the person's model. */
    turn: ({ site, prompt }) => agent("turn", { site, prompt }),
};

if (__DEV__) {
    /** A turn on a scripted model, for the tests: `steps` are its replies. */
    OPS.scripted = ({ site, prompt, steps }) => agent("turn", { site, prompt, steps });
    /** The offscreen document closed (the agent's store stays). */
    OPS.restart = async () => {
        if ((await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] })).length > 0) await chrome.offscreen.closeDocument();
        return null;
    };
}

// until the toolbar has a popup of its own, its button opens the extension's page
chrome.action.onClicked.addListener(() => void chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    // only the extension's own pages (a content script's sender is the site's
    // page), and not what's meant for the offscreen document
    if (sender.id !== chrome.runtime.id || sender.origin !== self.location.origin || msg?.target !== undefined) return;
    const op = Object.hasOwn(OPS, msg?.op) ? OPS[msg.op] : undefined;
    if (op === undefined) return;
    op(msg).then((value) => reply({ value }), (e) => reply({ error: String(e?.message ?? e) }));
    return true;
});
