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
        const session = await c.call("session", { session: "s1", name: "Hotels", origins: [GRANTED] });
        const opened = await c.call("open", { session: "s1", url: site("open") });
        const ungranted = await c.call("open", { session: "s1", url: `${OTHER}/test/page/site.html?id=refused` });
        const unknown = await c.call("open", { session: "nobody", url: site("refused") });
        const loaded = await tabWhere(c, "s1", (t) => t.title === "site open");
        await c.call("session", { session: "s2", name: "Other", origins: [GRANTED] });
        const elsewhere = await c.call("close", { session: "s2", tab: opened.value?.tab });
        const closed = await c.call("close", { session: "s1", tab: opened.value?.tab });
        const after = await c.call("tabs", { session: "s1" });
        c.port.disconnect();
        return { session, opened, ungranted, unknown, loaded, elsewhere, closed, after };
    },

    /** a page's own navigation, and a redirect, to an origin without a grant */
    async held() {
        const c = await greeted();
        await c.call("session", { session: "held", name: "Held", origins: [GRANTED] });
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
        await c.call("session", { session: "opener", name: "Opener", origins: [GRANTED] });
        const refused = await c.call("open", { session: "opener", url: site("opener-refused", { open: `${OTHER}/test/page/site.html?id=leak-open` }) });
        const allowed = await c.call("open", { session: "opener", url: site("opener-allowed", { open: site("opened", { go: `${OTHER}/test/page/site.html?id=leak-opened`, after: "500" }) }) });
        const source = await tabWhere(c, "opener", (t) => t.id === refused.value?.tab && t.blocked);
        const child = await tabWhere(c, "opener", (t) => t.blocked?.url.includes("id=leak-opened"));
        const list = await c.call("tabs", { session: "opener" });
        c.port.disconnect();
        // this page is the person's tab in front: the opened one went behind it
        const shown = document.visibilityState;
        return { refused, allowed, source, child, ids: list.value?.map((t) => t.id), shown };
    },

    /** a session's grants replaced, and its open tabs held to the new ones */
    async regrant() {
        const c = await greeted();
        await c.call("session", { session: "narrow", name: "Narrow", origins: [GRANTED] });
        await c.call("session", { session: "wide", name: "Wide", origins: [GRANTED] });
        const narrow = await c.call("open", { session: "narrow", url: site("narrow", { go: site("after-narrow"), after: "4000" }) });
        const wide = await c.call("open", { session: "wide", url: site("wide", { go: `${OTHER}/test/page/site.html?id=after-wide`, after: "4000" }) });
        await tabWhere(c, "narrow", (t) => t.title === "site narrow");
        await tabWhere(c, "wide", (t) => t.title === "site wide");
        await c.call("session", { session: "narrow", name: "Narrow", origins: [] });
        await c.call("session", { session: "wide", name: "Wide", origins: [GRANTED, OTHER] });
        const narrowed = await tabWhere(c, "narrow", (t) => t.id === narrow.value?.tab && t.blocked);
        const widened = await tabWhere(c, "wide", (t) => t.id === wide.value?.tab && t.title === "site after-wide");
        c.port.disconnect();
        return { narrowed, widened };
    },

    /** the registry and the rules outlive the worker's idle stop */
    async restart() {
        const c = await greeted();
        await c.call("session", { session: "kept", name: "Kept", origins: [GRANTED] });
        const opened = await c.call("open", { session: "kept", url: site("kept", { go: `${OTHER}/test/page/site.html?id=leak-kept`, after: "45000" }) });
        while (c.dropped === null && performance.now() - c.opened < 90_000) await sleep(500);
        const stoppedAfterMs = c.dropped === null ? null : Math.round(c.dropped - c.opened);
        const again = await greeted();
        const listed = (await again.call("tabs", { session: "kept" })).value?.map((t) => t.id);
        const blocked = await tabWhere(again, "kept", (t) => t.id === opened.value?.tab && t.blocked, 40_000);
        again.port.disconnect();
        return { tab: opened.value?.tab, stoppedAfterMs, listed, blocked };
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

// Two origins on the harness's one server: the tab tests grant the first.
const GRANTED = `http://127.0.0.1:${location.port}`;
const OTHER = `http://localhost:${location.port}`;

/** The fixture site on the granted origin. @param {string} id @param {Record<string, string>} [more] */
const site = (id, more = {}) => `${GRANTED}/test/page/site.html?${new URLSearchParams({ id, ...more })}`;

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
