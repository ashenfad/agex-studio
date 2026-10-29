/**
 * The extension's service worker: it answers the studio's port, and
 * nothing else talks to it, and follows the sessions' tabs.
 */

import { DEV } from "./build-info.js";
import { originMatcher } from "./origins.js";
import { servePort } from "./port.js";
import { DEV_MATCHES, STUDIO_MATCHES } from "./protocol.js";
import { pageOps } from "./pages.js";
import { read } from "./registry.js";
import { start, tabOps, watchTabs } from "./tabs.js";
import { watchWork } from "./work.js";

const manifest = chrome.runtime.getManifest();
// the worker's own list, not the manifest's
const allows = originMatcher(DEV ? [...STUDIO_MATCHES, ...DEV_MATCHES] : STUDIO_MATCHES);

/** @type {Record<string, import("./port.js").Op>} */
const ops = {
    // the studio's heartbeat: any message keeps the worker alive
    ping: () => ({ at: Date.now() }),
    ...tabOps,
    ...pageOps,
};

watchTabs();
start();
watchWork(async () => Object.keys((await read()).tabs).map(Number));

chrome.runtime.onConnectExternal.addListener((port) => {
    servePort(port, { allows, ops, version: manifest.version });
});
