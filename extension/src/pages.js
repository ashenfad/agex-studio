/**
 * Reading a session's tab, and moving it on: its outline, a `goto`, a
 * wait for what a page renders, and a screenshot. Each works in the tab
 * (`work`), so the page renders as if it were in front.
 */

import { granted, hostOf } from "./grants.js";
import { outlinePage, pageHas } from "./outline.js";
import { ProtocolError } from "./protocol.js";
import { change } from "./registry.js";
import { ownTab, unmarked } from "./tabs.js";
import { inWorld, send, work } from "./work.js";

/** How long `read` waits for a page still loading before it reads it anyway. */
const READ_LOAD_MS = 10_000;
/** How long `goto` waits for the page to load. */
const GOTO_LOAD_MS = 30_000;
/** `waitFor`'s timeout, and the most it may be given. */
const WAIT_MS = 10_000;
const WAIT_MAX_MS = 60_000;

/** @type {Record<string, import("./port.js").Op>} */
export const pageOps = {
    /** The page's outline (`outline.js`), under a new version. */
    async read(req) {
        const { tab } = await ownTab(req);
        const { maxChars, hrefs } = req;
        if (maxChars !== undefined && !(Number.isInteger(maxChars) && /** @type {number} */ (maxChars) >= 100)) {
            throw bad("maxChars: how much of the page's text to read, at least 100");
        }
        if (hrefs !== undefined && typeof hrefs !== "boolean") throw bad("hrefs: whether links say where they go");
        await work(tab);
        const loaded = await settled(tab, READ_LOAD_MS);
        const version = await change((state) => {
            const t = state.tabs[tab];
            t.reads = (t.reads ?? 0) + 1;
            return t.reads;
        });
        const outline = await inWorld(tab, outlinePage, [version, { maxChars: /** @type {number | undefined} */ (maxChars), hrefs: /** @type {boolean | undefined} */ (hrefs) }]);
        // the browser's own page, for a load that failed, is at the URL that did
        const url = outline.url.startsWith("chrome-error:") ? ((await chrome.tabs.get(tab)).url ?? outline.url) : outline.url;
        const blocked = await change((state) => state.tabs[tab]?.blocked);
        return {
            ...outline,
            url,
            title: unmarked(outline.title),
            ...(!loaded && { loading: true }),
            // a load the extension stopped
            ...(blocked?.url === url && !blocked.newTab && { blocked }),
        };
    },

    /** The tab sent to `url`, on a domain the session holds a grant
     *  for, and its load waited for. */
    async goto(req) {
        const { tab, domains } = await ownTab(req);
        const { url } = req;
        if (typeof url !== "string" || hostOf(url) === null) throw bad("url: an http or https URL");
        if (!granted(url, domains)) throw new ProtocolError("not-granted", `this session holds no grant for ${hostOf(url)}`);
        await work(tab);
        const { errorText } = await send(tab, "Page.navigate", { url });
        const loaded = await settled(tab, GOTO_LOAD_MS);
        const now = await chrome.tabs.get(tab);
        if (errorText?.includes("ERR_BLOCKED_BY_CLIENT")) {
            // a redirect, on to somewhere else
            throw new ProtocolError("not-granted", `the page went on to ${hostOf(now.url ?? "") ?? now.url}, which this session holds no grant for`);
        }
        if (errorText) throw new ProtocolError("failed", `the page didn't load: ${errorText}`);
        await work(tab); // the new page marked
        return { url: now.url ?? url, title: unmarked(now.title ?? ""), ...(!loaded && { loading: true }) };
    },

    /** Wait until the page shows `text`, or has an element matching
     *  `selector`. */
    async waitFor(req) {
        const { tab } = await ownTab(req);
        const { text, selector, timeout = WAIT_MS } = req;
        if ((typeof text === "string") === (typeof selector === "string")) throw bad("text or selector: what to wait for, one of them");
        if (!Number.isInteger(timeout) || /** @type {number} */ (timeout) < 0 || /** @type {number} */ (timeout) > WAIT_MAX_MS) {
            throw bad(`timeout: how long to wait, in ms, up to ${WAIT_MAX_MS}`);
        }
        const what = /** @type {{ text?: string, selector?: string }} */ (text !== undefined ? { text } : { selector });
        const started = performance.now();
        for (;;) {
            await work(tab);
            const has = await inWorld(tab, pageHas, [what]).catch((e) => {
                if (e instanceof ProtocolError) throw e; // the page's own error: a selector it can't read
                return false; // between two documents
            });
            const ms = Math.round(performance.now() - started);
            if (has) return { ms };
            if (ms >= /** @type {number} */ (timeout)) {
                throw new ProtocolError("timeout", `the page still doesn't ${text !== undefined ? `show ${JSON.stringify(text)}` : `have ${selector}`} after ${ms}ms`);
            }
            await new Promise((ok) => setTimeout(ok, 250));
        }
    },

    /** The tab as it renders now, a JPEG. */
    async screenshot(req) {
        const { tab } = await ownTab(req);
        await work(tab);
        const shot = send(tab, "Page.captureScreenshot", { format: "jpeg", quality: 70 });
        const late = new Promise((_, no) => setTimeout(() => no(new ProtocolError("timeout", "the screenshot took more than 10s")), 10_000));
        const { data } = await Promise.race([shot, late]);
        return { mime: "image/jpeg", data };
    },
};

/**
 * Whether the tab's page has loaded, within `ms`.
 *
 * @param {number} tab @param {number} ms
 */
export async function settled(tab, ms) {
    const until = Date.now() + ms;
    await new Promise((ok) => setTimeout(ok, 100)); // a navigation just begun may not show as loading yet
    while (Date.now() < until) {
        const t = await chrome.tabs.get(tab).catch(() => null);
        if (t === null) throw new ProtocolError("not-found", `tab ${tab} has closed`);
        if (t.status === "complete" && t.url !== "about:blank") return true;
        await new Promise((ok) => setTimeout(ok, 100));
    }
    return false;
}

/** @param {string} message */
function bad(message) {
    return new ProtocolError("bad-request", message);
}
