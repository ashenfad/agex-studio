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
 * those stay the person's, never grouped or closed, and are worked in
 * only while they're on the site they were shared on: read, or, if the
 * person let the agent act there, acted in too, their loads held to that
 * site and the session's grants only while the agent acts.
 */

import { badge } from "./badge.js";
import { granted, hostOf, isDomain, pageRules } from "./grants.js";
import { ProtocolError, STUDIO_MATCHES } from "./protocol.js";
import { originMatcher } from "./origins.js";
import { change, read } from "./registry.js";
import { MARK, isWorking, onRested, rest, restAll, resume, work } from "./work.js";

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
/** Told when the shares change from the browser's side (the popup, a
 *  shared tab closed), for the studio to look again. */
let sharesChanged = () => {};

/** Call `fn` whenever the shares change from the browser's side.
 *  @param {() => void} fn */
export function onSharesChanged(fn) {
    sharesChanged = fn;
}

/** Where a share from the toolbar sends the person when no studio tab is open. */
const STUDIO_URL = "https://agex.studio/";

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
            // and a shared tab the agent acts in now, to the new grants and its site
            for (const tab of tabsOf(state, session)) {
                const shared = state.tabs[tab].shared;
                if (shared && actingIn.has(tab)) await holdTo(tab, domains, shared);
            }
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
            const { shared } = state.tabs[tab];
            if (shared && !shared.acts) throw readOnly(tab);
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
            const { shared } = state.tabs[tab];
            if (shared && !shared.acts) throw readOnly(tab);
            if (shared) throw new ProtocolError("bad-request", `tab ${tab} is the person's, shared with you: it stays open; leave it as it is when you're done`);
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
                    ...(shared && { shared: shared.domain, ...(shared.acts && { acts: true }) }),
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

    /** One of the person's tabs shared with the session, on the domain
     *  it's on now: the one the person chose in the studio, to read, or
     *  to act in too (`acts`). */
    async share(req, port) {
        const session = sessionArg(req);
        const tab = tabArg(req);
        const acts = actsArg(req);
        const studio = port.sender?.tab?.id;
        const domain = await change(async (state) => {
            known(state, session);
            const t = await chrome.tabs.get(tab).catch(() => null);
            if (t === null) throw new ProtocolError("not-found", `no tab ${tab}`);
            if (!shareable(state, t, studio)) {
                throw new ProtocolError("bad-request", `tab ${tab} can't be shared: only one of the person's own http or https pages can, not a session's tab or the studio's`);
            }
            const d = siteOf(/** @type {string} */ (t.url));
            delete state.shares[tab];
            state.tabs[tab] = { session, shared: { domain: d, at: Date.now(), ...(acts && { acts }) } };
            return d;
        });
        await badgeShared(tab);
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
        await stopped(tab);
        return null;
    },

    /** Whether the agent may act in a tab the person shared, or only
     *  read it, changed. */
    async shareMode(req) {
        const session = sessionArg(req);
        const tab = tabArg(req);
        const acts = actsArg(req);
        await setActs(tab, acts, session);
        return null;
    },

    /** The tabs the person shared from the toolbar that wait for the
     *  studio to say which session takes them, each as it is now. */
    async shares() {
        return change(async (state) => {
            const waiting = [];
            for (const [key, { domain, at }] of Object.entries(state.shares)) {
                const tab = await chrome.tabs.get(Number(key)).catch(() => null);
                if (tab === null || key in state.tabs) {
                    delete state.shares[key];
                    continue;
                }
                waiting.push({ tab: Number(key), url: tab.url ?? "", title: tab.title ?? "", domain, at });
            }
            return waiting;
        });
    },

    /** A tab shared from the toolbar given to the session the person
     *  chose, on the domain it was shared on, to read or to act in too. */
    async take(req) {
        const session = sessionArg(req);
        const tab = tabArg(req);
        const acts = actsArg(req);
        const domain = await change(async (state) => {
            known(state, session);
            const waiting = state.shares[tab];
            if (waiting === undefined) throw new ProtocolError("not-found", `no share of tab ${tab} waits to be taken`);
            delete state.shares[tab];
            if ((await chrome.tabs.get(tab).catch(() => null)) === null) throw new ProtocolError("not-found", `tab ${tab} was closed`);
            state.tabs[tab] = { session, shared: { domain: waiting.domain, at: Date.now(), ...(acts && { acts }) } };
            return waiting.domain;
        });
        await badgeShared(tab);
        return { tab, domain };
    },

    /** A share from the toolbar turned down: the tab is left as it was.
     *  One taken meanwhile (by another of the studio's tabs) stays taken. */
    async drop(req) {
        const tab = tabArg(req);
        const waited = await change((state) => {
            const was = tab in state.shares;
            delete state.shares[tab];
            return was;
        });
        if (waited) await badge(tab, null);
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
    // a shared tab's loads are the person's again once the agent's work in it rests
    onRested((tab) => void letGo(tab));

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
            // a shared tab's loads are held only while the agent acts there: else another extension stopped that one
            if (tab === undefined || (tab.shared && !actingIn.has(tabId))) return false;
            if (mayGo(url, state.sessions[tab.session]?.domains ?? [], tab.shared)) return false;
            tab.blocked = { url, at: Date.now() };
            return tab.shared !== undefined;
        }).then((shared) => {
            // the person's own tab isn't left on the error page: back to the page it left
            if (shared) void chrome.tabs.goBack(tabId).catch(() => {});
        });
    });

    chrome.tabs.onRemoved.addListener((id) => {
        void change(async (state) => {
            const waited = id in state.shares;
            delete state.shares[id];
            const t = state.tabs[id];
            if (t === undefined) return waited;
            delete state.tabs[id];
            await release(id);
            return waited || t.shared !== undefined;
        }).then((share) => share && sharesChanged());
    });

    // the toolbar's badge on a shared tab, again on each page it loads
    chrome.webNavigation.onCommitted.addListener(({ tabId, frameId }) => {
        if (frameId === 0) void badgeShared(tabId);
    });

    // a prerendered page swapped in comes with a new tab id
    chrome.tabs.onReplaced.addListener((added, removed) => {
        void change(async (state) => {
            // a share waiting for the studio goes with it
            const waiting = state.shares[removed];
            if (waiting !== undefined) {
                delete state.shares[removed];
                state.shares[added] = waiting;
            }
            const tab = state.tabs[removed];
            if (tab !== undefined) {
                if (!tab.shared) await hold(added, known(state, tab.session).domains);
                await release(removed);
                delete state.tabs[removed];
                state.tabs[added] = tab;
                // the tabs its pages opened are from it still
                for (const t of Object.values(state.tabs)) if (t.opener === removed) t.opener = added;
            }
            return waiting !== undefined || tab?.shared !== undefined;
        }).then((shared) => shared && badgeShared(added));
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
            } else if (shared && rulesOf(rules, id).length > 0) {
                // held while the agent acted, by a worker since stopped: the tab is the person's again
                await release(id);
            }
        }
        for (const tab of await chrome.tabs.query({ active: true })) {
            if (tab.id !== undefined && state.windows[tab.windowId] === undefined) shown(state, tab.windowId, tab.id);
        }
        const focused = await chrome.windows.getLastFocused().catch(() => null);
        if (focused?.id !== undefined && state.focused.length === 0) state.focused = [focused.id];
        // an update or a reload of the extension clears its badges
        for (const key of [...Object.keys(state.tabs), ...Object.keys(state.shares)]) void badgeShared(Number(key));
    });
    chrome.runtime.onStartup.addListener(() => {
        void change(async (state) => {
            const rules = await chrome.declarativeNetRequest.getSessionRules();
            await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: rules.map((r) => r.id) });
            state.sessions = {};
            state.tabs = {};
            state.shares = {};
        });
    });
}

/** The studio connected from `tab`, on `origin`: where a share from the
 *  toolbar sends the person, while that tab is still on it.
 *  @param {number | undefined} tab @param {string | undefined} origin */
export function studioConnected(tab, origin) {
    if (tab === undefined || origin === undefined) return;
    void change((state) => {
        state.studio = { tab, origin };
    });
}

/** The studio's tab, if it's still on the studio's origin.
 *  @param {import("./registry.js").State} state */
async function studioTab(state) {
    if (state.studio === null) return null;
    const tab = await chrome.tabs.get(state.studio.tab).catch(() => null);
    return tab !== null && originOf(tab.url ?? "") === state.studio.origin ? tab : null;
}

/** @param {string} url */
function originOf(url) {
    try {
        return new URL(url).origin;
    } catch {
        return null;
    }
}

/**
 * What the toolbar's popup shows for `tab`: that it can be shared, waits
 * for the studio, is shared with a session (its name, and the domain), is
 * a session's own, is the studio, or is another kind of page.
 *
 * @param {number} tab
 * @returns {Promise<{ kind: "share" | "waiting" | "shared" | "session" | "studio" | "page", name?: string, domain?: string, acts?: boolean }>}
 */
export async function popupState(tab) {
    return change(async (state) => {
        const t = state.tabs[tab];
        if (t !== undefined) {
            const name = state.sessions[t.session]?.name ?? t.session;
            return t.shared ? { kind: "shared", name, domain: t.shared.domain, acts: t.shared.acts === true } : { kind: "session", name };
        }
        if (tab in state.shares) return { kind: "waiting", domain: state.shares[tab].domain };
        const open = await chrome.tabs.get(tab).catch(() => null);
        const studio = await studioTab(state);
        if (open !== null && (tab === studio?.id || studioPage(open.url ?? ""))) return { kind: "studio" };
        if (open === null || !shareable(state, open, studio?.id)) return { kind: "page" };
        return { kind: "share", domain: siteOf(/** @type {string} */ (open.url)) };
    });
}

/**
 * The person's share of `tab` from the toolbar: kept, on the domain it's
 * on, until the studio says which session takes it, and the studio
 * brought to the front to ask them (or agex.studio opened).
 *
 * @param {number} tab
 */
export async function offer(tab) {
    const studio = await change(async (state) => {
        const open = await chrome.tabs.get(tab).catch(() => null);
        const at = await studioTab(state);
        if (open === null || !shareable(state, open, at?.id)) {
            throw new ProtocolError("bad-request", `tab ${tab} can't be shared: only one of the person's own http or https pages can`);
        }
        state.shares[tab] = { domain: siteOf(/** @type {string} */ (open.url)), at: Date.now() };
        return at;
    });
    await badgeShared(tab);
    // a studio connected now looks at once, in view or not
    sharesChanged();
    const [found] = studio === null ? await chrome.tabs.query({ url: [...STUDIO_MATCHES] }) : [studio];
    if (found?.id === undefined) {
        await chrome.tabs.create({ url: STUDIO_URL, active: true });
        return;
    }
    await chrome.tabs.update(found.id, { active: true });
    await chrome.windows.update(found.windowId, { focused: true });
}

/**
 * A share of `tab` ended, from the popup: a share waiting for the studio
 * dropped, or the tab no longer the session's.
 *
 * @param {number} tab
 */
export async function stopSharing(tab) {
    const was = await change((state) => {
        delete state.shares[tab];
        if (!state.tabs[tab]?.shared) return false;
        delete state.tabs[tab];
        return true;
    });
    if (was) await stopped(tab);
    else await badge(tab, null);
    sharesChanged();
}

/** The popup's switch on a shared tab: whether its agent may act there
 *  too, or only read it. @param {number} tab @param {boolean} acts */
export async function popupActs(tab, acts) {
    await setActs(tab, acts);
}

/** A share ended: the agent's work in the tab rested, its badge gone.
 *  @param {number} tab */
async function stopped(tab) {
    await rest(tab);
    await letGo(tab);
    await badge(tab, null);
}

/** The toolbar's badge on `tab` as its share stands: shared (with whom,
 *  on what domain), waiting for the studio, or left alone when neither.
 *  @param {number} tab */
async function badgeShared(tab) {
    const state = await read();
    const shared = state.tabs[tab]?.shared;
    if (shared) {
        const name = state.sessions[state.tabs[tab].session]?.name ?? "a session";
        await badge(tab, "shared", `Shared with ${name}${shared.acts ? "" : " (read only)"}`);
    } else if (tab in state.shares) {
        await badge(tab, "waiting", "Waiting for agex.studio");
    }
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
 * shared, its share.
 *
 * A shared tab is worked in only on its site (else `moved`), and a
 * reading op checks it again once it has read (`stillOn`), as the person
 * may have taken it elsewhere meanwhile. One only to read refuses
 * anything else (`read-only`); in one to act in, a step that acts holds
 * its loads to the session's grants and its site until its work rests.
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
        if (!reading && !shared.acts) throw readOnly(tab);
        await stillOn(session, tab, shared);
        if (!reading) await holdShared(tab, domains, shared);
    }
    return { session, tab, domains, latest, shared };
}

/**
 * Whether `url` is somewhere a step in a tab may send it: a domain the
 * session holds a grant for, or, in a shared tab, the site it was shared on.
 *
 * @param {string} url @param {readonly string[]} domains
 * @param {import("./registry.js").Shared | undefined} shared
 */
export function mayGo(url, domains, shared) {
    return granted(url, domains) || (shared !== undefined && onSite(url, shared.domain));
}

/** Tabs the person shared whose loads are held now, while the agent acts. @type {Set<number>} */
const actingIn = new Set();

/**
 * A shared tab's loads held, while the agent acts in it, to the session's
 * grants and the site it was shared on (its subdomains, and for a `www.`
 * host the bare one alone): a link or a script that would take it
 * anywhere else is stopped, as in the session's own tabs. Let go once the
 * work rests (`watchTabs`).
 *
 * @param {number} tab @param {readonly string[]} domains @param {import("./registry.js").Shared} shared
 */
async function holdShared(tab, domains, shared) {
    if (actingIn.has(tab)) return;
    // worked in first: its rest, which lets the hold go, is due even if the step fails before it acts
    await work(tab);
    actingIn.add(tab);
    await holdTo(tab, domains, shared);
}

/** A shared tab's loads held to `domains` and its site (its subdomains,
 *  and for a `www.` host the bare one alone).
 *  @param {number} tab @param {readonly string[]} domains @param {import("./registry.js").Shared} shared */
async function holdTo(tab, domains, shared) {
    const bare = shared.domain.startsWith("www.") ? [shared.domain.slice(4)] : [];
    await hold(tab, [...domains, shared.domain], bare);
}

/** A shared tab's hold let go, if it has one: the person's loads are theirs.
 *  @param {number} tab */
async function letGo(tab) {
    if (actingIn.delete(tab)) await release(tab);
}

/**
 * Whether the agent may act in shared tab `tab`, set: its work rested
 * first when it may no longer, so its loads are the person's again.
 *
 * @param {number} tab @param {boolean} acts @param {string} [session] the session it's shared with, checked when given
 */
async function setActs(tab, acts, session) {
    await change((state) => {
        const t = state.tabs[tab];
        if (t === undefined || (session !== undefined && t.session !== session)) throw new ProtocolError("not-found", `tab ${tab} isn't one of this session's`);
        if (!t.shared) throw new ProtocolError("bad-request", `tab ${tab} is the session's own, not one the person shared`);
        if (acts) t.shared.acts = true;
        else delete t.shared.acts;
    });
    if (!acts) {
        await rest(tab);
        await letGo(tab);
    }
    await badgeShared(tab);
    sharesChanged();
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
 * The tab's rules replaced by ones holding it to `domains`, and the
 * `exact` hosts alone, in one update, so it is never unheld between the two.
 *
 * @param {number} tab @param {readonly string[]} domains @param {readonly string[]} [exact]
 */
async function hold(tab, domains, exact = /** @type {string[]} */ ([])) {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const next = rules.reduce((max, r) => Math.max(max, r.id), 0) + 1;
    await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: rulesOf(rules, tab),
        addRules: pageRules(tab, domains, next, exact),
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

/** @param {Request} req */
function actsArg(req) {
    if (req.acts !== undefined && typeof req.acts !== "boolean") throw bad("acts: whether the agent may act in the tab (click, type, go on), or only read it");
    return req.acts === true;
}

/** @param {string} message */
function bad(message) {
    return new ProtocolError("bad-request", message);
}
