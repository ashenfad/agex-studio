// Plays the studio for the end-to-end tests: opens the port to the
// extension, runs each scenario named in `?scenarios=`, in order, and
// posts each one's report to the harness.

import { HEARTBEAT_MS, PROTOCOL } from "../../src/protocol.js";

const params = new URLSearchParams(location.search);
const ext = params.get("ext") ?? "";
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const post = (name, report) => fetch("/report", { method: "POST", body: JSON.stringify({ name, report }) });

/** A port with request/reply over it, and when it dropped. */
function connect() {
    const port = chrome.runtime.connect(ext);
    let next = 0;
    const waiting = new Map();
    const conn = { dropped: /** @type {number | null} */ (null), opened: performance.now() };
    port.onMessage.addListener((m) => {
        waiting.get(m.id)?.(m);
        waiting.delete(m.id);
    });
    port.onDisconnect.addListener(() => {
        conn.dropped = performance.now();
        for (const done of waiting.values()) done({ error: { code: "disconnected" } });
        waiting.clear();
    });
    /** @param {string} op @param {Record<string, unknown>} [args] */
    const call = (op, args = {}) =>
        new Promise((ok) => {
            const id = ++next;
            waiting.set(id, ok);
            port.postMessage({ id, op, ...args });
        });
    return Object.assign(conn, { call, port });
}

const SCENARIOS = {
    /** whether this page can reach any extension at all */
    async reachable() {
        return { connect: typeof globalThis.chrome?.runtime?.connect === "function" };
    },

    /** hello, then a ping */
    async hello() {
        const c = connect();
        const hello = await c.call("hello", { protocol: PROTOCOL });
        const ping = await c.call("ping");
        c.port.disconnect();
        return { hello, ping };
    },

    /** an op before hello, an unknown op, and another protocol's hello */
    async refusals() {
        const c = connect();
        const early = await c.call("ping");
        await c.call("hello", { protocol: PROTOCOL });
        const unknown = await c.call("teleport");
        c.port.disconnect();
        const d = connect();
        const wrong = await d.call("hello", { protocol: PROTOCOL + 1 });
        await sleep(200);
        return { early, unknown, wrong, wrongClosed: d.dropped !== null };
    },

    /** a port left quiet drops when the worker stops; a new one works */
    async idle() {
        const c = connect();
        await c.call("hello", { protocol: PROTOCOL });
        const limit = 90_000;
        while (c.dropped === null && performance.now() - c.opened < limit) await sleep(500);
        const again = connect();
        const hello = await again.call("hello", { protocol: PROTOCOL });
        again.port.disconnect();
        return { droppedAfterMs: c.dropped === null ? null : Math.round(c.dropped - c.opened), reconnected: hello };
    },

    /** a port pinged every HEARTBEAT_MS stays up past the idle limit */
    async heartbeat() {
        const c = connect();
        await c.call("hello", { protocol: PROTOCOL });
        const span = Number(params.get("heartbeatSpan") ?? 65_000);
        let pings = 0;
        while (c.dropped === null && performance.now() - c.opened < span) {
            await sleep(HEARTBEAT_MS);
            if (c.dropped === null && (await c.call("ping")).value) pings++;
        }
        const up = c.dropped === null;
        c.port.disconnect();
        return { up, pings, spanMs: span };
    },

    /** open, list and close a session's tabs, and the refusals on the way */
    async tabs() {
        const c = await greeted();
        const session = await c.call("session", { session: "s1", name: "Hotels", domains: [GRANTED_DOMAIN] });
        const opened = await c.call("open", { session: "s1", url: site("open") });
        const ungranted = await c.call("open", { session: "s1", url: `${OTHER}/test/page/site.html?id=refused` });
        const unknown = await c.call("open", { session: "nobody", url: site("refused") });
        const loaded = await tabWhere(c, "s1", (t) => t.title === "site open");
        await c.call("session", { session: "s2", name: "Other", domains: [GRANTED_DOMAIN] });
        const elsewhere = await c.call("close", { session: "s2", tab: opened.value?.tab });
        const closed = await c.call("close", { session: "s1", tab: opened.value?.tab });
        const after = await c.call("tabs", { session: "s1" });
        c.port.disconnect();
        return { session, opened, ungranted, unknown, loaded, elsewhere, closed, after };
    },

    /** a page's own navigation, and a redirect, to an origin without a grant */
    async held() {
        const c = await greeted();
        await c.call("session", { session: "held", name: "Held", domains: [GRANTED_DOMAIN] });
        const go = await c.call("open", { session: "held", url: site("go", { go: `${OTHER}/test/page/site.html?id=leak-go` }) });
        const redirect = await c.call("open", { session: "held", url: `${GRANTED}/redirect?to=${encodeURIComponent(`${OTHER}/test/page/site.html?id=leak-redirect`)}` });
        const wentBlocked = await tabWhere(c, "held", (t) => t.id === go.value?.tab && t.blocked);
        const redirectBlocked = await tabWhere(c, "held", (t) => t.id === redirect.value?.tab && t.blocked);
        c.port.disconnect();
        return { wentBlocked, redirectBlocked };
    },

    /** tabs a page opens: to a granted origin the session's, elsewhere closed */
    async opened() {
        const c = await greeted();
        await c.call("session", { session: "opener", name: "Opener", domains: [GRANTED_DOMAIN] });
        const refused = await c.call("open", { session: "opener", url: site("opener-refused", { open: `${OTHER}/test/page/site.html?id=leak-open` }) });
        const allowed = await c.call("open", { session: "opener", url: site("opener-allowed", { open: site("opened", { go: `${OTHER}/test/page/site.html?id=leak-opened`, after: "500" }) }) });
        // sent on at once by a redirect, before its rules can be in place
        const raced = await c.call("open", { session: "opener", url: site("opener-raced", { open: `${GRANTED}/redirect?to=${encodeURIComponent(`${OTHER}/test/page/site.html?id=leak-raced`)}` }) });
        const source = await tabWhere(c, "opener", (t) => t.id === refused.value?.tab && t.blocked);
        const child = await tabWhere(c, "opener", (t) => t.blocked?.url.includes("id=leak-opened"));
        const racedSource = await tabWhere(c, "opener", (t) => t.id === raced.value?.tab && t.blocked);
        await sleep(1000);
        const list = await c.call("tabs", { session: "opener" });
        c.port.disconnect();
        // this page is the person's tab in front: the opened one went behind it
        const shown = document.visibilityState;
        return { refused, allowed, raced, source, child, racedSource, tabs: list.value, shown };
    },

    /** a popup window a page opens, which takes no tab group */
    async popup() {
        const c = await greeted();
        await c.call("session", { session: "popup", name: "Popup", domains: [GRANTED_DOMAIN] });
        await c.call("open", { session: "popup", url: site("popup-opener", { open: site("popup"), popup: "1" }) });
        const popup = await tabWhere(c, "popup", (t) => t.title === "site popup");
        c.port.disconnect();
        return { popup };
    },

    /** a session's grants replaced, and its open tabs held to the new ones */
    async regrant() {
        const c = await greeted();
        await c.call("session", { session: "narrow", name: "Narrow", domains: [GRANTED_DOMAIN] });
        await c.call("session", { session: "wide", name: "Wide", domains: [GRANTED_DOMAIN] });
        const narrow = await c.call("open", { session: "narrow", url: site("narrow", { go: site("after-narrow"), after: "4000" }) });
        const wide = await c.call("open", { session: "wide", url: site("wide", { go: `${OTHER}/test/page/site.html?id=after-wide`, after: "4000" }) });
        await tabWhere(c, "narrow", (t) => t.title === "site narrow");
        await tabWhere(c, "wide", (t) => t.title === "site wide");
        await c.call("session", { session: "narrow", name: "Narrow", domains: [] });
        await c.call("session", { session: "wide", name: "Wide", domains: [GRANTED_DOMAIN, OTHER_DOMAIN] });
        const narrowed = await tabWhere(c, "narrow", (t) => t.id === narrow.value?.tab && t.blocked);
        const widened = await tabWhere(c, "wide", (t) => t.id === wide.value?.tab && t.title === "site after-wide");
        c.port.disconnect();
        return { narrowed, widened };
    },

    /** the registry and the rules outlive the worker's idle stop */
    async restart() {
        const c = await greeted();
        await c.call("session", { session: "kept", name: "Kept", domains: [GRANTED_DOMAIN] });
        const opened = await c.call("open", { session: "kept", url: site("kept", { go: `${OTHER}/test/page/site.html?id=leak-kept`, after: "45000" }) });
        while (c.dropped === null && performance.now() - c.opened < 90_000) await sleep(500);
        const stoppedAfterMs = c.dropped === null ? null : Math.round(c.dropped - c.opened);
        const again = await greeted();
        const listed = (await again.call("tabs", { session: "kept" })).value?.map((t) => t.id);
        const blocked = await tabWhere(again, "kept", (t) => t.id === opened.value?.tab && t.blocked, 40_000);
        again.port.disconnect();
        return { tab: opened.value?.tab, stoppedAfterMs, listed, blocked };
    },

    /** a page read, waited on, sent on and shot */
    async pages() {
        const c = await greeted();
        await c.call("turn", { running: true });
        await c.call("session", { session: "pages", name: "Pages", domains: [GRANTED_DOMAIN] });
        const { value: { tab } } = await c.call("open", { session: "pages", url: `${GRANTED}/test/page/hotel.html` });
        const at = { session: "pages", tab };
        // two calls at once in a tab not yet worked in
        const [first, together] = await Promise.all([c.call("read", at), c.call("screenshot", at)]);
        const second = await c.call("read", { ...at, maxChars: 200 });
        const working = (await c.call("tabs", { session: "pages" })).value?.[0]?.working;
        const rates = await c.call("waitFor", { ...at, text: "Rates loaded" });
        const never = await c.call("waitFor", { ...at, selector: "#nope", timeout: 500 });
        const badSelector = await c.call("waitFor", { ...at, selector: "[[" });
        const shot = await c.call("screenshot", at);
        const went = await c.call("goto", { ...at, url: site("went") });
        const ungranted = await c.call("goto", { ...at, url: `${OTHER}/test/page/site.html?id=leak-goto` });
        const redirected = await c.call("goto", { ...at, url: `${GRANTED}/redirect?to=${encodeURIComponent(`${OTHER}/test/page/site.html?id=leak-goto-redirect`)}` });
        const afterBlock = await c.call("read", at);
        await c.call("turn", { running: false });
        const rested = (await c.call("tabs", { session: "pages" })).value?.[0]?.working;
        const other = await c.call("read", { session: "nobody", tab });
        c.port.disconnect();
        return {
            first, together: together.error ?? together.value?.mime, second, working, rates, never, badSelector, went, ungranted, redirected, afterBlock, rested, other,
            shot: shot.error ?? { mime: shot.value?.mime, bytes: shot.value?.data?.length },
        };
    },

    /** clicks, typing and choices, by the refs of an outline */
    async actions() {
        const c = await greeted();
        await c.call("turn", { running: true });
        await c.call("session", { session: "act", name: "Act", domains: [GRANTED_DOMAIN] });
        const { value: { tab } } = await c.call("open", { session: "act", url: `${GRANTED}/test/page/form.html` });
        const at = { session: "act", tab };
        const first = (await c.call("read", at)).value;
        const on = (outline, label) => ({ ...at, version: outline.version, ref: refOf(outline.text, label) });
        const r = {
            photos: await c.call("click", on(first, "Show photos")),
            reserve: await c.call("click", on(first, "Reserve")),
            reserveConfirmed: await c.call("click", { ...on(first, "Reserve"), confirmed: true }),
            pay: await c.call("type", { ...on(first, "Card name"), text: "A. Person", submit: true }),
            notes: await c.call("type", { ...on(first, "Notes"), text: "hello" }),
            notesMore: await c.call("type", { ...on(first, "Notes"), text: " there", clear: false }),
            notesCleared: await c.call("type", { ...on(first, "Notes"), text: "" }),
            guests: await c.call("select", { ...on(first, "Guests"), value: "2" }),
            noOption: await c.call("select", { ...on(first, "Guests"), value: "9" }),
            disabledOption: await c.call("select", { ...on(first, "Guests"), value: "3" }),
            disabledGroup: await c.call("select", { ...on(first, "Guests"), value: "10" }),
            iconDelete: await c.call("click", on(first, "Delete")),
            labelledDelete: await c.call("click", on(first, "Delete booking")),
            nights: await c.call("type", { ...on(first, "Nights"), text: "4", clear: false }),
            covered: await c.call("click", on(first, "Under the banner")),
            refresh: await c.call("click", on(first, "Refresh list")),
            refreshAgain: await c.call("click", on(first, "Refresh list")),
        };
        const second = (await c.call("read", at)).value;
        r.out = /Out: (.*)$/m.exec(second.text)?.[1];
        r.olderOutline = await c.call("click", on(first, "Show photos"));
        r.search = await c.call("type", { ...on(second, "Where"), text: "Lisbon", submit: true });
        r.otherPage = await c.call("click", on(second, "Show photos"));
        const third = (await c.call("read", at)).value;
        r.away = await c.call("click", on(third, "Elsewhere"));
        await c.call("turn", { running: false });
        c.port.disconnect();
        return r;
    },

    /** two studio tabs' turns at once: one ending rests nothing the other works in */
    async twoTurns() {
        const a = await greeted();
        const b = await greeted();
        await a.call("turn", { running: true });
        await b.call("turn", { running: true });
        await b.call("session", { session: "two", name: "Two", domains: [GRANTED_DOMAIN] });
        const { value: { tab } } = await b.call("open", { session: "two", url: site("two") });
        await b.call("read", { session: "two", tab });
        await a.call("turn", { running: false });
        const afterOne = (await b.call("tabs", { session: "two" })).value?.[0]?.working;
        // a studio tab closed mid-turn has ended its turn
        await a.call("turn", { running: true });
        b.port.disconnect();
        await sleep(200);
        const c = await greeted();
        const stillOne = (await c.call("tabs", { session: "two" })).value?.[0]?.working;
        await a.call("turn", { running: false });
        const afterAll = (await c.call("tabs", { session: "two" })).value?.[0]?.working;
        a.port.disconnect();
        c.port.disconnect();
        return { afterOne, stillOne, afterAll };
    },

    /** pages that are a CAPTCHA or a bot check */
    async blockers() {
        const c = await greeted();
        await c.call("session", { session: "blockers", name: "Blockers", domains: [GRANTED_DOMAIN] });
        const read = async (page) => {
            const { value } = await c.call("open", { session: "blockers", url: `${GRANTED}/test/page/${page}` });
            return (await c.call("read", { session: "blockers", tab: value.tab })).value?.blocker;
        };
        const report = { captcha: await read("captcha.html"), checking: await read("checking.html"), hotel: await read("hotel.html") };
        await c.call("turn", { running: false });
        c.port.disconnect();
        return report;
    },

    /** a grant for a domain covers its subdomains, and only them */
    async subdomains() {
        const c = await greeted();
        const sub = `http://hotels.localhost:${location.port}/test/page/site.html?id=sub`;
        await c.call("session", { session: "wide-domain", name: "Domain", domains: ["localhost"] });
        await c.call("session", { session: "narrow-domain", name: "IP", domains: [GRANTED_DOMAIN] });
        const opened = await c.call("open", { session: "wide-domain", url: sub });
        const loaded = await tabWhere(c, "wide-domain", (t) => t.title === "site sub");
        const refused = await c.call("open", { session: "narrow-domain", url: sub.replace("id=sub", "id=sub-refused") });
        const notDomain = await c.call("session", { session: "x", name: "X", domains: ["https://marriott.com"] });
        const topLevel = await c.call("session", { session: "x", name: "X", domains: ["com"] });
        const known = (await c.call("sessions")).value?.find((s) => s.session === "wide-domain");
        c.port.disconnect();
        return { opened, loaded, refused, notDomain, topLevel, known };
    },

    /** the studio's tab kept from discarding while a turn runs */
    async turn() {
        const c = await greeted();
        const running = await c.call("turn", { running: true });
        const done = await c.call("turn", { running: false });
        c.port.disconnect();
        return { running, done };
    },
};

// Two domains on the harness's one server: the tab tests grant the first.
const GRANTED_DOMAIN = "127.0.0.1";
const OTHER_DOMAIN = "localhost";
const GRANTED = `http://${GRANTED_DOMAIN}:${location.port}`;
const OTHER = `http://${OTHER_DOMAIN}:${location.port}`;

/** The fixture site on the granted origin. @param {string} id @param {Record<string, string>} [more] */
const site = (id, more = {}) => `${GRANTED}/test/page/site.html?${new URLSearchParams({ id, ...more })}`;

/** The ref an outline gives the control labelled `label`. */
function refOf(text, label) {
    const m = new RegExp(`\\[(\\d+)\\] [^\\n\\[]*?"${label}"`).exec(text);
    return m ? Number(m[1]) : -1;
}

async function greeted() {
    const c = connect();
    await c.call("hello", { protocol: PROTOCOL });
    return c;
}

/** The first of a session's tabs that `test` takes, polled for up to 15 s, or null. */
async function tabWhere(c, session, test, ms = 15_000) {
    const until = performance.now() + ms;
    while (performance.now() < until) {
        const found = (await c.call("tabs", { session })).value?.find(test);
        if (found) return found;
        await sleep(100);
    }
    return null;
}

const names = (params.get("scenarios") ?? "").split(",").filter(Boolean);
for (const name of names) {
    let report;
    try {
        report = await SCENARIOS[name]();
    } catch (e) {
        report = { failed: String(e?.message ?? e) };
    }
    await post(name, report);
}
