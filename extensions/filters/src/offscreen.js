/**
 * The offscreen document: the extension's page with no window, kept while
 * the agent works. An extension page can't eval, so the agent runs in
 * the sandboxed page it frames (`sandbox.js`); this page holds what the
 * sandbox can't: the store, on the extension's IndexedDB; the person's
 * settings and the model they name, whose requests it makes for the
 * sandbox (`host/provider.js`); and the extension's own files. It passes
 * the service worker's commands to the sandbox and the answers back.
 *
 * The settings are the studio's (`src/lib/settings.js`), kept in this
 * extension's `localStorage`, which its pages share.
 */

import { IndexedDB } from "@agex-ts/kvgit/backends/idb";
import { AiSdkProvider, ScriptedProvider } from "agex-ts";
import { buildModel, modelOf, thinkingOf, visionOf } from "../../../src/lib/model.js";
import { STORAGE_KEY, getSettings, reloadSettings } from "../../../src/lib/settings.js";
import { serveKv } from "./host/kv.js";
import { submittedPrompt } from "./host/prompts.js";
import { serveStream } from "./host/provider.js";

/** The IndexedDB database the agent's sessions live in. */
const STORE_DB = "agex-site-filters";
/** The extension's files the sandbox may be handed, as text. */
const ASSETS = ["kernel-worker.js"];

// made here, and framed only once this page listens for it (below): the
// sandbox says it's ready once, as soon as it has loaded
const frame = document.createElement("iframe");
frame.src = "sandbox.html";
const sandbox = () => /** @type {Window} */ (frame.contentWindow);

/** @type {Promise<import("@agex-ts/kvgit").KVStore> | null} */
let kv = null;

// the person saved settings on the extension's page: the next turn uses them
window.addEventListener("storage", (e) => {
    if (e.key === STORAGE_KEY) reloadSettings();
});

/** In the dev build, the replies a scripted model gives the next turn
 *  instead of the person's model (the tests'). @type {any[] | null} */
let script = null;
/** The provider the next request goes to. */
function provider() {
    if (__DEV__ && script !== null) return new ScriptedProvider(script);
    return new AiSdkProvider(buildModel(getSettings(), { session: "site-filters" }));
}
/** @type {import("agex-ts").Provider | null} */
let turnProvider = null;
/** The model's streams running, by id: each one's abort. @type {Map<string, () => void>} */
const streams = new Map();

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
    // a filter the agent presented: the worker keeps it as its site's candidate
    if (m?.event === "candidate") return void chrome.runtime.sendMessage({ event: "candidate", candidate: m.candidate });
    if (typeof m?.reply === "number") {
        const w = waiting.get(m.reply);
        waiting.delete(m.reply);
        if (m.error !== undefined) w?.no(new Error(m.error));
        else w?.ok(m.value);
        return;
    }
    if (typeof m?.id !== "string") return;
    try {
        if (m.stream !== undefined) {
            const abort = serveStream(/** @type {import("agex-ts").Provider} */ (turnProvider ?? provider()), m, (out) => {
                if (out.end || out.error) streams.delete(m.id);
                post(out);
            });
            streams.set(m.id, abort);
            return;
        }
        if (m.abort === true) {
            streams.get(m.id)?.();
            streams.delete(m.id);
            return;
        }
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
    if (msg.cmd === "submit") {
        // the page saved, then a turn on it, run here to its end: it can outlast what one
        // message keeps the service worker up for, so the worker hears when it's done
        const { site, capture, shot, steps } = /** @type {any} */ (msg);
        const saved = await ask({ cmd: "submit", site, capture, shot });
        const prompt = submittedPrompt({ site, page: saved.page, url: capture.url, title: capture.title, shot: typeof shot === "string" });
        command({ cmd: "turn", site, prompt, ...(__DEV__ && steps !== undefined && { steps }) }).then(
            (outcome) => chrome.runtime.sendMessage({ event: "turn-ended", site, outcome }),
            (e) => chrome.runtime.sendMessage({ event: "turn-ended", site, error: String(e?.message ?? e) }),
        );
        return saved;
    }
    if (msg.cmd === "turn") {
        // one at a time, so each turn's provider is its own for the whole turn
        const run = turns.then(() => {
            // the turn's model, as the settings name it now; in the dev build a script's instead
            if (__DEV__) script = Array.isArray(msg.steps) ? msg.steps : null;
            // read again now: a Save just before this turn may not have reached the storage event yet
            reloadSettings();
            turnProvider = provider();
            const s = getSettings();
            return ask({ ...msg, steps: undefined, model: __DEV__ && script !== null ? "scripted" : modelOf(s), thinking: thinkingOf(s), vision: visionOf(s) });
        });
        turns = run.then(() => {}, () => {});
        return run;
    }
    return ask(msg);
}

/** The turn running or last run, which the next waits for. */
let turns = Promise.resolve();

/**
 * Send the sandbox `msg`, and its answer.
 *
 * @param {Record<string, unknown> & { cmd: string }} msg
 */
async function ask(msg) {
    const reply = ++next;
    const answer = new Promise((ok, no) => waiting.set(reply, { ok, no }));
    post({ ...msg, reply });
    return answer;
}

document.body.append(frame);

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (msg?.target !== "offscreen" || sender.id !== chrome.runtime.id) return;
    command(msg).then((value) => reply({ value }), (e) => reply({ error: String(e?.message ?? e) }));
    return true;
});
