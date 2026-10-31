/**
 * The extension's service worker: it answers the studio's port and the
 * toolbar's popup, and nothing else talks to it, and follows the
 * sessions' tabs.
 */

import { DEV } from "./build-info.js";
import { originMatcher } from "./origins.js";
import { servePort } from "./port.js";
import { DEV_MATCHES, ProtocolError, STUDIO_MATCHES } from "./protocol.js";
import { actOps } from "./act.js";
import { pageOps } from "./pages.js";
import { read } from "./registry.js";
import { offer, popupState, start, stopSharing, studioConnected, tabOps, watchTabs } from "./tabs.js";
import { watchWork } from "./work.js";

const manifest = chrome.runtime.getManifest();
// the worker's own list, not the manifest's
const allows = originMatcher(DEV ? [...STUDIO_MATCHES, ...DEV_MATCHES] : STUDIO_MATCHES);

/** The dev build's stand-in for the popup's Share, for the end-to-end
 *  tests, which can't open the popup. @type {Record<string, import("./port.js").Op>} */
const devOps = {
    async offer(req) {
        if (!Number.isInteger(req.tab)) throw new ProtocolError("bad-request", "tab: a tab's id");
        await offer(/** @type {number} */ (req.tab));
        return null;
    },
};

/** @type {Record<string, import("./port.js").Op>} */
const ops = {
    // the studio's heartbeat: any message keeps the worker alive
    ping: () => ({ at: Date.now() }),
    ...tabOps,
    ...pageOps,
    ...actOps,
    ...(DEV ? devOps : {}),
};

/** What the popup asks of the worker, about the tab in front. */
const popupOps = {
    state: popupState,
    share: offer,
    stop: stopSharing,
};

watchTabs();
start();
watchWork(async () => Object.keys((await read()).tabs).map(Number));

chrome.runtime.onConnectExternal.addListener((port) => {
    servePort(port, { allows, ops, version: manifest.version });
    if (allows(port.sender?.origin)) studioConnected(port.sender?.tab?.id, port.sender?.origin);
});

// the popup: only the extension's own pages send here (a site's page
// reaches it through the port alone)
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    const op = popupOps[/** @type {keyof typeof popupOps} */ (msg?.popup)];
    if (sender.id !== chrome.runtime.id || op === undefined || !Number.isInteger(msg.tab)) return false;
    op(msg.tab).then(
        (value) => reply({ value }),
        (/** @type {Error} */ e) => reply({ error: { message: e.message } }),
    );
    return true;
});
