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
/** How long `read` with `settle` waits for the page's text to stop changing,
 *  and how long it must hold still to count. */
const SETTLE_MS = 10_000;
const STILL_MS = 1_000;
/** How many turns of the wheel `scroll` to the bottom takes at most, and
 *  how long, at the bottom, it waits for the page to grow (a list whose
 *  next batch comes over the network) before it counts as the end. */
const SCROLLS_MAX = 25;
const GROWTH_MS = 3_000;
/** `waitFor`'s timeout, and the most it may be given. */
const WAIT_MS = 10_000;
const WAIT_MAX_MS = 60_000;

/** @type {Record<string, import("./port.js").Op>} */
export const pageOps = {
    /** The page's outline (`outline.js`), under a new version. */
    async read(req) {
        const { tab } = await ownTab(req);
        const { maxChars, hrefs, settle } = req;
        if (maxChars !== undefined && !(Number.isInteger(maxChars) && /** @type {number} */ (maxChars) >= 100)) {
            throw bad("maxChars: how much of the page's text to read, at least 100");
        }
        if (hrefs !== undefined && typeof hrefs !== "boolean") throw bad("hrefs: whether links say where they go");
        if (settle !== undefined && typeof settle !== "boolean" && !(Number.isInteger(settle) && /** @type {number} */ (settle) > 0 && /** @type {number} */ (settle) <= 60_000)) {
            throw bad("settle: true, or how long to wait for the page to stop changing, in ms, up to 60000");
        }
        await work(tab);
        const loaded = await settled(tab, READ_LOAD_MS);
        // a page that draws its results after it loads: its text left to stop changing
        const still = settle ? await stillness(tab, settle === true ? SETTLE_MS : /** @type {number} */ (settle)) : true;
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
            ...(!still && { settled: false }),
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

    /** The page scrolled, as a person's wheel would (so a list that loads
     *  as it is scrolled loads): `to` "down", a screenful, or "bottom",
     *  until the page stops growing. */
    async scroll(req) {
        const { tab } = await ownTab(req);
        const { to = "down" } = req;
        if (to !== "down" && to !== "bottom") throw bad('to: "down" (a screenful) or "bottom"');
        await work(tab);
        let at = await inWorld(tab, scrolledTo, []);
        for (let i = 0; i < (to === "bottom" ? SCROLLS_MAX : 1); i++) {
            await send(tab, "Input.dispatchMouseEvent", { type: "mouseWheel", x: at.width / 2, y: at.height / 2, deltaX: 0, deltaY: Math.round(at.height * 0.85) });
            // what the scroll set off: the page moving, and a list loading more, which may
            // wait on the network; at the bottom, the page has to stay put a while to count
            const until = Date.now() + (to === "bottom" ? GROWTH_MS : 500);
            let now = at;
            while (Date.now() < until) {
                await new Promise((ok) => setTimeout(ok, 250));
                now = await inWorld(tab, scrolledTo, []);
                if (now.length !== at.length || (now.below > 0 && now.top !== at.top)) break;
            }
            const stuck = now.top === at.top && now.length === at.length;
            at = now;
            if (to === "bottom" && stuck) break;
        }
        return { top: at.top, below: at.below };
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
 * Whether the page's text held still for `STILL_MS`, within `ms`.
 *
 * @param {number} tab @param {number} ms
 */
async function stillness(tab, ms) {
    const until = Date.now() + ms;
    let last = "";
    let since = Date.now();
    while (Date.now() < until) {
        const now = await inWorld(tab, textNow, []).catch(() => "");
        if (now !== last) {
            last = now;
            since = Date.now();
        } else if (Date.now() - since >= STILL_MS) {
            return true;
        }
        await new Promise((ok) => setTimeout(ok, 250));
    }
    return false;
}

/** The page's text, as a short fingerprint. Runs in the page. */
function textNow() {
    const text = document.body?.innerText ?? "";
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
    return `${document.title}|${text.length}|${h}`;
}

/** Where the page is scrolled to, how much of it is below, and its
 *  size. Runs in the page. */
function scrolledTo() {
    const el = document.scrollingElement ?? document.documentElement;
    return {
        top: Math.round(el.scrollTop),
        below: Math.max(0, Math.round(el.scrollHeight - el.scrollTop - innerHeight)),
        length: el.scrollHeight,
        width: innerWidth,
        height: innerHeight,
    };
}

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
