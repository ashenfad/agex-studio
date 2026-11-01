/**
 * The sandboxed page, where the agent runs. Listed under the manifest's
 * `sandbox`, it is the one page of the extension's that may eval, which
 * agex-ts's kernel needs; in exchange its origin is opaque and it has no
 * `chrome.*`. So it keeps nothing itself: its store is the offscreen
 * document's (`host/kv.js`), and so is everything else it needs from
 * outside. Its CSP allows no connections, so neither it nor the agent's
 * code can send anything anywhere.
 *
 * It answers only the offscreen document, its parent.
 */

import { Agent, ScriptedProvider } from "agex-ts";
import { Store } from "@agex-ts/world";
import { remoteKv } from "./host/kv.js";
import { classicBlobWorkers, workerUrl } from "./host/worker.js";

classicBlobWorkers();

/** The parent's origin: the extension's own, which this page's URL names
 *  though its origin is opaque. */
const PARENT = new URL(location.href).origin;

let next = 0;
/** @type {Map<string, { ok: (v: any) => void, no: (e: Error) => void }>} */
const waiting = new Map();

/**
 * A request to the offscreen document, and its answer.
 *
 * @param {Record<string, unknown>} msg
 * @returns {Promise<any>}
 */
function ask(msg) {
    const id = `s${++next}`;
    return new Promise((ok, no) => {
        waiting.set(id, { ok, no });
        parent.postMessage({ ...msg, id }, PARENT);
    });
}

/** @type {Promise<Store> | null} */
let opening = null;
/** The store, opened once. */
function store() {
    opening ??= Store.open(remoteKv(ask));
    return opening;
}

/** @type {Promise<string> | null} */
let kernel = null;
/** What every session's world is opened with: code runs in the kernel's
 *  worker, and a bare import has nowhere to load from. */
async function profile() {
    kernel ??= ask({ asset: "kernel-worker.js" }).then(workerUrl);
    return { code: { worker: { target: /** @type {const} */ ("browser"), url: await kernel } } };
}

/** @type {Map<string, Promise<import("@agex-ts/world").Workspace>>} */
const open = new Map();
/** Session `name`'s workspace, opened once (and made, the first time).
 *  @param {string} name */
function workspace(name) {
    if (!open.has(name)) open.set(name, (async () => (await store()).open(name, { profile: await profile() }))());
    return /** @type {Promise<import("@agex-ts/world").Workspace>} */ (open.get(name));
}

/**
 * A turn's outcome, as the extension's pages are told it.
 *
 * @param {Awaited<ReturnType<import("agex-ts").Session["say"]>>} out
 */
function outcome(out) {
    return {
        status: out.status,
        text: out.text,
        head: out.head,
        tools: out.events.flatMap((e) => (e.kind === "ToolEnded" ? [{ name: e.name, isError: e.isError, result: String(e.result) }] : [])),
    };
}

/** What the offscreen document may ask, by `cmd`.
 *  @type {Record<string, (msg: any) => Promise<unknown>>} */
const COMMANDS = {
    /** The sessions in the store. */
    sessions: async () => (await store()).sessions(),
    /** How many runs session `session` has had. */
    runs: async ({ session }) => (await new Agent({ model: new ScriptedProvider([]) }).session(await workspace(session)).runs()).length,
    /** A file of session `session`'s, as text. */
    read: async ({ session, path }) => (await workspace(session)).files.readText(path),
};

if (__DEV__) {
    /** A turn on a scripted model (the tests'): `steps` are its replies. */
    COMMANDS.scripted = async ({ session, prompt, steps }) => {
        const agent = new Agent({ model: new ScriptedProvider(steps) });
        return outcome(await agent.session(await workspace(session)).say(prompt));
    };
}

window.addEventListener("message", async (e) => {
    if (e.source !== parent) return;
    const m = e.data;
    if (typeof m?.id === "string" && waiting.has(m.id)) {
        const { ok, no } = /** @type {{ ok: (v: any) => void, no: (e: Error) => void }} */ (waiting.get(m.id));
        waiting.delete(m.id);
        if (m.error !== undefined) no(new Error(m.error));
        else ok(m.value);
        return;
    }
    if (typeof m?.cmd !== "string") return;
    const command = Object.hasOwn(COMMANDS, m.cmd) ? COMMANDS[m.cmd] : undefined;
    try {
        if (command === undefined) throw new Error(`no command ${m.cmd}`);
        parent.postMessage({ reply: m.reply, value: await command(m) }, PARENT);
    } catch (err) {
        parent.postMessage({ reply: m.reply, error: String(/** @type {Error} */ (err)?.message ?? err) }, PARENT);
    }
});

parent.postMessage({ ready: true }, PARENT);
