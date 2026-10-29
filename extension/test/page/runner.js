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
};

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
