/**
 * The extension's service worker: it answers the studio's port, and
 * nothing else talks to it.
 */

import { originMatcher } from "./origins.js";
import { servePort } from "./port.js";

const manifest = chrome.runtime.getManifest();
const allows = originMatcher(manifest.externally_connectable?.matches ?? []);

/** @type {Record<string, import("./port.js").Op>} */
const ops = {
    // the studio's heartbeat: any message keeps the worker alive
    ping: () => ({ at: Date.now() }),
};

chrome.runtime.onConnectExternal.addListener((port) => {
    servePort(port, { allows, ops, version: manifest.version });
});
