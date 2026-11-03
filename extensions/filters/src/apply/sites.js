/**
 * The service worker's side of applying accepted filters: it keeps the
 * state (`state.js`), registers the content script for each accepted
 * site's pages, installs each site's block rules as dynamic
 * `declarativeNetRequest` rules, and passes the popup's preview and count
 * to the content script on a tab.
 *
 * Nothing applies without the person: a filter is accepted only for a
 * site the extension holds host permission for (which the popup asks for
 * from the person's click, when they submit the site's page), and a preview reaches a tab only through
 * `activeTab`, which that click grants.
 *
 * The extension's dynamic rules are this module's alone: each change
 * replaces them all, in one call, with the rules the state wants, so
 * they follow the state even after a change that failed halfway.
 */

import { isSite } from "../filter/guards.js";
import {
    APPLIED, acceptFilter, checkWithoutDom, matchesOf, readState, removeSite, scriptId, setOn, setPaused,
    siteOfScript, undoAccept, wantedRules,
} from "./state.js";

/** The content script's bundle, at the build's top level. */
export const CONTENT_SCRIPT = "apply-content.js";

/** @returns {Promise<import("./state.js").State>} */
async function load() {
    const got = await chrome.storage.local.get(APPLIED);
    return readState(got[APPLIED]);
}

/** @param {import("./state.js").State} state */
const save = (state) => chrome.storage.local.set({ [APPLIED]: state });

/** The change running or last run, which the next waits for, so no two
 *  read and write the state at once. */
let changes = Promise.resolve();

/**
 * Run `change` once the changes before it have ended.
 *
 * @template T
 * @param {() => Promise<T>} change
 * @returns {Promise<T>}
 */
function serial(change) {
    const run = changes.then(change);
    changes = run.then(() => {}, () => {});
    return run;
}

/**
 * The extension's dynamic rules made those `state` wants, in one call
 * (all or none), for the sites the extension may still run on: a block
 * rule needs no host permission of its own, so a site whose permission
 * the person took back is left out here, not by Chrome.
 *
 * @param {import("./state.js").State} state
 */
async function installRules(state) {
    const permitted = Object.fromEntries(await Promise.all(Object.entries(state.sites).map(async ([site, entry]) => [site, (await mayRunOn(site)) ? entry : null])));
    const sites = Object.fromEntries(Object.entries(permitted).filter(([, entry]) => entry !== null));
    const have = await chrome.declarativeNetRequest.getDynamicRules();
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: have.map((r) => r.id), addRules: wantedRules({ ...state, sites }) });
}

/**
 * `next` made the state: its rules installed first (when Chrome refuses
 * one, nothing is stored and the old rules stay), then saved; when saving
 * fails (storage full), the rules of `prev` go back, so rules and state
 * never disagree.
 *
 * @param {import("./state.js").State} prev @param {import("./state.js").State} next
 */
async function commit(prev, next) {
    await installRules(next);
    try {
        await save(next);
    } catch (e) {
        await installRules(prev).catch(() => {});
        throw e;
    }
}

/** Whether the extension may run on `site`'s pages. @param {string} site */
const mayRunOn = (site) => chrome.permissions.contains({ origins: matchesOf(site) });

/**
 * The content script registered for `site`'s pages, if it isn't. It runs
 * at `document_start`, so its stylesheet is in before the page first
 * draws and what it hides doesn't flash in and out; the applier matches
 * again as the parser adds the page. Top frames only: the site's pages,
 * not the site framed in another's.
 *
 * @param {string} site
 */
async function register(site) {
    const id = scriptId(site);
    if ((await chrome.scripting.getRegisteredContentScripts({ ids: [id] })).length > 0) return;
    await chrome.scripting.registerContentScripts([{
        id,
        matches: matchesOf(site),
        js: [CONTENT_SCRIPT],
        runAt: "document_start",
        allFrames: false,
        persistAcrossSessions: true,
    }]);
}

/** The content script for `site` unregistered, if it is. @param {string} site */
async function unregister(site) {
    const id = scriptId(site);
    if ((await chrome.scripting.getRegisteredContentScripts({ ids: [id] })).length === 0) return;
    await chrome.scripting.unregisterContentScripts({ ids: [id] });
}

/**
 * The content script put in `site`'s tabs open now: a registered script
 * runs only on pages loaded after it, and an accepted filter applies at
 * once. A tab it can't reach (still loading, an error page) gets it at its
 * next load.
 *
 * @param {string} site
 */
async function injectOpen(site) {
    const tabs = await chrome.tabs.query({ url: matchesOf(site) });
    await Promise.all(tabs.map((tab) => tab.id === undefined ? null : inject(tab.id).catch(() => null)));
}

/** The content script in `tabId`'s top frame (it runs once a frame, however often it is put there).
 *  @param {number} tabId */
async function inject(tabId) {
    await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT] });
}

/** The error Chrome gives a message to a tab no content script of the extension listens in. */
const NO_RECEIVER = /Receiving end does not exist/;

/**
 * Ask the content script in `tabId`'s top frame, and its answer.
 *
 * @param {number} tabId
 * @param {Record<string, unknown> & { apply: string }} msg
 */
async function ask(tabId, msg) {
    const answer = await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
    if (answer?.error !== undefined) throw new Error(answer.error);
    return answer?.value;
}

/** @param {unknown} site @returns {string} */
function siteArg(site) {
    if (!isSite(site)) throw new Error(`site: ${JSON.stringify(site)} is not a domain (like reddit.com)`);
    return site;
}

/** @param {unknown} tabId @returns {number} */
function tabArg(tabId) {
    if (!Number.isInteger(tabId) || /** @type {number} */ (tabId) < 0) throw new Error(`tabId: ${JSON.stringify(tabId)} is not a tab's id`);
    return /** @type {number} */ (tabId);
}

/** @param {unknown} v @param {string} name @returns {boolean} */
function boolArg(v, name) {
    if (typeof v !== "boolean") throw new Error(`${name}: must be true or false`);
    return v;
}

/** `state` as an op answers it: the pause, and the sites (only `site` when one is named).
 *  @param {import("./state.js").State} state @param {string} [site] */
function view(state, site) {
    if (site === undefined) return state;
    return { paused: state.paused, sites: Object.hasOwn(state.sites, site) ? { [site]: state.sites[site] } : {} };
}

/**
 * The state, its rules and its content scripts made to agree again: the
 * rules the state wants, a script for each stored site the extension may
 * still run on, none for a site no longer stored or no longer permitted.
 * Run when the extension is installed, updated or the browser starts, and
 * when the person takes a permission back.
 */
export function repair() {
    return serial(async () => {
        const state = await load();
        await installRules(state);
        for (const script of await chrome.scripting.getRegisteredContentScripts()) {
            const site = siteOfScript(script.id);
            if (site !== null && !Object.hasOwn(state.sites, site)) await unregister(site);
        }
        // a site whose permission the person took back runs nothing until it's given again
        for (const site of Object.keys(state.sites)) await ((await mayRunOn(site)) ? register(site) : unregister(site));
    });
}

/** What the extension's pages may ask of the applier, by `op`; merged
 *  into the worker's own.
 *  @type {Record<string, (msg: { op: string, [arg: string]: any }) => Promise<unknown>>} */
export const applyOps = {
    /**
     * `filter` made `site`'s, on: checked again, stored, its block rules
     * installed, its content script registered and put in the site's open
     * tabs. Refused unless the extension holds host permission for the
     * site's pages (the popup asks for it from the person's click first).
     * Answers the state of `site`.
     */
    filterAccept: ({ site, filter }) => serial(async () => {
        const s = siteArg(site);
        const checked = checkWithoutDom(filter, s);
        if ("errors" in checked) throw new Error(`the filter doesn't pass its checks:\n${checked.errors.join("\n")}`);
        if (!(await mayRunOn(s))) throw new Error(`no permission to run on ${s}'s pages; it is asked for from the person's click`);
        const prev = await load();
        await commit(prev, acceptFilter(prev, s, checked.filter));
        const next = await load();
        await register(s);
        await injectOpen(s);
        return view(next, s);
    }),

    /** `site`'s last accept undone: the filter it replaced back, or, for
     *  its first, its filter removed. Answers the state of `site`. */
    filterUndo: ({ site }) => serial(async () => {
        const s = siteArg(site);
        const prev = await load();
        const next = undoAccept(prev, s);
        await commit(prev, next);
        if (Object.hasOwn(next.sites, s)) await injectOpen(s);
        else await unregister(s);
        return view(next, s);
    }),

    /** `site`'s filter turned on or off. Answers the state of `site`. */
    filterSetOn: ({ site, on }) => serial(async () => {
        const s = siteArg(site);
        const prev = await load();
        const next = setOn(prev, s, boolArg(on, "on"));
        await commit(prev, next);
        return view(next, s);
    }),

    /** `site`'s filter removed: its rules, its content script, its entry. */
    filterRemove: ({ site }) => serial(async () => {
        const s = siteArg(site);
        const prev = await load();
        const next = removeSite(prev, s);
        await commit(prev, next);
        await unregister(s);
        return view(next, s);
    }),

    /** Every site's filter paused (no hiding, no blocking), or resumed. */
    filterPause: ({ paused }) => serial(async () => {
        const prev = await load();
        const next = setPaused(prev, boolArg(paused, "paused"));
        await commit(prev, next);
        return view(next);
    }),

    /** What is stored: the pause and every site, or only `site` when named. */
    filterState: async ({ site }) => view(await load(), site === undefined ? undefined : siteArg(site)),

    /**
     * `filter` shown on tab `tabId` as a candidate for `site`: what it
     * would hide outlined, not hidden. It needs no host permission: the
     * popup calls it after the person's click there, which grants
     * `activeTab`. The content script checks the filter on the page and
     * that the page is one of `site`'s. Answers how many elements it
     * outlines.
     */
    filterPreview: async ({ tabId, site, filter }) => {
        const tab = tabArg(tabId);
        const s = siteArg(site);
        try {
            await inject(tab);
        } catch (e) {
            throw new Error(`can't reach tab ${tab} (${String(/** @type {Error} */ (e)?.message ?? e)}); a preview needs the person's click on the extension in that tab`);
        }
        return ask(tab, { apply: "preview", site: s, filter });
    },

    /** The preview on tab `tabId` ended: the page as the stored state has it. Answers the count then. */
    filterPreviewEnd: async ({ tabId }) => {
        try {
            return await ask(tabArg(tabId), { apply: "previewEnd" });
        } catch (e) {
            if (NO_RECEIVER.test(String(/** @type {Error} */ (e)?.message))) return 0;
            throw e;
        }
    },

    /** How many elements the filter applied on tab `tabId` hides (or, in a preview, outlines) now; 0 when none applies there. */
    filterCount: async ({ tabId }) => {
        try {
            return await ask(tabArg(tabId), { apply: "count" });
        } catch (e) {
            if (NO_RECEIVER.test(String(/** @type {Error} */ (e)?.message))) return 0;
            throw e;
        }
    },
};

chrome.runtime.onInstalled.addListener(() => void repair());
chrome.runtime.onStartup.addListener(() => void repair());
chrome.permissions.onRemoved.addListener(() => void repair());
