/**
 * The sandboxed page, where the agent runs. Listed under the manifest's
 * `sandbox`, it is the one page of the extension's that may eval, which
 * agex-ts's kernel needs; in exchange its origin is opaque and it has no
 * `chrome.*`. So it keeps nothing itself: its store is the offscreen
 * document's (`host/kv.js`), and so is everything else it needs from
 * outside, the model included (`host/provider.js`: the key never comes
 * here). Its CSP allows no connections, so neither it nor the agent's
 * code can send anything anywhere.
 *
 * Each site has a session (`host/sessions.js`), and one turn runs at a
 * time across all of them.
 *
 * It answers only the offscreen document, its parent.
 */

import { Agent, ScriptedProvider } from "agex-ts";
import { Store } from "@agex-ts/world";
import { remoteKv } from "./host/kv.js";
import { runLog } from "./host/log.js";
import { remoteProvider } from "./host/provider.js";
import { sessionOf, siteOf } from "./host/sessions.js";
import { presentFilterTool, siteHost } from "./host/site-tools.js";
import { classicBlobWorkers, workerUrl } from "./host/worker.js";
import SKILL from "./skills/site-filters.md";

/** The most tool calls one turn may make. */
const TOOL_CALLS = 40;
/** The most tokens one model reply may take. */
const MAX_TOKENS = 16_000;
/** The most pages a site keeps, the latest: a filter has to hold up on each. */
const PAGES_KEPT = 8;

classicBlobWorkers();

/** The parent's origin: the extension's own, which this page's URL names
 *  though its origin is opaque. */
const PARENT = new URL(location.href).origin;

let next = 0;
/** @type {Map<string, { ok: (v: any) => void, no: (e: Error) => void }>} */
const waiting = new Map();
/** The model's streams, by id: each one's messages back. @type {Map<string, (msg: any) => void>} */
const streams = new Map();
/** How the model's stand-in reaches the offscreen document. */
const channel = {
    /** @param {Record<string, unknown>} msg */
    send: (msg) => parent.postMessage(msg, PARENT),
    /** @param {string} id @param {(msg: any) => void} f */
    listen: (id, f) => {
        streams.set(id, f);
        return () => void streams.delete(id);
    },
    nextId: () => `m${++next}`,
};

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
 *  worker (a bare import has nowhere to load from), `site` looks at the
 *  site's saved pages, and the skill says how to write its filter. */
async function profile() {
    kernel ??= ask({ asset: "kernel-worker.js" }).then(workerUrl);
    return {
        code: { worker: { target: /** @type {const} */ ("browser"), url: await kernel } },
        hostObjects: { site: siteHost() },
        skills: [SKILL],
    };
}

/** @type {Map<string, Promise<import("@agex-ts/world").Workspace>>} */
const open = new Map();
/** Site `site`'s workspace, opened once (and made, the first time).
 *  @param {string} site */
function workspace(site) {
    const name = sessionOf(site);
    if (!open.has(name)) open.set(name, (async () => (await store()).open(name, { profile: await profile() }))());
    return /** @type {Promise<import("@agex-ts/world").Workspace>} */ (open.get(name));
}

/** A data URL's bytes. @param {string} url */
function dataUrlBytes(url) {
    const b64 = url.slice(url.indexOf(",") + 1);
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** The turn running or last run: the next waits for it, whatever its site. */
let turns = Promise.resolve();

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
    /** The sites that have a session. */
    sites: async () => (await (await store()).sessions()).map(siteOf).filter((site) => site !== null),
    /** How many runs site `site`'s session has had. */
    runs: async ({ site }) => (await new Agent({ model: new ScriptedProvider([]) }).session(await workspace(site)).runs()).length,
    /** Site `site`'s runs, newest first: what each did (`host/log.js`). */
    log: async ({ site }) => runLog(await workspace(site)),
    /** A file of site `site`'s session, as text. */
    read: async ({ site, path }) => (await workspace(site)).files.readText(path),
    /** A turn of site `site`'s session on `prompt`, once the turn before it
     *  (any site's) has ended; `model` names the model, `thinking` is its
     *  effort and `vision` whether it takes images, from the person's
     *  settings. */
    /** A page the person submitted, saved as site `site`'s next page
     *  (`pages/<n>.json`, and its screenshot `pages/<n>.jpg`), only the
     *  latest `PAGES_KEPT` kept; after any turn running, so a page never
     *  lands mid-turn. `shot`: a JPEG's data URL, or null. */
    submit: ({ site, capture, shot }) => {
        const run = turns.then(async () => {
            const ws = await workspace(site);
            const had = (await ws.files.exists("pages")) ? await ws.files.list("pages") : [];
            const numbers = had.flatMap((name) => (/^\d+\.json$/.test(name) ? [Number.parseInt(name, 10)] : [])).sort((a, b) => a - b);
            const n = (numbers.at(-1) ?? 0) + 1;
            await ws.files.write(`pages/${n}.json`, JSON.stringify(capture));
            if (typeof shot === "string") await ws.files.write(`pages/${n}.jpg`, dataUrlBytes(shot));
            for (const old of numbers.slice(0, Math.max(0, numbers.length + 1 - PAGES_KEPT))) {
                for (const path of [`pages/${old}.json`, `pages/${old}.jpg`]) if (await ws.files.exists(path)) await ws.files.remove(path);
            }
            return { page: `pages/${n}` };
        });
        turns = run.then(() => {}, () => {});
        return run;
    },
    /** Site `site`'s session deleted, its pages and filters with it, once
     *  the turn before has ended. */
    forget: ({ site }) => {
        const run = turns.then(async () => {
            const name = sessionOf(site);
            open.delete(name);
            if (await (await store()).exists(name)) await (await store()).delete(name);
            return null;
        });
        turns = run.then(() => {}, () => {});
        return run;
    },
    turn: ({ site, prompt, model, thinking, vision }) => {
        const run = turns.then(async () => {
            const agent = new Agent({
                model: remoteProvider(model, channel),
                settings: { maxTokens: MAX_TOKENS, ...(thinking !== undefined && { thinking }) },
                maxToolCalls: TOOL_CALLS,
            });
            const ws = await workspace(site);
            // a filter the agent presents goes to the extension, which keeps it for the person
            const present = (/** @type {unknown} */ candidate) => parent.postMessage({ event: "candidate", candidate }, PARENT);
            // a page's screenshot is the agent's to look at when its model takes images
            const toolOptions = { vision: vision === true };
            return outcome(await agent.session(ws, { tools: [presentFilterTool(ws, present)], toolOptions }).say(prompt));
        });
        turns = run.then(() => {}, () => {});
        return run;
    },
};

window.addEventListener("message", async (e) => {
    if (e.source !== parent) return;
    const m = e.data;
    if (typeof m?.id === "string" && streams.has(m.id)) return /** @type {(msg: any) => void} */ (streams.get(m.id))(m);
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
