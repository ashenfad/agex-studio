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
 * open, are in the registry, and the tabs the person shared with one:
 * those stay the person's, never held, grouped or closed, and are only
 * read, while they're on the site they were shared on.
 */

import { granted, hostOf, isDomain, pageRules } from "./grants.js";
import { ProtocolError, STUDIO_MATCHES } from "./protocol.js";
import { originMatcher } from "./origins.js";
import { change, read } from "./registry.js";
import { MARK, isWorking, rest, restAll, resume } from "./work.js";

/** @typedef {import("./protocol.js").Request} Request */

/** The studio tabs' ports whose turn runs now. A stopped worker forgets
 *  them, with the debugger's sessions, which its start detaches.
 *  @type {Set<chrome.runtime.Port>} */
const turning = new Set();
/** @type {WeakSet<chrome.runtime.Port>} */
const watched = new WeakSet();
/** agex.studio's own pages, which are never shared (a dev build's studio
 *  on localhost is known by its port instead) */
const studioPage = originMatcher(STUDIO_MATCHES);

/** @type {Record<string, import("./port.js").Op>} */
export const tabOps = {
    /** A session's name (its tab group's title) and the domains it may
     *  load, set or replaced. Its open tabs are held to the new domains
     *  at once. */
    async session(req) {
        const session = sessionArg(req);
        const { name, domains } = req;
        if (typeof name !== "string" || name === "") throw bad("name: the session's name, its tab group's title");
        if (!Array.isArray(domains) || !domains.every(isDomain)) {
            throw bad("domains: a list of domains, each like marriott.com (its subdomains are granted with it)");
        }
        await change(async (state) => {
            const before = state.sessions[session];
            state.sessions[session] = { name, domains: [...new Set(domains)] };
            for (const tab of ownedOf(state, session)) await hold(tab, domains);
            if (before !== undefined && before.name !== name) await renameGroups(state, session, before.name, name);
        });
        return null;
    },

    /** The sessions the extension has been told of, each with its name
     *  and domains: what the studio checks against its own grants, since
     *  the extension keeps them while the studio isn't connected. */
    async sessions() {
        return change((state) => Object.entries(state.sessions).map(([session, s]) => ({ session, name: s.name, domains: [...s.domains] })));
    },

    /** A tab opened for a session, in the background of the studio's
     *  window, on a URL it holds a grant for. */
    async open(req, port) {
        const session = sessionArg(req);
        const { url } = req;
        if (typeof url !== "string" || hostOf(url) === null) throw bad("url: an http or https URL");
        const windowId = port.sender?.tab?.windowId;
        if (windowId === undefined) throw new ProtocolError("failed", "the port has no window to open a tab in");
        const tab = await change(async (state) => {
            const s = known(state, session);
            if (!granted(url, s.domains)) throw new ProtocolError("not-granted", `this session holds no grant for ${hostOf(url)}`);
            // blank, and held to the grants, before it loads anything
            const { id } = await chrome.tabs.create({ url: "about:blank", active: false, windowId });
            if (id === undefined) throw new ProtocolError("failed", "the new tab has no id");
            try {
                await hold(id, s.domains);
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

    /** One of the session's tabs brought to the front of its window, and
     *  the window to the front, for the person's hands (a handoff): the
     *  agent's work in it rests first, so the page is the person's alone,
     *  and every outline read of it before is stale. */
    async show(req) {
        const session = sessionArg(req);
        const tab = tabArg(req);
        await change((state) => {
            mine(state, session, tab);
            if (state.tabs[tab].shared) throw readOnly(tab);
            // what anyone read of it is the page before the person's hands: read again after
            const t = state.tabs[tab];
            t.reads = (t.reads ?? 0) + 1;
        });
        await rest(tab);
        const shown = await chrome.tabs.update(tab, { active: true });
        if (shown?.windowId !== undefined) await chrome.windows.update(shown.windowId, { focused: true });
        return null;
    },

    /** The person's cancel of the agent's work (Chrome's debugging bar)
     *  lifted, on their word: the agent goes on before the next turn. */
    async resume() {
        resume();
        return null;
    },

    /** One of the session's tabs closed. */
    async close(req) {
        const session = sessionArg(req);
        const tab = tabArg(req);
        await change(async (state) => {
            mine(state, session, tab);
            if (state.tabs[tab].shared) throw readOnly(tab);
            await chrome.tabs.remove(tab).catch(() => {}); // already gone is closed too
            delete state.tabs[tab];
            await release(tab);
        });
        return null;
    },

    /** The session's tabs, each with its URL and title, whether the
     *  agent is working in it, and the last load the extension stopped
     *  in it. */
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
                const { blocked, shared } = state.tabs[id];
                listed.push({
                    id,
                    url: tab.url ?? "",
                    title: unmarked(tab.title ?? ""),
                    working: isWorking(id),
                    ...(blocked && { blocked }),
                    ...(shared && { shared: shared.domain }),
                });
            }
            return listed;
        });
    },

    /** The person's open tabs that could be shared, for the studio's
     *  picker, the latest used first: http and https pages, not a
     *  session's (its own or shared already) nor the studio's. */
    async browsable(req, port) {
        const studio = port.sender?.tab?.id;
        return change(async (state) => {
            const open = await chrome.tabs.query({});
            return open
                .filter((t) => t.id !== undefined && shareable(state, t, studio))
                .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))
                .map((t) => ({ id: /** @type {number} */ (t.id), url: t.url ?? "", title: t.title ?? "" }));
        });
    },

    /** One of the person's tabs shared with the session, to read, on the
     *  domain it's on now: the one the person chose in the studio. */
    async share(req, port) {
        const session = sessionArg(req);
        const tab = tabArg(req);
        const studio = port.sender?.tab?.id;
        const domain = await change(async (state) => {
            known(state, session);
            const t = await chrome.tabs.get(tab).catch(() => null);
            if (t === null) throw new ProtocolError("not-found", `no tab ${tab}`);
            if (!shareable(state, t, studio)) {
                throw new ProtocolError("bad-request", `tab ${tab} can't be shared: only one of the person's own http or https pages can, not a session's tab or the studio's`);
            }
            const d = siteOf(/** @type {string} */ (t.url));
            state.tabs[tab] = { session, shared: { domain: d, at: Date.now() } };
            return d;
        });
        return { tab, domain };
    },

    /** A tab the person shared, the session's no longer: it's left open,
     *  as it always was the person's. */
    async unshare(req) {
        const session = sessionArg(req);
        const tab = tabArg(req);
        await change((state) => {
            mine(state, session, tab);
            if (!state.tabs[tab].shared) throw new ProtocolError("bad-request", `tab ${tab} is the session's own: close it instead`);
            delete state.tabs[tab];
        });
        await rest(tab);
        return null;
    },

    /** While a turn runs, the studio's tab isn't discarded to save
     *  memory, which would end the turn. A turn's start lifts the
     *  person's cancel of the agent's work; once no studio tab's turn
     *  runs (each port says for its own, and a port that closes has
     *  ended its), every tab worked in rests. */
    async turn(req, port) {
        if (typeof req.running !== "boolean") throw bad("running: whether a turn is running");
        const id = port.sender?.tab?.id;
        if (id === undefined) throw new ProtocolError("failed", "the port has no tab");
        if (req.running) {
            turning.add(port);
            if (!watched.has(port)) {
                watched.add(port);
                port.onDisconnect.addListener(() => {
                    if (turning.delete(port) && turning.size === 0) void restAll();
                });
            }
            resume();
        } else {
            turning.delete(port);
            if (turning.size === 0) await restAll();
        }
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
            // the person's own tab, shared or not: what its pages open is theirs
            if (source === undefined || source.shared) return;
            const { domains } = known(state, source.session);
            let refused = granted(url, domains) ? undefined : url;
            if (refused === undefined) {
                await hold(tabId, domains);
                const tab = await chrome.tabs.get(tabId).catch(() => null);
                if (tab === null) {
                    await release(tabId);
                    return;
                }
                // a page can open a tab and send it on at once, before its
                // rules were in place: where it is now is what counts
                refused = [tab.url, tab.pendingUrl].find((u) => u && !granted(u, domains));
            }
            if (refused !== undefined) {
                // behind first: closed in front, it would hand the front to its neighbour
                await sendBack(state, tabId);
                await chrome.tabs.remove(tabId).catch(() => {});
                await release(tabId);
                source.blocked = { url: refused, at: Date.now(), newTab: true };
                return;
            }
            state.tabs[tabId] = { session: source.session, opened: true, opener: sourceTabId };
            await sendBack(state, tabId);
            const tab = await chrome.tabs.get(tabId).catch(() => null);
            // a popup window takes no group; the tab is the session's all the same
            if (tab !== null) await group(state, source.session, tabId, tab.windowId).catch(() => {});
        });
    });

    // a tab a page opened can be sent on before its rules are in place, and still say
    // where it started when it's looked at: where it gets to is checked as it gets there
    chrome.webNavigation.onCommitted.addListener(({ tabId, frameId, url }) => {
        if (frameId !== 0) return;
        void change(async (state) => {
            const tab = state.tabs[tabId];
            if (!tab?.opened || granted(url, known(state, tab.session).domains)) return;
            // a load the rules stopped shows its error page, and the tab is held, not closed
            const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 }).catch(() => null);
            if (frame?.errorOccurred) return;
            await sendBack(state, tabId);
            await chrome.tabs.remove(tabId).catch(() => {});
            delete state.tabs[tabId];
            await release(tabId);
            const source = tab.opener === undefined ? undefined : state.tabs[tab.opener];
            if (source !== undefined) source.blocked = { url, at: Date.now(), newTab: true };
        });
    });

    chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
        void change((state) => shown(state, windowId, tabId));
    });
    chrome.windows.onFocusChanged.addListener((windowId) => {
        if (windowId === chrome.windows.WINDOW_ID_NONE) return;
        void change((state) => {
            state.focused = [...state.focused.filter((id) => id !== windowId), windowId].slice(-SHOWN);
        });
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
            // a shared tab's loads aren't held: another extension stopped that one
            if (tab === undefined || tab.shared || granted(url, state.sessions[tab.session]?.domains ?? [])) return;
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
            if (!tab.shared) await hold(added, known(state, tab.session).domains);
            await release(removed);
            delete state.tabs[removed];
            state.tabs[added] = tab;
            // the tabs its pages opened are from it still
            for (const t of Object.values(state.tabs)) if (t.opener === removed) t.opener = added;
        });
    });
}

/** How many of the tabs a window has shown it remembers. */
const SHOWN = 10;

/**
 * As the worker starts: the registry's tabs held again, since an update
 * or a reload of the extension clears their rules and leaves the tabs
 * open, and the ones gone since dropped; and the tab each window shows
 * now, and the focused window, since the browser told of none before
 * the worker ran. When the browser itself has just started, every tab
 * id the registry kept is stale, and it starts empty.
 */
export function start() {
    void change(async (state) => {
        const rules = await chrome.declarativeNetRequest.getSessionRules();
        for (const [key, { session, shared }] of Object.entries(state.tabs)) {
            const id = Number(key);
            if ((await chrome.tabs.get(id).catch(() => null)) === null) {
                delete state.tabs[key];
                await release(id);
            } else if (!shared && rulesOf(rules, id).length === 0) {
                await hold(id, state.sessions[session]?.domains ?? []);
            }
        }
        for (const tab of await chrome.tabs.query({ active: true })) {
            if (tab.id !== undefined && state.windows[tab.windowId] === undefined) shown(state, tab.windowId, tab.id);
        }
        const focused = await chrome.windows.getLastFocused().catch(() => null);
        if (focused?.id !== undefined && state.focused.length === 0) state.focused = [focused.id];
    });
    chrome.runtime.onStartup.addListener(() => {
        void change(async (state) => {
            const rules = await chrome.declarativeNetRequest.getSessionRules();
            await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: rules.map((r) => r.id) });
            state.sessions = {};
            state.tabs = {};
        });
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
 * can open several at once, each taking the front from the one before),
 * or for a popup in a window of its own, the window focused before it.
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
    // alone in a window of its own (a popup): the focus goes back to the
    // window that had it before
    const window = await chrome.windows.get(tab.windowId, { populate: true }).catch(() => null);
    if (window === null || !window.focused || (window.tabs?.length ?? 0) > 1) return;
    for (const id of [...state.focused].reverse()) {
        if (id === tab.windowId) continue;
        const back = await chrome.windows.update(id, { focused: true }).catch(() => null);
        if (back) return;
    }
}

/** @param {import("./registry.js").State} state @param {string} session */
function tabsOf(state, session) {
    return Object.entries(state.tabs)
        .filter(([, t]) => t.session === session)
        .map(([id]) => Number(id));
}

/** The session's own tabs, held to its grants and in its groups: not the
 *  ones the person shared. @param {import("./registry.js").State} state @param {string} session */
function ownedOf(state, session) {
    return tabsOf(state, session).filter((id) => !state.tabs[id].shared);
}

/**
 * Whether `tab` is one the person could share: an http or https page,
 * not a session's (its own or shared already), nor the studio's (the
 * tab whose port asks, or any agex.studio page).
 *
 * @param {import("./registry.js").State} state @param {chrome.tabs.Tab} tab
 * @param {number | undefined} studio
 */
function shareable(state, tab, studio) {
    const url = tab.url ?? "";
    return tab.id !== undefined && tab.id !== studio && !(tab.id in state.tabs) && hostOf(url) !== null && !studioPage(url);
}

/** The host a share of a page at `url` covers. @param {string} url */
function siteOf(url) {
    return /** @type {string} */ (hostOf(url));
}

/**
 * Whether a shared tab at `url` is on the site it was shared on: its
 * host, a subdomain of it, or, for a `www.` host, the bare one the site
 * may send it to. Never a sibling: sharing `www.github.io` isn't sharing
 * `someone.github.io`.
 *
 * @param {string} url @param {string} domain
 */
function onSite(url, domain) {
    const host = hostOf(url);
    if (host === null) return false;
    return host === domain || host.endsWith(`.${domain}`) || (domain.startsWith("www.") && host === domain.slice(4));
}

/**
 * The session and tab a request names, checked: the tab is the
 * session's. With the session's granted domains, the version of the
 * tab's latest outline (none read yet, 0), and for a tab the person
 * shared, the domain it was shared on.
 *
 * A shared tab is only read (`reading`, else `read-only`), and only on
 * its site (else `moved`); a reading op checks it again once it has read
 * (`stillOn`), as the person may have taken it elsewhere meanwhile.
 *
 * @param {Request} req @param {{ reading?: boolean }} [opts]
 */
export async function ownTab(req, { reading = false } = {}) {
    const session = sessionArg(req);
    const tab = tabArg(req);
    const { domains, latest, shared } = await change((state) => {
        mine(state, session, tab);
        const t = state.tabs[tab];
        return { domains: known(state, session).domains, latest: t.reads ?? 0, shared: t.shared };
    });
    if (shared !== undefined) {
        if (!reading) throw readOnly(tab);
        await stillOn(session, tab, shared);
    }
    return { session, tab, domains, latest, shared };
}

/**
 * A read of a tab the person shared, checked before it's given: the tab
 * is still shared with the session, by the same share (a stop, or a
 * share since with another session, ends it: `not-found`), and on the
 * site it was shared on (else `moved`: what it shows there wasn't
 * shared). `url`, where a read found it; else where the browser says it
 * is. A session's own tab passes.
 *
 * @param {string} session @param {number} tab
 * @param {import("./registry.js").Shared | undefined} shared the share ownTab found, or undefined for the session's own tab
 * @param {string} [url]
 */
export async function stillOn(session, tab, shared, url) {
    if (shared === undefined) return;
    const now = (await read()).tabs[tab];
    if (now?.session !== session || now.shared?.at !== shared.at) {
        throw new ProtocolError("not-found", `tab ${tab} isn't shared with this session any more`);
    }
    const at = url ?? (await chrome.tabs.get(tab).catch(() => null))?.url ?? "";
    if (!onSite(at, shared.domain)) {
        throw new ProtocolError("moved", `tab ${tab} was shared on ${shared.domain}, and has gone to ${hostOf(at) ?? "another page"}: what it shows there wasn't shared; ask the person to share it again`);
    }
}

/** A tab's title without the mark of the agent working in it.
 *  @param {string} title */
export function unmarked(title) {
    return title.startsWith(MARK) ? title.slice(MARK.length) : title;
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
 * The tab's rules replaced by ones holding it to `domains`, in one
 * update, so it is never unheld between the two.
 *
 * @param {number} tab @param {readonly string[]} domains
 */
async function hold(tab, domains) {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const next = rules.reduce((max, r) => Math.max(max, r.id), 0) + 1;
    await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: rulesOf(rules, tab),
        addRules: pageRules(tab, domains, next),
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
    for (const id of ownedOf(state, session)) {
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

/** @param {number} tab */
function readOnly(tab) {
    return new ProtocolError("read-only", `tab ${tab} is the person's, shared to read: read it, scroll it, wait on it or screenshot it; it can't be acted in, shown, sent elsewhere or closed`);
}

/** @param {string} message */
function bad(message) {
    return new ProtocolError("bad-request", message);
}
