/**
 * The extension's service worker: it answers the studio's port, and
 * nothing else talks to it, and follows the sessions' tabs.
 */

import { DEV } from "./build-info.js";
import { originMatcher } from "./origins.js";
import { servePort } from "./port.js";
import { DEV_MATCHES, STUDIO_MATCHES } from "./protocol.js";
import { start, tabOps, watchTabs } from "./tabs.js";

const manifest = chrome.runtime.getManifest();
// the worker's own list, not the manifest's
const allows = originMatcher(DEV ? [...STUDIO_MATCHES, ...DEV_MATCHES] : STUDIO_MATCHES);

/** @type {Record<string, import("./port.js").Op>} */
const ops = {
    // the studio's heartbeat: any message keeps the worker alive
    ping: () => ({ at: Date.now() }),
    ...tabOps,
};

watchTabs();
start();

chrome.runtime.onConnectExternal.addListener((port) => {
    servePort(port, { allows, ops, version: manifest.version });
});
