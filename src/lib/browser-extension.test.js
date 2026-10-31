import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL } from "../../extension/src/protocol.js";
import { BrowserExtension, ExtensionError, ID_KEY, candidateIds } from "./browser-extension.svelte.js";

/**
 * `chrome.runtime` as a page has it, with extensions behind some ids: a
 * port to any other id closes at once, as Chrome's does.
 *
 * @param {Record<string, (op: string, args: any) => any>} extensions by id:
 *   an op's value, or `{ error }` to refuse it
 */
function fakeRuntime(extensions) {
    /** @type {{ id: string, op: string, args: any }[]} */
    const sent = [];
    /** @type {{ drop: () => void, send: (m: any) => void }[]} */
    const ports = [];
    const runtime = {
        sent,
        ports,
        connect(/** @type {string} */ id) {
            /** @type {((m: any) => void)[]} */
            const onMessage = [];
            /** @type {(() => void)[]} */
            const onDisconnect = [];
            let closed = false;
            const drop = () => {
                if (closed) return;
                closed = true;
                for (const f of onDisconnect) f();
            };
            const port = {
                onMessage: { addListener: (/** @type {any} */ f) => onMessage.push(f) },
                onDisconnect: { addListener: (/** @type {any} */ f) => onDisconnect.push(f) },
                postMessage(/** @type {any} */ { id: req, op, ...args }) {
                    if (closed) throw new Error("Attempting to use a disconnected port object");
                    if (!(id in extensions)) return; // nobody there: the port closes
                    sent.push({ id, op, args });
                    const answer = extensions[id](op, args);
                    queueMicrotask(() => {
                        for (const f of onMessage) f(answer?.error ? { id: req, error: answer.error } : { id: req, value: answer ?? null });
                    });
                },
                disconnect: drop,
            };
            // a message the extension sends unasked
            ports.push({ drop, send: (/** @type {any} */ m) => onMessage.forEach((f) => f(m)) });
            if (!(id in extensions)) queueMicrotask(drop);
            return /** @type {any} */ (port);
        },
    };
    return runtime;
}

/** An extension that greets as `version` and answers each op with its name. */
const answering = (version = "0.1.0") => (/** @type {string} */ op, /** @type {any} */ args) =>
    op === "hello" ? (args.protocol === PROTOCOL ? { protocol: PROTOCOL, version } : { error: { code: "protocol", message: "update the older one" } }) : { op };

describe("BrowserExtension", () => {
    it("is absent when no extension answers the page at all", async () => {
        const ext = new BrowserExtension({ runtime: undefined, ids: ["a"] });
        await ext.detect();
        expect(ext.status).toBe("absent");
        await expect(ext.call("ping")).rejects.toMatchObject({ code: "absent" });
    });

    it("tries each id until one answers, and says hello first", async () => {
        const runtime = fakeRuntime({ dev: answering("0.2.0") });
        const ext = new BrowserExtension({ runtime, ids: ["store", "dev"] });
        await ext.detect();
        expect(ext.status).toBe("found");
        expect(ext.version).toBe("0.2.0");
        expect(runtime.sent.map((s) => `${s.id}:${s.op}`)).toEqual(["dev:hello"]);
        expect(await ext.call("tabs", { session: "s" })).toEqual({ op: "tabs" });
    });

    it("goes on past an id Chrome won't take", async () => {
        const runtime = fakeRuntime({ dev: answering() });
        const connect = runtime.connect.bind(runtime);
        runtime.connect = (/** @type {string} */ id) => {
            if (id === "not an id") throw new Error("Invalid extension id: 'not an id'");
            return connect(id);
        };
        const ext = new BrowserExtension({ runtime, ids: ["not an id", "dev"] });
        await ext.detect();
        expect(ext.status).toBe("found");
    });

    it("is absent when no id answers", async () => {
        const ext = new BrowserExtension({ runtime: fakeRuntime({}), ids: ["store", "dev"] });
        await ext.detect();
        expect(ext.status).toBe("absent");
    });

    it("says an extension of another protocol is outdated", async () => {
        const ext = new BrowserExtension({ runtime: fakeRuntime({ dev: (op) => (op === "hello" ? { error: { code: "protocol", message: "the extension speaks protocol 2" } } : null) }), ids: ["dev"] });
        await ext.detect();
        expect(ext.status).toBe("outdated");
        expect(ext.problem).toMatch(/protocol 2/);
    });

    it("gives the extension's refusal as an ExtensionError with its code", async () => {
        const ext = new BrowserExtension({ runtime: fakeRuntime({ dev: (op) => (op === "hello" ? { protocol: PROTOCOL, version: "1" } : { error: { code: "not-granted", message: "no grant for x.com" } }) }), ids: ["dev"] });
        const err = await ext.call("open", { session: "s", url: "https://x.com/" }).catch((e) => e);
        expect(err).toBeInstanceOf(ExtensionError);
        expect(err.code).toBe("not-granted");
    });

    it("hands what the extension sends unasked to its listeners, apart from replies", async () => {
        const runtime = fakeRuntime({ dev: answering() });
        const ext = new BrowserExtension({ runtime, ids: ["dev"] });
        await ext.detect();
        /** @type {string[]} */
        const heard = [];
        const stop = ext.onEvent((e) => heard.push(e));
        runtime.ports[0].send({ event: "shares" });
        expect(await ext.call("ping")).toEqual({ op: "ping" });
        stop();
        runtime.ports[0].send({ event: "shares" });
        expect(heard).toEqual(["shares"]);
    });

    it("fails the calls waiting when the port drops, and opens it again for the next", async () => {
        const runtime = fakeRuntime({ dev: answering() });
        const ext = new BrowserExtension({ runtime, ids: ["dev"] });
        await ext.detect();
        runtime.ports[0].drop();
        expect(await ext.call("ping")).toEqual({ op: "ping" });
        expect(runtime.sent.filter((s) => s.op === "hello")).toHaveLength(2);
    });

    describe("held while turns run", () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });
        afterEach(() => {
            vi.useRealTimers();
        });

        it("says a turn runs on the first hold, pings meanwhile, and says it ended on the last let go", async () => {
            const runtime = fakeRuntime({ dev: answering() });
            const ext = new BrowserExtension({ runtime, ids: ["dev"], heartbeatMs: 1000 });
            await ext.detect();
            const first = ext.hold();
            const second = ext.hold();
            await vi.advanceTimersByTimeAsync(2500);
            first();
            first(); // a second letting go does nothing
            await vi.advanceTimersByTimeAsync(1000);
            second();
            await vi.advanceTimersByTimeAsync(3000);
            const ops = runtime.sent.map((s) => (s.op === "turn" ? `turn:${s.args.running}` : s.op));
            expect(ops).toEqual(["hello", "turn:true", "ping", "ping", "ping", "turn:false"]);
            expect(ext.held).toBe(false);
        });

        it("tells an extension found mid-turn that a turn runs", async () => {
            const runtime = fakeRuntime({ dev: answering() });
            const ext = new BrowserExtension({ runtime, ids: ["dev"], heartbeatMs: 1000 });
            const letGo = ext.hold();
            await vi.advanceTimersByTimeAsync(0);
            expect(runtime.sent.filter((s) => s.op === "turn").map((s) => s.args.running)).toContain(true);
            letGo();
        });

        it("does nothing with no extension", async () => {
            const ext = new BrowserExtension({ runtime: undefined, ids: ["dev"], heartbeatMs: 1000 });
            const letGo = ext.hold();
            await vi.advanceTimersByTimeAsync(5000);
            letGo();
            expect(ext.status).toBe("absent");
        });
    });
});

describe("candidateIds", () => {
    it("tries an id the person set first, then the dev build's", () => {
        const storage = /** @type {any} */ ({ getItem: (/** @type {string} */ k) => (k === ID_KEY ? "mine" : null) });
        expect(candidateIds(storage)).toEqual(["mine", "nmkolhlloohlmpklcknknipkaedblgbe"]);
        expect(candidateIds(undefined)).toEqual(["nmkolhlloohlmpklcknknipkaedblgbe"]);
    });
});
