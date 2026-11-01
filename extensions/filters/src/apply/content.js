/**
 * The content script on an accepted site's pages, registered by the
 * service worker (`sites.js`) for each site and put in a tab for a
 * preview. It applies its site's filter as the stored state has it
 * (hidden while the filter is on and nothing is paused, nothing
 * otherwise), follows the state as it changes, with no reload, and
 * answers the worker's count and preview.
 *
 * It checks the filter again on the page before it hides anything: the
 * worker has no DOM to parse a selector in, and what is stored is only
 * applied once it passes here. Bundled as a classic script, since a
 * registered content script and an injected file are both run as one; it
 * runs once a frame, however often it is put there.
 */

import { applyFilter } from "../filter/apply.js";
import { checkFilter } from "../filter/format.js";
import { APPLIED, readState, siteOfHost } from "./state.js";

/** Set on the extension's isolated world once the script runs in a frame. */
const RUNNING = "__agexSiteFilters";

const world = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (globalThis));
if (world[RUNNING] !== true) {
    world[RUNNING] = true;
    start();
}

function start() {
    let state = readState(undefined);
    /** A candidate shown outlined, which the stored state waits behind until it ends.
     *  @type {import("../filter/format.js").Filter | null} */
    let preview = null;
    /** @type {import("../filter/apply.js").Applied | null} */
    let applied = null;
    /** What is applied now, so a change to another site's entry changes nothing here. */
    let showing = "";

    /** What the page should show: the preview's filter, else its site's while on, else none. */
    const wanted = () => {
        if (preview !== null) return { key: "preview", filter: preview, mode: /** @type {const} */ ("outline") };
        const site = siteOfHost(location.hostname, Object.keys(state.sites));
        const entry = site === null ? undefined : state.sites[site];
        if (site === null || entry === undefined || !entry.on || state.paused) return { key: "none", filter: null, mode: /** @type {const} */ ("off") };
        const key = `${site}@${entry.version}`;
        const checked = checkFilter(entry.filter, { site });
        if ("errors" in checked) {
            console.warn(`agex site filters: ${site}'s filter doesn't pass its checks, so nothing is hidden:\n${checked.errors.join("\n")}`);
            return { key, filter: null, mode: /** @type {const} */ ("off") };
        }
        return { key, filter: checked.filter, mode: /** @type {const} */ ("hide") };
    };

    /** The page made to show what it should; `again` re-applies even when it shows that already. */
    const render = (again = false) => {
        const want = wanted();
        if (!again && want.key === showing) return;
        applied?.stop();
        applied = want.filter === null ? null : applyFilter(document, want.filter, { mode: want.mode });
        showing = want.key;
    };

    let changed = false;
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local" || !Object.hasOwn(changes, APPLIED)) return;
        changed = true;
        state = readState(changes[APPLIED].newValue);
        render();
    });
    chrome.storage.local.get(APPLIED).then((got) => {
        // a change that came first is newer than what was read
        if (changed) return;
        state = readState(got[APPLIED]);
        render();
    });

    /** @param {{ apply: string, site?: unknown, filter?: unknown }} msg */
    const answer = (msg) => {
        if (msg.apply === "count") return applied?.count() ?? 0;
        if (msg.apply === "preview") {
            const site = String(msg.site);
            if (siteOfHost(location.hostname, [site]) !== site) throw new Error(`this page (${location.hostname}) isn't one of ${site}'s`);
            const checked = checkFilter(msg.filter, { site });
            if ("errors" in checked) throw new Error(`the filter doesn't pass its checks:\n${checked.errors.join("\n")}`);
            preview = checked.filter;
            render(true);
            return applied?.count() ?? 0;
        }
        if (msg.apply === "previewEnd") {
            preview = null;
            render(true);
            return applied?.count() ?? 0;
        }
        throw new Error(`no such request: ${msg.apply}`);
    };

    chrome.runtime.onMessage.addListener((msg, sender, reply) => {
        // only the extension itself, through `tabs.sendMessage`
        if (sender.id !== chrome.runtime.id || typeof msg?.apply !== "string") return;
        try {
            reply({ value: answer(msg) });
        } catch (e) {
            reply({ error: String(/** @type {Error} */ (e)?.message ?? e) });
        }
    });
}
