/**
 * The offscreen document: the extension's page with no window, kept while
 * the agent works. An extension page can't eval, so the agent runs in
 * the sandboxed page it frames (`sandbox.js`); this page holds what the
 * sandbox can't: the store, on the extension's IndexedDB, and the
 * extension's own files. It passes the service worker's commands to the
 * sandbox and the answers back.
 */

import { IndexedDB } from "@agex-ts/kvgit/backends/idb";
import { serveKv } from "./host/kv.js";

/** The IndexedDB database the agent's sessions live in. */
const STORE_DB = "agex-site-filters";
/** The extension's files the sandbox may be handed, as text. */
const ASSETS = ["kernel-worker.js"];

const frame = /** @type {HTMLIFrameElement} */ (document.getElementById("sandbox"));
const sandbox = () => /** @type {Window} */ (frame.contentWindow);

/** @type {Promise<import("@agex-ts/kvgit").KVStore> | null} */
let kv = null;

let next = 0;
/** @type {Map<number, { ok: (v: any) => void, no: (e: Error) => void }>} */
const waiting = new Map();
/** @type {() => void} */
let isReady = () => {};
const ready = new Promise((ok) => (isReady = () => ok(undefined)));

/**
 * Tell the sandbox `msg`. Its origin is opaque, so no target origin names
 * it; the frame is this page's own, and a sandboxed page can't navigate
 * itself away.
 *
 * @param {Record<string, unknown>} msg
 */
const post = (msg) => sandbox().postMessage(msg, "*");

window.addEventListener("message", async (e) => {
    if (e.source !== sandbox()) return;
    const m = e.data;
    if (m?.ready === true) return isReady();
    if (typeof m?.reply === "number") {
        const w = waiting.get(m.reply);
        waiting.delete(m.reply);
        if (m.error !== undefined) w?.no(new Error(m.error));
        else w?.ok(m.value);
        return;
    }
    if (typeof m?.id !== "string") return;
    try {
        if (m.kv !== undefined) {
            kv ??= IndexedDB.open({ dbName: STORE_DB });
            return post({ id: m.id, value: await serveKv(await kv, m) });
        }
        if (m.asset !== undefined) {
            if (!ASSETS.includes(m.asset)) throw new Error(`no asset ${m.asset}`);
            return post({ id: m.id, value: await (await fetch(m.asset)).text() });
        }
        throw new Error("an unknown request");
    } catch (err) {
        post({ id: m.id, error: String(/** @type {Error} */ (err)?.message ?? err) });
    }
});

/**
 * A command for the sandbox, and its answer.
 *
 * @param {Record<string, unknown> & { cmd: string }} msg
 */
async function command(msg) {
    await ready;
    const reply = ++next;
    const answer = new Promise((ok, no) => waiting.set(reply, { ok, no }));
    post({ ...msg, reply });
    return answer;
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg?.target !== "offscreen" || sender.id !== chrome.runtime.id) return;
    command(msg).then((value) => reply({ value }), (e) => reply({ error: String(e?.message ?? e) }));
    return true;
});
