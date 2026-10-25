import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RATE, emptyMeter, loadMeter, saveMeter } from "./app-meter.js";
import { appAgent, checkSpec } from "./app-tasks.svelte.js";

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

const { usage, FakeAgent, gate } = vi.hoisted(() => {
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
    return { usage, FakeAgent, gate };
});

vi.mock("agex-ts", async (importOriginal) => ({ ...(await importOriginal()), Agent: FakeAgent }));
vi.mock("./settings.js", async (importOriginal) => {
    const real = /** @type {any} */ (await importOriginal());
    return { ...real, getSettings: () => ({ ...real.DEFAULTS, accessMode: "scripted" }), isConfigured: () => true };
});
vi.mock("./scripted.js", async (importOriginal) => ({
    ...(await importOriginal()),
    scriptedNow: () => ({
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
    const call = (session, inputs = {}, opts = {}) => appAgent.call(session, { spec, inputs }, { ask: false, ...opts });
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
        expect(appAgent.asking.a1?.task).toBe("summarize");
        appAgent.asking.a1?.answer(false);
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
