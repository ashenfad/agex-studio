/**
 * A session's tabs: opened in the background beside the studio, in a tab
 * group named for the session, and held to its grants. Every page load in
 * one is checked by the browser against `declarativeNetRequest` session
 * rules for that tab (a link, a redirect, a script's navigation), and a
 * tab a page opens is the session's too (sent behind the tab it took
 * the front from), or closed at once if it opens somewhere without a
 * grant.
 *
 * Only tabs the extension opened for a session, and the tabs their pages
 * open, are in the registry. The person's own tabs are never held.
 */

import { granted, isOrigin, originOf, pageRules } from "./grants.js";
import { ProtocolError } from "./protocol.js";
import { change } from "./registry.js";

/** @typedef {import("./protocol.js").Request} Request */

/** @type {Record<string, import("./port.js").Op>} */
export const tabOps = {
    /** A session's name (its tab group's title) and the origins it may
     *  load, set or replaced. Its open tabs are held to the new origins
     *  at once. */
    async session(req) {
        const session = sessionArg(req);
        const { name, origins } = req;
        if (typeof name !== "string" || name === "") throw bad("name: the session's name, its tab group's title");
        if (!Array.isArray(origins) || !origins.every(isOrigin)) {
            throw bad("origins: a list of origins, each like https://www.example.com");
        }
        await change(async (state) => {
            const before = state.sessions[session];
            state.sessions[session] = { name, origins: [...new Set(origins)] };
            for (const tab of tabsOf(state, session)) await hold(tab, origins);
            if (before !== undefined && before.name !== name) await renameGroups(state, session, before.name, name);
        });
        return null;
    },

    /** A tab opened for a session, in the background of the studio's
     *  window, on a URL it holds a grant for. */
    async open(req, port) {
        const session = sessionArg(req);
        const { url } = req;
        if (typeof url !== "string" || originOf(url) === null) throw bad("url: an http or https URL");
        const windowId = port.sender?.tab?.windowId;
        if (windowId === undefined) throw new ProtocolError("failed", "the port has no window to open a tab in");
        const tab = await change(async (state) => {
            const s = known(state, session);
            if (!granted(url, s.origins)) throw new ProtocolError("not-granted", `this session holds no grant for ${originOf(url)}`);
            // blank, and held to the grants, before it loads anything
            const { id } = await chrome.tabs.create({ url: "about:blank", active: false, windowId });
            if (id === undefined) throw new ProtocolError("failed", "the new tab has no id");
            try {
                await hold(id, s.origins);
                await group(state, session, id, windowId);
            } catch (e) {
                await chrome.tabs.remove(id).catch(() => {});
                await release(id);
                throw e;
            }
            state.tabs[id] = { session };
            return id;
        });
        await chrome.tabs.update(tab, { url });
        return { tab };
    },

    /** One of the session's tabs closed. */
    async close(req) {
        const session = sessionArg(req);
        const tab = tabArg(req);
        await change(async (state) => {
            mine(state, session, tab);
            await chrome.tabs.remove(tab).catch(() => {}); // already gone is closed too
            delete state.tabs[tab];
            await release(tab);
        });
        return null;
    },

    /** The session's tabs, each with its URL and title, and the last
     *  load the extension stopped in it. */
    async tabs(req) {
        const session = sessionArg(req);
        return change(async (state) => {
            const listed = [];
            for (const id of tabsOf(state, session)) {
                const tab = await chrome.tabs.get(id).catch(() => null);
                if (tab === null) {
                    delete state.tabs[id];
                    await release(id);
                    continue;
                }
                const { blocked } = state.tabs[id];
                listed.push({ id, url: tab.url ?? "", title: tab.title ?? "", ...(blocked && { blocked }) });
            }
            return listed;
        });
    },

    /** While a turn runs, the studio's tab isn't discarded to save
     *  memory, which would end the turn. */
    async turn(req, port) {
        if (typeof req.running !== "boolean") throw bad("running: whether a turn is running");
        const id = port.sender?.tab?.id;
        if (id === undefined) throw new ProtocolError("failed", "the port has no tab");
        const tab = await chrome.tabs.update(id, { autoDiscardable: !req.running });
        return { discardable: tab?.autoDiscardable ?? !req.running };
    },
};

/**
 * Follow the session's tabs as the browser changes them. Called once, as
 * the worker starts: listeners added later wouldn't wake a stopped worker.
 */
export function watchTabs() {
    chrome.webNavigation.onCreatedNavigationTarget.addListener(({ sourceTabId, tabId, url }) => {
        void change(async (state) => {
            const source = state.tabs[sourceTabId];
            if (source === undefined) return; // the person's own tab
            const { origins } = known(state, source.session);
            if (!granted(url, origins)) {
                // behind first: closed in front, it would hand the front to its neighbour
                await sendBack(state, tabId);
                await chrome.tabs.remove(tabId).catch(() => {});
                source.blocked = { url, at: Date.now(), newTab: true };
                return;
            }
            await hold(tabId, origins);
            state.tabs[tabId] = { session: source.session, opened: true };
            await sendBack(state, tabId);
            const tab = await chrome.tabs.get(tabId).catch(() => null);
            // a popup window takes no group; the tab is the session's all the same
            if (tab !== null) await group(state, source.session, tabId, tab.windowId).catch(() => {});
        });
    });

    chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
        void change((state) => shown(state, windowId, tabId));
    });
    chrome.windows.onRemoved.addListener((windowId) => {
        void change((state) => {
            delete state.windows[windowId];
        });
    });

    // a load the rules stopped ends in this error, before anything of it shows
    chrome.webNavigation.onErrorOccurred.addListener(({ tabId, frameId, url, error }) => {
        if (frameId !== 0 || !error.includes("ERR_BLOCKED_BY_CLIENT")) return;
        void change((state) => {
            const tab = state.tabs[tabId];
            if (tab === undefined || granted(url, state.sessions[tab.session]?.origins ?? [])) return;
            tab.blocked = { url, at: Date.now() };
        });
    });

    chrome.tabs.onRemoved.addListener((id) => {
        void change(async (state) => {
            if (!(id in state.tabs)) return;
            delete state.tabs[id];
            await release(id);
        });
    });

    // a prerendered page swapped in comes with a new tab id
    chrome.tabs.onReplaced.addListener((added, removed) => {
        void change(async (state) => {
            const tab = state.tabs[removed];
            if (tab === undefined) return;
            await hold(added, known(state, tab.session).origins);
            await release(removed);
            delete state.tabs[removed];
            state.tabs[added] = tab;
        });
    });
}

/** How many of the tabs a window has shown it remembers. */
const SHOWN = 10;

/**
 * The tab each window shows now, as the worker starts: the browser told
 * of none shown before it ran.
 */
export function seedShown() {
    void change(async (state) => {
        for (const tab of await chrome.tabs.query({ active: true })) {
            if (tab.id !== undefined && state.windows[tab.windowId] === undefined) shown(state, tab.windowId, tab.id);
        }
    });
}

/** @param {import("./registry.js").State} state @param {number} windowId @param {number} tabId */
function shown(state, windowId, tabId) {
    const was = (state.windows[windowId] ?? []).filter((id) => id !== tabId);
    state.windows[windowId] = [...was, tabId].slice(-SHOWN);
}

/**
 * A tab a page opened, sent behind if it came to the front: the agent's
 * tabs never take the person's focus. What comes back is the latest tab
 * the window showed that is still open and that no page opened (a page
 * can open several at once, each taking the front from the one before).
 *
 * @param {import("./registry.js").State} state @param {number} tabId
 */
async function sendBack(state, tabId) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab === null || !tab.active) return;
    for (const id of [...(state.windows[tab.windowId] ?? [])].reverse()) {
        if (id === tabId || state.tabs[id]?.opened) continue;
        const back = await chrome.tabs.update(id, { active: true }).catch(() => null);
        if (back) return;
    }
}

/** @param {import("./registry.js").State} state @param {string} session */
function tabsOf(state, session) {
    return Object.entries(state.tabs)
        .filter(([, t]) => t.session === session)
        .map(([id]) => Number(id));
}

/** @param {import("./registry.js").State} state @param {string} session */
function known(state, session) {
    const s = state.sessions[session];
    if (s === undefined) throw new ProtocolError("not-found", `no session "${session}": send its name and grants first`);
    return s;
}

/** @param {import("./registry.js").State} state @param {string} session @param {number} tab */
function mine(state, session, tab) {
    if (state.tabs[tab]?.session !== session) throw new ProtocolError("not-found", `tab ${tab} isn't one of this session's`);
}

/**
 * The tab's rules replaced by ones holding it to `origins`, in one
 * update, so it is never unheld between the two.
 *
 * @param {number} tab @param {readonly string[]} origins
 */
async function hold(tab, origins) {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const next = rules.reduce((max, r) => Math.max(max, r.id), 0) + 1;
    await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: rulesOf(rules, tab),
        addRules: pageRules(tab, origins, next),
    });
}

/** The tab's rules removed, once it is closed or no longer the session's.
 *  @param {number} tab */
async function release(tab) {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: rulesOf(rules, tab) });
}

/** @param {chrome.declarativeNetRequest.Rule[]} rules @param {number} tab */
function rulesOf(rules, tab) {
    return rules.filter((r) => r.condition.tabIds?.includes(tab)).map((r) => r.id);
}

/**
 * `tab` put in the session's group in `windowId`: the group one of its
 * tabs there is in, under the session's name, or a new one.
 *
 * @param {import("./registry.js").State} state @param {string} session
 * @param {number} tab @param {number} windowId
 */
async function group(state, session, tab, windowId) {
    const { name } = known(state, session);
    for (const gid of await groupsOf(state, session, name)) {
        const g = await chrome.tabGroups.get(gid);
        if (g.windowId === windowId) {
            await chrome.tabs.group({ groupId: gid, tabIds: [tab] });
            return;
        }
    }
    const gid = await chrome.tabs.group({ tabIds: [tab], createProperties: { windowId } });
    await chrome.tabGroups.update(gid, { title: name });
}

/** @param {import("./registry.js").State} state @param {string} session
 *  @param {string} from @param {string} to */
async function renameGroups(state, session, from, to) {
    for (const gid of await groupsOf(state, session, from)) await chrome.tabGroups.update(gid, { title: to });
}

/**
 * The groups the session's tabs are in that carry `title`: a tab the
 * person dragged into a group of their own leaves that group alone.
 *
 * @param {import("./registry.js").State} state @param {string} session @param {string} title
 * @returns {Promise<number[]>}
 */
async function groupsOf(state, session, title) {
    const ids = new Set();
    for (const id of tabsOf(state, session)) {
        const tab = await chrome.tabs.get(id).catch(() => null);
        if (tab !== null && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) ids.add(tab.groupId);
    }
    const found = [];
    for (const gid of ids) {
        const g = await chrome.tabGroups.get(gid).catch(() => null);
        if (g?.title === title) found.push(gid);
    }
    return found;
}

/** @param {Request} req */
function sessionArg(req) {
    if (typeof req.session !== "string" || req.session === "") throw bad("session: the top session's id");
    return req.session;
}

/** @param {Request} req */
function tabArg(req) {
    if (!Number.isInteger(req.tab)) throw bad("tab: a tab's id, from open or tabs");
    return /** @type {number} */ (req.tab);
}

/** @param {string} message */
function bad(message) {
    return new ProtocolError("bad-request", message);
}
