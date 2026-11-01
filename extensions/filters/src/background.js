/**
 * The site-filter extension's service worker. It answers the extension's
 * own pages (`runtime.sendMessage`), and nothing from the web: the
 * manifest names no `externally_connectable`.
 */

import { applyOps } from "./apply/sites.js";
import { capturePage } from "./capture/walk.js";
import { siteOfHost } from "./site.js";

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
    /** The page in tab `tabId`, as the popup shows it: its site (null for
     *  a page that isn't a site's), whether it holds a password field (so
     *  the warning before submitting it is the stronger one), and the
     *  site's agent's state. */
    page: async ({ tabId }) => {
        const tab = await chrome.tabs.get(/** @type {number} */ (tabId));
        const site = siteOf(tab.url);
        if (site === null) return { site: null };
        const [probe] = await chrome.scripting.executeScript({ target: { tabId: /** @type {number} */ (tabId) }, func: hasPassword }).catch(() => [null]);
        const { paused, sites } = /** @type {any} */ (await applyOps.filterState({ op: "filterState", site }));
        return {
            site,
            url: tab.url,
            title: tab.title,
            password: probe?.result === true,
            status: await statusOf(site),
            candidate: await candidateOf(site) ?? null,
            applied: sites[site] ?? null,
            paused,
        };
    },
    /** The page in tab `tabId` submitted: captured as the person sees it,
     *  saved as one of its site's pages, and a turn of the site's session
     *  started on it, which ends on its own time (`statusOf`). */
    submit: ({ tabId, steps }) => submit(/** @type {number} */ (tabId), __DEV__ ? steps : undefined),
    /** Site `site`'s agent's state: working, done or failed, and when. */
    status: ({ site }) => statusOf(/** @type {string} */ (site)),
    /** Site `site`'s candidate filter, or null when none waits. */
    candidate: async ({ site }) => await candidateOf(/** @type {string} */ (site)) ?? null,
    /** Site `site`'s candidate made its filter: only ever the one its agent
     *  presented, which `present_filter` checked in full. The popup asked
     *  Chrome for the site's permission first, from the person's click. */
    accept: async ({ site }) => {
        const candidate = await candidateOf(/** @type {string} */ (site));
        if (candidate === undefined) throw new Error(`no filter for ${site} waits for an answer`);
        const applied = await applyOps.filterAccept({ op: "filterAccept", site, filter: candidate.filter });
        await dropCandidate(/** @type {string} */ (site));
        return applied;
    },
    /** Site `site`'s candidate turned down; with a reason, a turn of the
     *  site's session on it, which ends on its own time. */
    reject: async ({ site, reason, steps }) => {
        await dropCandidate(/** @type {string} */ (site));
        if (typeof reason !== "string" || reason.trim() === "") return null;
        await setStatus(/** @type {string} */ (site), { state: "working" });
        await agent("rejected", { site, reason: reason.trim(), ...(__DEV__ && steps !== undefined && { steps }) });
        return null;
    },
    /** Everything of site `site`'s gone: its filter, its candidate, its
     *  session (its pages with it) and the permission it was given. */
    forget: async ({ site }) => {
        const s = /** @type {string} */ (site);
        const { sites } = /** @type {any} */ (await applyOps.filterState({ op: "filterState", site: s }));
        if (sites[s] !== undefined) await applyOps.filterRemove({ op: "filterRemove", site: s });
        await dropCandidate(s);
        await chrome.storage.session.remove(statusKey(s));
        await agent("forget", { site: s });
        await chrome.permissions.remove({ origins: [`*://${s}/*`, `*://*.${s}/*`] }).catch(() => false);
        return null;
    },
};
Object.assign(OPS, applyOps);

/** Whether the page holds a password field, a component's too (in a shadow
 *  root, closed ones as the extension reaches them): it runs in the page. */
function hasPassword() {
    /** @param {Document | ShadowRoot} root @returns {boolean} */
    const find = (root) =>
        root.querySelector("input[type=password]") !== null ||
        [...root.querySelectorAll("*")].some((el) => {
            const shadow = el.shadowRoot ?? /** @type {any} */ (globalThis).chrome?.dom?.openOrClosedShadowRoot?.(el);
            return shadow ? find(shadow) : false;
        });
    return find(document);
}

/** The site of the page at `url`, or null when it isn't a web page of one. @param {string | undefined} url */
function siteOf(url) {
    if (url === undefined) return null;
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? siteOfHost(u.hostname) : null;
}

/**
 * Capture tab `tabId` and hand it to its site's agent.
 *
 * @param {number} tabId @param {unknown} [steps] in the dev build, a scripted model's replies for the turn
 */
async function submit(tabId, steps) {
    const tab = await chrome.tabs.get(tabId);
    const site = siteOf(tab.url);
    if (site === null) throw new Error("this tab isn't a web page of a site");
    const [done] = await chrome.scripting.executeScript({ target: { tabId }, func: capturePage, args: [{}] });
    const capture = done?.result;
    if (!capture) throw new Error("the page couldn't be captured");
    // what was in view, for an agent that reads images; the capture is enough without it
    const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 70 }).catch(() => null);
    await setStatus(site, { state: "working" });
    try {
        const saved = /** @type {{ page: string }} */ (await agent("submit", { site, capture, shot, ...(steps !== undefined && { steps }) }));
        return { site, page: saved.page };
    } catch (e) {
        await setStatus(site, { state: "failed", error: String(/** @type {Error} */ (e)?.message ?? e) });
        throw e;
    }
}

/** @typedef {{ state: "working" | "done" | "failed", at: number, text?: string, error?: string }} Status */

/** Site `site`'s agent's state, kept under a key of its own until the
 *  browser closes, so two sites' changes never write over each other.
 *  @param {string} site */
const statusKey = (site) => `status:${site}`;

/** Site `site`'s agent's state, or null before its first turn here. @param {string} site
 *  @returns {Promise<Status | null>} */
async function statusOf(site) {
    const got = /** @type {Record<string, Status>} */ (await chrome.storage.session.get(statusKey(site)));
    return got[statusKey(site)] ?? null;
}

/** @param {string} site @param {Omit<Status, "at">} now */
async function setStatus(site, now) {
    await chrome.storage.session.set({ [statusKey(site)]: { ...now, at: Date.now() } });
}

/**
 * @typedef {{ site: string, filter: unknown, pages: { page: string, url: string, hidden: number, hiddenShare: number }[] }} Candidate
 *   A filter the site's agent presented, checked and tried on its saved
 *   pages, waiting for the person to preview it and say yes or no.
 */

/** Site `site`'s candidate, kept under a key of its own until the person
 *  answers. @param {string} site */
const candidateKey = (site) => `candidate:${site}`;

/** Site `site`'s candidate, or undefined when none waits. @param {string} site
 *  @returns {Promise<(Candidate & { at: number }) | undefined>} */
async function candidateOf(site) {
    const got = /** @type {Record<string, Candidate & { at: number }>} */ (await chrome.storage.local.get(candidateKey(site)));
    return got[candidateKey(site)];
}

/** A presented filter kept as its site's candidate, replacing one not yet
 *  answered, and the person told it's ready. @param {Candidate} candidate */
async function keepCandidate(candidate) {
    await chrome.storage.local.set({ [candidateKey(candidate.site)]: { ...candidate, at: Date.now() } });
    const hidden = candidate.pages.reduce((n, p) => n + p.hidden, 0);
    await chrome.notifications.create(`candidate:${candidate.site}`, {
        type: "basic",
        iconUrl: "icons/128.png",
        title: `A filter for ${candidate.site} is ready`,
        message: `It hides ${hidden} ${hidden === 1 ? "thing" : "things"} on the pages you sent. Open the site to preview it.`,
    });
}

/** Site `site`'s candidate dropped, and its notice with it. @param {string} site */
async function dropCandidate(site) {
    await chrome.storage.local.remove(candidateKey(site));
    await chrome.notifications.clear(`candidate:${site}`);
}

// the notice that a filter is ready: the site in front (a tab of it, or its page as sent),
// and the popup over it, to preview the filter there
chrome.notifications.onClicked.addListener(async (id) => {
    if (!id.startsWith("candidate:")) return;
    const site = id.slice("candidate:".length);
    const candidate = await candidateOf(site);
    if (candidate === undefined) return;
    const open = (await chrome.tabs.query({})).find((t) => siteOf(t.url) === site);
    const tab = open ?? (await chrome.tabs.create({ url: candidate.pages.at(-1)?.url }));
    if (tab.id !== undefined) await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.action.openPopup().catch(() => {});
});

/**
 * What the offscreen document tells the worker unasked: a filter the
 * agent presented, and a turn it ran having ended.
 *
 * @param {{ event: string, site: string, outcome?: { status: string, text: string }, error?: string }} msg
 */
async function onEvent(msg) {
    if (msg.event === "candidate") return keepCandidate(/** @type {any} */ (msg).candidate);
    if (msg.event !== "turn-ended") return;
    if (msg.error !== undefined || msg.outcome?.status !== "completed") {
        await setStatus(msg.site, { state: "failed", error: msg.error ?? msg.outcome?.text ?? msg.outcome?.status ?? "the turn ended early" });
    } else await setStatus(msg.site, { state: "done", text: msg.outcome.text });
}

if (__DEV__) {
    /** A turn on a scripted model, for the tests: `steps` are its replies. */
    OPS.scripted = ({ site, prompt, steps }) => agent("turn", { site, prompt, steps });
    /** The offscreen document closed (the agent's store stays). */
    OPS.restart = async () => {
        if ((await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] })).length > 0) await chrome.offscreen.closeDocument();
        return null;
    };
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    // only the extension's own pages (a content script's sender is the site's
    // page), and not what's meant for the offscreen document
    if (sender.id !== chrome.runtime.id || sender.origin !== self.location.origin || msg?.target !== undefined) return;
    if (typeof msg?.event === "string") return void onEvent(msg);
    const op = Object.hasOwn(OPS, msg?.op) ? OPS[msg.op] : undefined;
    if (op === undefined) return;
    op(msg).then((value) => reply({ value }), (e) => reply({ error: String(e?.message ?? e) }));
    return true;
});
