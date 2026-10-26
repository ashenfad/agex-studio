import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BURST_MS, MODEL_TASK, RATE, emptyMeter, loadMeter, saveMeter } from "./app-meter.js";
import { needsAsk } from "./app-needs-ask.svelte.js";
import { AppModelError, appAgent, checkModelCall, checkSpec, modelSettings } from "./app-tasks.svelte.js";
import { vault } from "./vault.svelte.js";

/** Who a session's app is: from elsewhere (`ask`), a bundle's; else the
 *  person's own. @param {string} session @param {boolean} [ask] */
const appKey = (session, ask = false) => (ask ? `bundle:${session}` : `session:${session}`);

describe("an app's task spec", () => {
    it("takes a name, instructions, and JSON Schemas", () => {
        const spec = { name: "summarize", instructions: "Summarize it.", params: { text: { type: "string" } }, returns: { type: "string" } };
        expect(checkSpec(spec)).toBe(spec);
        expect(checkSpec({ name: "go", instructions: "Do it." })).toMatchObject({ name: "go" });
    });

    it("refuses what isn't one, naming what is wrong", () => {
        expect(() => checkSpec("summarize")).toThrow("give it { name, instructions, params, returns }");
        expect(() => checkSpec({ name: "two words", instructions: "x" })).toThrow("name is an identifier");
        expect(() => checkSpec({ name: "t", instructions: " " })).toThrow("agex.task t: say what to do");
        expect(() => checkSpec({ name: "t", instructions: "x", params: ["text"] })).toThrow("params map each input");
        expect(() => checkSpec({ name: "t", instructions: "x", params: { text: "string" } })).toThrow("params.text is a JSON Schema");
        expect(() => checkSpec({ name: "t", instructions: "x", returns: "string" })).toThrow("returns is a JSON Schema");
    });
});

const { usage, FakeAgent, gate, script } = vi.hoisted(() => {
    /** The provider a model call runs on, when a test sets one.
     *  @type {{ provider: any }} */
    const script = { provider: null };
    /** What a task given `hold` waits on before its model call. */
    const gate = { open: () => {}, wait: Promise.resolve() };
    const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 60, cacheWriteTokens: 0 };
    /** An agent whose task makes one model call, then answers (or
     *  fails, given `fail`); given `hold`, it waits on `gate` first. */
    class FakeAgent {
        /** @param {{ model: any }} opts */
        constructor(opts) {
            this.model = opts.model;
        }
        task() {
            return async (/** @type {any} */ inputs) => {
                if (inputs.hold) await gate.wait;
                for await (const _ of this.model.stream([], [], {})) void _;
                if (inputs.fail) throw new Error("the task failed: boom");
                return "done";
            };
        }
    }
    return { usage, FakeAgent, gate, script };
});

vi.mock("agex-ts", async (importOriginal) => ({ ...(await importOriginal()), Agent: FakeAgent }));
vi.mock("./settings.js", async (importOriginal) => {
    const real = /** @type {any} */ (await importOriginal());
    return { ...real, getSettings: () => ({ ...real.DEFAULTS, accessMode: "scripted" }), isConfigured: () => true };
});
vi.mock("./scripted.js", async (importOriginal) => ({
    ...(await importOriginal()),
    scriptedNow: () => script.provider ?? ({
        name: "fake",
        async *stream() {
            yield { kind: "Reply", message: { role: "assistant", parts: [], usage } };
        },
        transient: () => false,
    }),
}));

describe("an app's agent calls", () => {
    let now = 1_000_000;
    beforeEach(() => {
        const items = new Map();
        vi.stubGlobal("localStorage", {
            getItem: (/** @type {string} */ k) => items.get(k) ?? null,
            setItem: (/** @type {string} */ k, /** @type {string} */ v) => items.set(k, String(v)),
            removeItem: (/** @type {string} */ k) => items.delete(k),
        });
        vi.spyOn(Date, "now").mockImplementation(() => now);
    });
    afterEach(() => vi.restoreAllMocks());

    const spec = { name: "summarize", instructions: "Summarize it." };
    /** @param {string} session @param {object} [inputs] @param {{ ask?: boolean, prompt?: boolean }} [opts] */
    const call = (session, inputs = {}, opts = {}) => appAgent.call(session, { spec, inputs }, { ask: false, appKey: appKey(session, opts.ask), ...opts });
    /** Calls `n` times, a second apart. @param {string} session @param {number} n */
    async function calls(session, n) {
        for (let i = 0; i < n; i++) {
            await call(session);
            now += 1000;
        }
    }
    const settle = () => new Promise((r) => setTimeout(r, 0));

    it("are metered: each one's model calls, tokens and how it ended, kept for the session", async () => {
        expect(appAgent.meterOf("m1")).toBeNull();
        expect(await call("m1")).toBe("done");
        await expect(call("m1", { fail: true })).rejects.toThrow("boom");
        const m = appAgent.meterOf("m1");
        expect(m).toMatchObject({ calls: 2, failed: 1, steps: 2, inputTokens: 200, outputTokens: 40, cacheReadTokens: 120, limiter: true });
        expect(m?.recent.map((c) => [c.task, c.ok, c.steps, c.error ?? null])).toEqual([
            ["summarize", false, 1, "the task failed: boom"],
            ["summarize", true, 1, null],
        ]);
        expect(loadMeter("m1")).toEqual(m);
    });

    it("pause past the rate until the person says to go on, then count the minute afresh", async () => {
        await calls("r1", RATE.calls);
        const held = call("r1");
        await settle();
        expect(appAgent.paused.r1?.calls).toBe(RATE.calls);
        const also = call("r1");
        await settle();
        appAgent.goOn("r1");
        await expect(held).resolves.toBe("done");
        await expect(also).resolves.toBe("done");
        expect(appAgent.paused.r1).toBeUndefined();
        expect(appAgent.meterOf("r1")?.calls).toBe(RATE.calls + 2);
    });

    it("are refused once the person stops them, until they let them go on", async () => {
        await calls("r2", RATE.calls);
        const held = call("r2");
        await settle();
        appAgent.paused.r2?.answer(false);
        await expect(held).rejects.toThrow("the person stopped this app's agent calls");
        await expect(call("r2")).rejects.toThrow("stopped");
        appAgent.goOn("r2");
        await expect(call("r2")).resolves.toBe("done");
    });

    it("are refused rather than paused when nobody is looking (a hidden test)", async () => {
        await calls("r3", RATE.calls);
        await expect(call("r3", {}, { prompt: false })).rejects.toThrow(`made ${RATE.calls} agent calls inside a minute`);
        expect(appAgent.paused.r3).toBeUndefined();
    });

    it("go through past the rate with the limiter off, or once the minute has passed", async () => {
        appAgent.setLimiter("r4", false);
        await calls("r4", RATE.calls + 3);
        expect(appAgent.meterOf("r4")?.calls).toBe(RATE.calls + 3);
        await calls("r5", RATE.calls);
        now += RATE.windowMs;
        await expect(call("r5")).resolves.toBe("done");
    });

    it("count from zero after a reset, the limiter kept as it was", async () => {
        appAgent.setLimiter("r6", false);
        await calls("r6", 3);
        now += 5000;
        appAgent.reset("r6");
        expect(appAgent.meterOf("r6")).toMatchObject({ since: now, calls: 0, steps: 0, inputTokens: 0, recent: [], limiter: false });
    });

    it("from elsewhere wait for the person's say, and are refused if they say no", async () => {
        const first = call("a1", {}, { ask: true });
        await settle();
        expect(needsAsk.asking.a1).toMatchObject({ appKey: "bundle:a1", model: true, own: false });
        needsAsk.answer("a1", null);
        await expect(first).rejects.toThrow("didn't allow");
        await expect(call("a1", {}, { ask: true })).rejects.toThrow("didn't allow");
        await expect(call("a2", {}, { ask: true, prompt: false })).rejects.toThrow("hasn't allowed this app");
    });

    it("add to what another tab on the session counted, rather than writing over it", async () => {
        await call("t1");
        saveMeter("t1", { ...emptyMeter(now), calls: 5, steps: 7, inputTokens: 1000 });
        await call("t1");
        expect(appAgent.meterOf("t1")).toMatchObject({ calls: 6, steps: 8, inputTokens: 1100 });
    });

    it("from elsewhere go on once allowed, and aren't asked again", async () => {
        const first = call("a3", {}, { ask: true });
        await settle();
        needsAsk.answer("a3", {});
        await expect(first).resolves.toBe("done");
        expect(vault.modelAllowed("bundle:a3")).toBe(true);
        await expect(call("a3", {}, { ask: true, prompt: false })).resolves.toBe("done");
    });

    it("waiting on the person are refused when the session is deleted", async () => {
        const asking = call("a4", {}, { ask: true });
        await settle();
        appAgent.forget("a4");
        await expect(asking).rejects.toThrow("session was deleted");
        expect(needsAsk.asking.a4).toBeUndefined();
    });

    it("leave nothing of a session that is deleted: its meter, a paused call, one running", async () => {
        await calls("g1", RATE.calls);
        const held = call("g1");
        await settle();
        appAgent.forget("g1");
        await expect(held).rejects.toThrow("session was deleted");
        expect(appAgent.meterOf("g1")).toBeNull();
        expect(appAgent.stopped.g1).toBeUndefined();
        expect(appAgent.paused.g1).toBeUndefined();

        gate.wait = new Promise((r) => (gate.open = () => r(undefined)));
        const running = call("g2", { hold: true });
        await settle();
        appAgent.forget("g2");
        gate.open();
        await expect(running).resolves.toBe("done");
        expect(appAgent.meterOf("g2")).toBeNull();
        expect(loadMeter("g2")).toBeNull();
    });
});

describe("an app's own agent's model call", () => {
    const messages = [{ id: "m1", role: "user", parts: [{ kind: "text", text: "hi" }] }];

    it("takes agex-ts messages, tool specs and settings, and refuses what isn't", () => {
        const tools = [{ name: "look", description: "Look.", parameters: { type: "object" } }];
        expect(checkModelCall({ messages, tools, settings: undefined })).toEqual({ messages, tools, settings: {} });
        expect(() => checkModelCall({ messages: [], tools: [], settings: {} })).toThrow("non-empty list");
        expect(() => checkModelCall({ messages: [{ role: "user" }], tools: [], settings: {} })).toThrow("agex-ts Message");
        expect(() => checkModelCall({ messages, tools: {}, settings: {} })).toThrow("tools is a list");
        expect(() => checkModelCall({ messages, tools: [{ name: "x" }], settings: {} })).toThrow("parameters a JSON Schema");
        expect(() => checkModelCall({ messages, tools: [], settings: "fast" })).toThrow("settings is an object");
    });

    it("goes with the viewer's thinking, its token cap within the studio's, and no provider-specific settings", () => {
        const s = /** @type {any} */ ({ thinking: "high" });
        expect(modelSettings({ maxTokens: 500, temperature: 0.2, thinking: false, extra: { openrouter: { models: ["x"] } } }, s)).toEqual({
            maxTokens: 500,
            temperature: 0.2,
            thinking: "high",
        });
        expect(modelSettings({ maxTokens: 1e9 }, /** @type {any} */ ({ thinking: "off" }))).toEqual({ maxTokens: 16_000, thinking: false });
        expect(modelSettings({}, s).maxTokens).toBe(8000);
    });

    let now = 5_000_000;
    beforeEach(() => {
        const items = new Map();
        vi.stubGlobal("localStorage", {
            getItem: (/** @type {string} */ k) => items.get(k) ?? null,
            setItem: (/** @type {string} */ k, /** @type {string} */ v) => items.set(k, String(v)),
            removeItem: (/** @type {string} */ k) => items.delete(k),
        });
        vi.spyOn(Date, "now").mockImplementation(() => now);
        script.provider = null;
    });
    afterEach(() => {
        vi.restoreAllMocks();
        script.provider = null;
    });

    /** A provider that streams a delta then a reply; given `hold`, it
     *  waits for its signal to abort in between. @param {{ hold?: boolean, fail?: unknown }} [opts] */
    const provider = ({ hold = false, fail } = {}) => ({
        name: "fake",
        /** @type {any[]} */
        asked: [],
        /** @param {any} messages @param {any} tools @param {any} settings @param {{ signal?: AbortSignal }} opts */
        async *stream(messages, tools, settings, opts) {
            this.asked.push({ messages, tools, settings });
            yield { kind: "TextDelta", text: "he" };
            if (hold) {
                await new Promise((_, reject) => opts.signal?.addEventListener("abort", () => reject(opts.signal?.reason)));
            }
            if (fail !== undefined) throw fail;
            yield { kind: "Reply", message: { id: "r", role: "assistant", parts: [{ kind: "text", text: "hello" }], usage } };
        },
        /** @param {any} e */
        transient: (e) => e?.status === 529,
        /** @param {any} e */
        describe: (e) => (e?.status ? `the model provider failed (${e.status})` : null),
    });
    /** @param {string} session @param {{ ask?: boolean, prompt?: boolean, signal?: AbortSignal }} [opts] */
    async function model(session, opts = {}) {
        /** @type {any[]} */
        const events = [];
        await appAgent.model(session, { messages, tools: [], settings: { maxTokens: 100 } }, { ask: false, appKey: appKey(session, opts.ask), ...opts, onEvent: (e) => events.push(e) });
        return events;
    }
    const settle = () => new Promise((r) => setTimeout(r, 0));

    it("streams the provider's events, its usage on the meter, the calls listed in bursts", async () => {
        const p = provider();
        script.provider = p;
        expect((await model("x1")).map((e) => e.kind)).toEqual(["TextDelta", "Reply"]);
        expect(p.asked[0]).toMatchObject({ messages, tools: [], settings: { maxTokens: 100 } });
        now += 2000;
        await model("x1");
        let m = appAgent.meterOf("x1");
        expect(m).toMatchObject({ calls: 1, failed: 0, steps: 2, inputTokens: 200, outputTokens: 40, cacheReadTokens: 120 });
        expect(m?.recent).toEqual([{ task: MODEL_TASK, model: true, at: 5_000_000, ms: 2000, ok: true, steps: 2, inputTokens: 200, outputTokens: 40 }]);
        now += BURST_MS;
        await model("x1");
        m = appAgent.meterOf("x1");
        expect(m?.calls).toBe(2);
        expect(m?.recent.map((c) => c.steps)).toEqual([1, 2]);
    });

    it("carry the viewer's provider's judgment of a failure", async () => {
        script.provider = provider({ fail: Object.assign(new Error("overloaded"), { status: 529 }) });
        const e = await model("x2").catch((err) => err);
        expect(e).toBeInstanceOf(AppModelError);
        expect(e).toMatchObject({ message: "overloaded", transient: true, description: "the model provider failed (529)" });
        expect(appAgent.meterOf("x2")).toMatchObject({ calls: 1, failed: 1, steps: 0 });
        expect(appAgent.meterOf("x2")?.recent[0]).toMatchObject({ ok: false, error: "overloaded" });
    });

    it("stop when the app aborts, which isn't a failure", async () => {
        script.provider = provider({ hold: true });
        const stop = new AbortController();
        const running = model("x3", { signal: stop.signal });
        await settle();
        expect(appAgent.modelCalls("x3")).toBe(1);
        stop.abort();
        await expect(running).rejects.toBeInstanceOf(AppModelError);
        expect(appAgent.modelCalls("x3")).toBe(0);
        expect(appAgent.meterOf("x3")).toMatchObject({ calls: 1, failed: 0, steps: 0 });
    });

    it("pause past their own rate, apart from task calls, and are refused there when nobody is looking", async () => {
        script.provider = provider();
        for (let i = 0; i < RATE.modelCalls; i++) {
            await model("x4");
            now += 100;
        }
        // task calls count on their own
        await expect(appAgent.call("x4", { spec: { name: "t", instructions: "Do it." }, inputs: {} }, { ask: false, appKey: appKey("x4") })).resolves.toBe("done");
        await expect(model("x4", { prompt: false })).rejects.toThrow(`made ${RATE.modelCalls} model calls (agex.model) inside a minute`);
        const held = model("x4");
        await settle();
        expect(appAgent.paused.x4).toMatchObject({ calls: RATE.modelCalls, model: true });
        appAgent.goOn("x4");
        await expect(held).resolves.toHaveLength(2);
    });

    it("started together count against the rate one by one", async () => {
        script.provider = provider();
        const results = await Promise.allSettled(Array.from({ length: RATE.modelCalls + 2 }, () => model("x9", { prompt: false })));
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(RATE.modelCalls);
        expect(results.filter((r) => r.status === "rejected").map((r) => /** @type {any} */ (r).reason.message)).toEqual([
            expect.stringContaining(`made ${RATE.modelCalls} model calls`),
            expect.stringContaining(`made ${RATE.modelCalls} model calls`),
        ]);
        const tasks = await Promise.allSettled(
            Array.from({ length: RATE.calls + 1 }, () => appAgent.call("x9", { spec: { name: "t", instructions: "Do it." }, inputs: {} }, { ask: false, appKey: appKey("x9"), prompt: false })),
        );
        expect(tasks.filter((r) => r.status === "rejected")).toHaveLength(1);
    });

    it("held together by a pause each count in the new minute once it goes on", async () => {
        script.provider = provider();
        for (let i = 0; i < RATE.modelCalls; i++) await model("x10");
        const held = Promise.all([model("x10"), model("x10"), model("x10")]);
        await settle();
        appAgent.goOn("x10");
        await held;
        for (let i = 0; i < RATE.modelCalls - 3; i++) await model("x10", { prompt: false });
        await expect(model("x10", { prompt: false })).rejects.toThrow(`made ${RATE.modelCalls} model calls`);
    });

    it("from elsewhere ask first, for the app's own agent, and are refused if the person says no", async () => {
        script.provider = provider();
        await expect(model("x5", { ask: true, prompt: false })).rejects.toThrow("hasn't allowed this app");
        const first = model("x5", { ask: true });
        await settle();
        expect(needsAsk.asking.x5?.model).toBe(true);
        needsAsk.answer("x5", null);
        await expect(first).rejects.toThrow("didn't allow");
        expect(appAgent.meterOf("x5")).toBeNull();
    });

    it("stop waiting on the person when the app aborts, the question taken back once no call waits", async () => {
        script.provider = provider();
        const one = new AbortController();
        const two = new AbortController();
        const first = model("x7", { ask: true, signal: one.signal });
        const second = model("x7", { ask: true, signal: two.signal });
        await settle();
        one.abort(new Error("gone one"));
        await expect(first).rejects.toThrow("gone one");
        expect(needsAsk.asking.x7?.model).toBe(true);
        two.abort(new Error("gone two"));
        await expect(second).rejects.toThrow("gone two");
        expect(needsAsk.asking.x7).toBeUndefined();
        expect(vault.modelAllowed("bundle:x7")).toBe(false);
        // the next call asks afresh
        const third = model("x7", { ask: true });
        await settle();
        needsAsk.answer("x7", {});
        await expect(third).resolves.toHaveLength(2);

        for (let i = 0; i < RATE.modelCalls; i++) {
            await model("x8");
            now += 100;
        }
        const paused = new AbortController();
        const waiting = model("x8", { signal: paused.signal });
        await settle();
        expect(appAgent.paused.x8).toBeDefined();
        paused.abort(new Error("closed"));
        await expect(waiting).rejects.toThrow("closed");
        expect(appAgent.paused.x8).toBeUndefined();
        expect(appAgent.stopped.x8).toBeUndefined();
    });

    it("are stopped when the session is deleted, writing nothing after", async () => {
        script.provider = provider({ hold: true });
        const running = model("x6");
        await settle();
        appAgent.forget("x6");
        await expect(running).rejects.toThrow("session was deleted");
        expect(appAgent.modelCalls("x6")).toBe(0);
        expect(loadMeter("x6")).toBeNull();
    });
});
