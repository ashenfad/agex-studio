// The offscreen document: an extension page (its CSP forbids eval), so
// it probes what it can do itself, holds the store for the sandboxed
// page (IndexedDB on the extension's origin, reached over postMessage),
// and relays the service worker's probes to the sandbox.

import { IndexedDB } from "@agex-ts/kvgit/backends/idb";

const frame = /** @type {HTMLIFrameElement} */ (document.getElementById("sandbox"));
const ready = new Promise((ok) => frame.addEventListener("load", ok, { once: true }));
let kv = null;
let next = 0;
const waiting = new Map();

async function collect(iter) {
    const out = [];
    for await (const x of iter) out.push(x);
    return out;
}

window.addEventListener("message", async (e) => {
    if (e.source !== frame.contentWindow) return;
    const m = e.data;
    if (m.reply !== undefined) {
        waiting.get(m.reply)?.(m.value);
        waiting.delete(m.reply);
        return;
    }
    if (m.kv !== undefined) {
        // the sandbox's store, kept here
        try {
            kv ??= await IndexedDB.open({ dbName: "spike-store" });
            const value = m.kv === "keys" || m.kv === "items" ? await collect(kv[m.kv](...m.args)) : await kv[m.kv](...m.args);
            frame.contentWindow.postMessage({ id: m.id, value }, "*");
        } catch (err) {
            frame.contentWindow.postMessage({ id: m.id, error: String(err) }, "*");
        }
        return;
    }
    if (m.asset !== undefined) {
        // a file of the extension's, as text: the sandbox (origin "null") is handed it
        const text = await (await fetch(m.asset)).text();
        frame.contentWindow.postMessage({ id: m.id, value: text }, "*");
    }
});

async function sandbox(what) {
    await ready;
    const id = ++next;
    const done = new Promise((ok) => waiting.set(id, ok));
    frame.contentWindow.postMessage({ cmd: what, id }, "*");
    return done;
}

async function probe(f) {
    const started = performance.now();
    try {
        return { ok: true, value: await f(), ms: Math.round(performance.now() - started) };
    } catch (e) {
        return { ok: false, error: String(e?.message ?? e) };
    }
}

async function here() {
    return {
        origin: location.origin,
        newFunction: await probe(() => new Function("return 1 + 1")()),
        indexedDB: await probe(async () => {
            const k = await IndexedDB.open({ dbName: "spike-probe" });
            await k.set("x", new Uint8Array([1, 2, 3]));
            return [...(await k.get("x"))];
        }),
        fetchModels: await probe(async () => {
            const r = await fetch("https://openrouter.ai/api/v1/models");
            return { status: r.status, models: (await r.json()).data?.length };
        }),
    };
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.to !== "offscreen") return;
    (async () => {
        if (msg.what === "here") return here();
        return sandbox(msg.what);
    })().then(reply, (e) => reply({ error: String(e) }));
    return true;
});
