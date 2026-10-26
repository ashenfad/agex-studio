import { beforeEach, describe, expect, it, vi } from "vitest";
import { BURST_MS, MODEL_TASK, RATE, RECENT, addCall, addModelCall, addReply, emptyMeter, loadMeter, metered, overRate, removeMeter, saveMeter } from "./app-meter.js";

// an in-memory localStorage: Node's own global (Node 22+) has none of
// the methods without a backing file
beforeEach(() => {
    const items = new Map();
    vi.stubGlobal("localStorage", {
        getItem: (/** @type {string} */ k) => items.get(k) ?? null,
        setItem: (/** @type {string} */ k, /** @type {string} */ v) => items.set(k, String(v)),
        removeItem: (/** @type {string} */ k) => items.delete(k),
    });
});

const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 60, cacheWriteTokens: 5 };
/** @param {Partial<import("./app-meter.js").MeterCall>} [over] */
const call = (over = {}) => ({ task: "summarize", at: 1, ms: 900, ok: true, steps: 2, inputTokens: 200, outputTokens: 40, ...over });

describe("the app agent's meter", () => {
    it("adds each reply's tokens and each call, the last few listed newest first", () => {
        let m = addReply(addReply(emptyMeter(5), usage), usage);
        expect(m).toMatchObject({ since: 5, steps: 2, inputTokens: 200, outputTokens: 40, cacheReadTokens: 120, cacheWriteTokens: 10, calls: 0 });
        m = addCall(m, call({ ok: false, error: "boom" }));
        for (let i = 0; i < RECENT + 2; i++) m = addCall(m, call({ at: 100 + i }));
        expect(m.calls).toBe(RECENT + 3);
        expect(m.failed).toBe(1);
        expect(m.recent).toHaveLength(RECENT);
        expect(m.recent[0]?.at).toBe(100 + RECENT + 1);
    });

    it("keeps a session's meter on this device, and forgets it", () => {
        const m = addCall(emptyMeter(5, false), call());
        saveMeter("s1", m);
        expect(loadMeter("s1")).toEqual(m);
        expect(loadMeter("s2")).toBeNull();
        removeMeter("s1");
        expect(loadMeter("s1")).toBeNull();
    });

    it("reads a meter it can't make sense of as none", () => {
        localStorage.setItem("agex-studio-meter:s1", "{not json");
        localStorage.setItem("agex-studio-meter:s2", JSON.stringify({ calls: "many" }));
        expect(loadMeter("s1")).toBeNull();
        expect(loadMeter("s2")).toBeNull();
    });

    it("breaks the rate with more than its calls inside the window", () => {
        const now = 1_000_000;
        const starts = Array.from({ length: RATE.calls }, (_, i) => now - i * 1000);
        expect(overRate(starts, now)).toBe(true);
        expect(overRate(starts.slice(1), now)).toBe(false);
        // the oldest past the window no longer counts
        expect(overRate([...starts.slice(1), now - RATE.windowMs], now)).toBe(false);
        // model calls break theirs, a higher one
        expect(overRate(starts, now, RATE.modelCalls)).toBe(false);
        expect(overRate(Array.from({ length: RATE.modelCalls }, (_, i) => now - i * 100), now, RATE.modelCalls)).toBe(true);
    });

    it("lists the app's own agent's model calls in bursts, each burst a call", () => {
        const model = (/** @type {Partial<import("./app-meter.js").MeterCall>} */ over = {}) => ({ at: 0, ms: 1000, ok: true, steps: 1, inputTokens: 100, outputTokens: 10, ...over });
        let m = addModelCall(emptyMeter(0), model());
        m = addModelCall(m, model({ at: 1000 + BURST_MS - 1, ok: false, steps: 0, error: "overloaded" }));
        m = addModelCall(m, model({ at: 2000 + BURST_MS, ms: 500 }));
        expect(m).toMatchObject({ calls: 1, failed: 1 });
        expect(m.recent).toEqual([
            { task: MODEL_TASK, model: true, at: 0, ms: 2500 + BURST_MS, ok: false, steps: 2, inputTokens: 300, outputTokens: 30, error: "overloaded" },
        ]);
        // a pause past the burst's gap starts another; a task call in between does too
        m = addModelCall(m, model({ at: 2500 + 2 * BURST_MS }));
        m = addCall(m, call({ at: 3600 + 2 * BURST_MS }));
        m = addModelCall(m, model({ at: 3700 + 2 * BURST_MS }));
        expect(m.calls).toBe(4);
        expect(m.failed).toBe(1);
        expect(m.recent.map((c) => [c.task, c.ok])).toEqual([[MODEL_TASK, true], ["summarize", true], [MODEL_TASK, true], [MODEL_TASK, false]]);
    });
});

describe("metered", () => {
    it("passes the stream through, reporting each reply's usage", async () => {
        const reply = { kind: "Reply", message: { role: "assistant", parts: [], usage } };
        const provider = /** @type {any} */ ({
            name: "fake",
            async *stream() {
                yield { kind: "TextDelta", text: "hi" };
                yield reply;
                yield { kind: "Reply", message: { role: "assistant", parts: [] } };
            },
            transient: (/** @type {unknown} */ e) => e === "busy",
        });
        const seen = /** @type {unknown[]} */ ([]);
        const wrapped = metered(provider, (u) => seen.push(u));
        const events = [];
        for await (const e of wrapped.stream([], [], {})) events.push(e);
        expect(events.map((e) => e.kind)).toEqual(["TextDelta", "Reply", "Reply"]);
        expect(seen).toEqual([usage, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }]);
        expect(wrapped.name).toBe("fake");
        expect(wrapped.transient("busy")).toBe(true);
        expect(wrapped.describe).toBeUndefined();
    });
});
