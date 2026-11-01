// The sandboxed page: listed under the manifest's `sandbox`, so it may
// eval, but its origin is opaque ("null") and it has no chrome.* APIs.
// It probes what it can do, then runs a scripted agex-ts turn whose
// run_ts calls go through the world's kernel in a worker, the store kept
// by the offscreen document over postMessage.

import { Agent, ScriptedProvider } from "agex-ts";
import { Store } from "@agex-ts/world";

// A module worker from a blob doesn't start in a page whose origin is
// opaque, and the world asks for one; the kernel's worker, bundled whole,
// runs as a classic one. (In agex-ts this would be an option of the
// world's, not a wrapped Worker.)
const NativeWorker = globalThis.Worker;
globalThis.Worker = class extends NativeWorker {
    constructor(url, opts) {
        super(url, String(url).startsWith("blob:") && opts?.type === "module" ? { ...opts, type: "classic" } : opts);
    }
};

let next = 0;
const waiting = new Map();

window.addEventListener("message", async (e) => {
    const m = e.data;
    if (m.id !== undefined && waiting.has(m.id)) {
        const { ok, no } = waiting.get(m.id);
        waiting.delete(m.id);
        if (m.error !== undefined) no(new Error(m.error));
        else ok(m.value);
        return;
    }
    if (m.cmd !== undefined) {
        const value = await (COMMANDS[m.cmd] ?? (() => ({ error: `no command ${m.cmd}` })))().catch((err) => ({ error: String(err?.stack ?? err) }));
        parent.postMessage({ reply: m.id, value }, "*");
    }
});

/** A request to the offscreen document. */
function ask(msg) {
    const id = `s${++next}`;
    return new Promise((ok, no) => {
        waiting.set(id, { ok, no });
        parent.postMessage({ ...msg, id }, "*");
    });
}

/** kvgit's KVStore, kept by the offscreen document's IndexedDB. */
class ParentKV {
    get(key) { return ask({ kv: "get", args: [key] }); }
    set(key, value) { return ask({ kv: "set", args: [key, value] }); }
    remove(key) { return ask({ kv: "remove", args: [key] }); }
    has(key) { return ask({ kv: "has", args: [key] }); }
    getMany(keys) { return ask({ kv: "getMany", args: [[...keys]] }); }
    setMany(items) { return ask({ kv: "setMany", args: [[...items]] }); }
    removeMany(keys) { return ask({ kv: "removeMany", args: [[...keys]] }); }
    cas(key, value, expected) { return ask({ kv: "cas", args: [key, value, expected] }); }
    casMany(expected, writes, removes) { return ask({ kv: "casMany", args: [expected, writes, removes === undefined ? undefined : [...removes]] }); }
    async *keys(prefix) { yield* await ask({ kv: "keys", args: [prefix] }); }
    async *items(prefix) { yield* await ask({ kv: "items", args: [prefix] }); }
    clear() { return ask({ kv: "clear", args: [] }); }
}

async function probe(f) {
    const started = performance.now();
    try {
        return { ok: true, value: await f(), ms: Math.round(performance.now() - started) };
    } catch (e) {
        return { ok: false, error: String(e?.message ?? e) };
    }
}

/** A worker from `source`, its first message back. */
function blobWorker(source, opts) {
    return new Promise((ok, no) => {
        const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
        const w = new NativeWorker(url, opts);
        const t = setTimeout(() => no(new Error("no message in 5s")), 5000);
        w.onmessage = (e) => { clearTimeout(t); w.terminate(); ok(e.data); };
        w.onerror = (e) => { clearTimeout(t); no(new Error(e.message || "worker error")); };
    });
}

let workerUrl = null;
async function kernelWorker() {
    workerUrl ??= URL.createObjectURL(new Blob([await ask({ asset: "worker.js" })], { type: "text/javascript" }));
    return workerUrl;
}

const step = (text, calls = []) => ({ kind: "model", text, thinking: "", tool_calls: calls, fail: "", input_tokens: 0 });

const COMMANDS = {
    async probes() {
        return {
            origin: location.origin,
            newFunction: await probe(() => new Function("return 1 + 1")()),
            indexedDB: await probe(() => new Promise((ok, no) => {
                const r = indexedDB.open("x");
                r.onsuccess = () => ok("opened");
                r.onerror = () => no(r.error);
            })),
            chromeApis: typeof globalThis.chrome?.runtime?.sendMessage,
            classicBlobWorker: await probe(() => blobWorker("postMessage(1 + 1)")),
            moduleBlobWorker: await probe(() => blobWorker("const x = await Promise.resolve(2); postMessage(x)", { type: "module" })),
            evalInWorker: await probe(() => blobWorker("postMessage(new Function('return 40 + 2')())", { type: "module" })),
            classicEvalImport: await probe(() => blobWorker("new Function('u', 'return import(u)')('https://esm.sh/lodash-es@4.17.21/kebabCase').then((m) => postMessage(m.default('from a classic worker')), (e) => postMessage('failed: ' + e))")),
            esmImport: await probe(async () => (await import(/* @vite-ignore */ "https://esm.sh/lodash-es@4.17.21/camelCase")).default("hello sandboxed world")),
            // a model request as a provider sends one (a POST with a key, so a preflight), with a key that isn't one
            modelRequest: await probe(async () => {
                const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Authorization: "Bearer sk-or-v1-not-a-key" },
                    body: JSON.stringify({ model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }),
                });
                return { status: r.status, body: (await r.text()).slice(0, 120) };
            }),
            fetchModels: await probe(async () => {
                const r = await fetch("https://openrouter.ai/api/v1/models");
                return { status: r.status, models: (await r.json()).data?.length };
            }),
        };
    },

    /** A scripted turn: two run_ts calls (one plain, one importing from esm.sh), then a reply. */
    async agent() {
        const started = performance.now();
        const store = await Store.open(new ParentKV());
        const profile = {
            code: { worker: { target: "browser", url: await kernelWorker() }, resolve: (name) => `https://esm.sh/${name}` },
        };
        const ws = await store.open("spike", { profile });
        const before = ws.head;
        const agent = new Agent({
            model: new ScriptedProvider([
                step("", [{ name: "run_ts", args: { code: "const xs: number[] = [1, 2, 3, 4]\nconsole.log('sum', xs.reduce((a, b) => a + b, 0))\nawait fs.write('notes.txt', 'written from a sandboxed extension page')" } }]),
                step("", [{ name: "run_ts", args: { code: "import camelCase from 'lodash-es/camelCase'\nconsole.log(camelCase('ads begone from this page'))" } }]),
                step("Done."),
            ]),
        });
        const session = agent.session(ws);
        const events = [];
        for await (const ev of session.stream("try the kernel")) {
            if (ev.kind === "ToolEnded") events.push({ tool: ev.name, isError: ev.isError, result: String(ev.result).slice(0, 400) });
            else if (ev.kind === "RunEnded" || ev.kind === "RunFailed") events.push({ kind: ev.kind, ...(ev.error && { error: String(ev.error) }) });
        }
        // read back through a store opened afresh: what the offscreen document kept
        const again = await Store.open(new ParentKV());
        const reopened = await again.open("spike", { profile });
        const notes = await reopened.files.readText("notes.txt").catch((e) => `unread: ${e}`);
        const runs = await new Agent({ model: new ScriptedProvider([]) }).session(reopened).runs();
        return {
            ms: Math.round(performance.now() - started),
            runs: runs.length,
            headMoved: before !== ws.head,
            sessions: await again.sessions(),
            notes,
            events,
        };
    },
};
