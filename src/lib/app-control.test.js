/**
 * Tests for the `_enforceTotalCap` final-size backstop in
 * `app-control.js collectResults`. Per-entry caps (in
 * `iframe-bridge.js` + the console interceptor) already limit
 * individual logs / eval values to ~50 KB; this guard is what
 * keeps a session emitting hundreds of capped logs from still
 * blowing past the next turn's prompt budget.
 *
 * Pure helper, no DOM / iframe involved.
 */

import { describe, expect, it, vi } from "vitest";

import {
    _attachBridges,
    _enforceTotalCap,
    bootFailure,
    callStarted,
    callsLost,
    capResults,
    executeActions,
    resolveViewport,
    runLiveApp,
    waitForIdle,
} from "./app-control.js";
import { APPS_ORIGIN } from "./apps-origin.js";
import { pageGone, sendControl } from "./send-control.js";

vi.mock("./send-control.js", () => ({ sendControl: vi.fn(), pageGone: vi.fn() }));

/** Build N entries with `kind`-shaped payloads summing to ~targetBytes. */
function makeLogs(n, perEntryBytes) {
    const payload = "x".repeat(perEntryBytes);
    return Array.from({ length: n }, (_, i) => ({
        type: "log",
        level: "log",
        message: `${i}:${payload}`,
    }));
}

describe("_enforceTotalCap", () => {
    it("passes entries through unchanged when under the cap", () => {
        const entries = makeLogs(3, 1_000);
        const out = _enforceTotalCap(entries, 100_000);
        expect(out).toBe(entries); // same reference — no copy
    });

    it("drops the earliest entries until the total fits", () => {
        // 10 entries × ~10 KB each = ~100 KB total. Cap at 30 KB
        // should leave the last ~3 entries (most recent first).
        const entries = makeLogs(10, 10_000);
        const out = _enforceTotalCap(entries, 30_000);
        // First entry should be the truncation notice marker.
        expect(out[0].type).toBe("log");
        expect(out[0].level).toBe("warn");
        expect(out[0].message).toMatch(/^\[truncated: dropped \d+ earliest/);
        // Remaining real entries should be the tail — verify the
        // last one is preserved (highest index).
        const lastReal = out[out.length - 1];
        expect(lastReal.message.startsWith("9:")).toBe(true);
    });

    it("preserves action-result entries by trimming logs first", () => {
        // The real-world ordering: collectResults concatenates
        // [...logs, ...actionResults], so logs come first.
        // Dropping from the front naturally keeps action results
        // (which is what the agent most cared about).
        const logs = makeLogs(10, 8_000); // type:'log' bloat
        const actions = Array.from({ length: 3 }, (_, i) => ({
            type: "eval",
            expr: `eval-${i}`,
            value: `"result-${i}"`,
        }));
        const out = _enforceTotalCap([...logs, ...actions], 20_000);
        // All 3 action entries should survive.
        const actionsRemaining = out.filter((e) => e.type === "eval");
        expect(actionsRemaining).toHaveLength(3);
        expect(actionsRemaining.map((e) => e.expr)).toEqual([
            "eval-0",
            "eval-1",
            "eval-2",
        ]);
    });

    it("names the dropped-count in the synthetic truncation entry", () => {
        const entries = makeLogs(20, 10_000); // 200 KB total
        const out = _enforceTotalCap(entries, 50_000); // keep ~5
        const match = out[0].message.match(/^\[truncated: dropped (\d+) earliest/);
        expect(match).not.toBeNull();
        const dropped = parseInt(match[1], 10);
        // Should have dropped roughly 15 (20 total - ~5 kept).
        expect(dropped).toBeGreaterThan(10);
        expect(dropped).toBeLessThan(20);
        // The notice is itself a small entry — it's allowed to be
        // counted against the cap or not; either way the trimmed
        // total stays in the ~50K ballpark.
    });

    it("handles entries with no message / value (errors etc.)", () => {
        // Shouldn't NaN out on entries with neither field set.
        const mixed = [
            { type: "log", level: "log", message: "x".repeat(40_000) },
            { type: "screenshot", data: "[image emitted as observation]" },
            { type: "eval", expr: "1+1", value: "2" },
        ];
        const out = _enforceTotalCap(mixed, 30_000);
        // The big log gets dropped; the small entries stay.
        expect(out[0].message).toMatch(/^\[truncated/);
        const types = out.slice(1).map((e) => e.type);
        expect(types).toEqual(["screenshot", "eval"]);
    });
});

describe("resolveViewport", () => {
    it("defaults to 800×600 when unspecified", () => {
        expect(resolveViewport()).toEqual({ width: 800, height: 600 });
        expect(resolveViewport(null)).toEqual({ width: 800, height: 600 });
        expect(resolveViewport("")).toEqual({ width: 800, height: 600 });
    });

    it("resolves named presets (case-insensitive)", () => {
        expect(resolveViewport("desktop")).toEqual({ width: 1280, height: 800 });
        expect(resolveViewport("tablet")).toEqual({ width: 768, height: 1024 });
        expect(resolveViewport("mobile")).toEqual({ width: 390, height: 844 });
        expect(resolveViewport("MOBILE")).toEqual({ width: 390, height: 844 });
    });

    it("falls back to the default for unknown presets", () => {
        expect(resolveViewport("phablet")).toEqual({ width: 800, height: 600 });
    });

    it("accepts explicit width/height objects", () => {
        expect(resolveViewport({ width: 1440, height: 900 })).toEqual({
            width: 1440,
            height: 900,
        });
    });

    it("rounds and clamps out-of-range dimensions", () => {
        // Below the floor / above the ceiling get clamped to [200, 4000].
        expect(resolveViewport({ width: 10, height: 99999 })).toEqual({
            width: 200,
            height: 4000,
        });
        // Non-integers round.
        expect(resolveViewport({ width: 375.6, height: 667.2 })).toEqual({
            width: 376,
            height: 667,
        });
    });

    it("fills a missing dimension from the default", () => {
        expect(resolveViewport({ width: 1000 })).toEqual({
            width: 1000,
            height: 600,
        });
        // Garbage values fall back per-dimension rather than throwing.
        expect(resolveViewport({ width: "abc", height: 500 })).toEqual({
            width: 800,
            height: 500,
        });
    });

    it("treats explicit null/undefined dimensions as omitted", () => {
        // Number(null) === 0 (finite) would otherwise clamp to the floor
        // (200) instead of falling back to the default.
        expect(resolveViewport({ width: null, height: 500 })).toEqual({
            width: 800,
            height: 500,
        });
        expect(resolveViewport({ width: 1000, height: undefined })).toEqual({
            width: 1000,
            height: 600,
        });
    });
});

describe("executeActions — viewport action", () => {
    it("resizes the iframe (preset) when viewport is allowed", async () => {
        vi.useFakeTimers();
        try {
            const iframe = { style: {} };
            const p = executeActions(iframe, [{ viewport: "mobile" }], {
                allowViewport: true,
            });
            await vi.runAllTimersAsync();
            const results = await p;
            expect(iframe.style.width).toBe("390px");
            expect(iframe.style.height).toBe("844px");
            // A resize produces no result entry (silent, like wait/click).
            expect(results).toEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });

    it("resizes to explicit dimensions when allowed", async () => {
        vi.useFakeTimers();
        try {
            const iframe = { style: {} };
            const p = executeActions(
                iframe,
                [{ viewport: { width: 1440, height: 900 } }],
                { allowViewport: true },
            );
            await vi.runAllTimersAsync();
            await p;
            expect(iframe.style.width).toBe("1440px");
            expect(iframe.style.height).toBe("900px");
        } finally {
            vi.useRealTimers();
        }
    });

    it("no-ops with a warn note when viewport is not allowed (liveApp)", async () => {
        vi.useFakeTimers();
        try {
            const iframe = { style: {} };
            // Default opts → allowViewport false.
            const p = executeActions(iframe, [{ viewport: "mobile" }]);
            await vi.runAllTimersAsync();
            const results = await p;
            expect(iframe.style.width).toBeUndefined();
            expect(results).toHaveLength(1);
            expect(results[0].level).toBe("warn");
            expect(results[0].message).toMatch(/only supported in testApp/);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("capResults", () => {
    it("keeps the first 200 entries, then bounds the total size", () => {
        expect(capResults(makeLogs(250, 10))).toHaveLength(200);
        const big = capResults(makeLogs(10, 50_000));
        expect(big[0].message).toMatch(/^\[truncated: dropped/);
        expect(big.length).toBeLessThan(10);
    });
});

describe("an assertion failure", () => {
    it("carries what came before it, with the console, under the same bounds", async () => {
        const big = "x".repeat(50_000);
        vi.mocked(sendControl).mockImplementation(async (_iframe, action) => {
            if (action["get-logs"]) return { logs: [{ level: "log", message: "booted" }] };
            if (action.read) return { type: "read", selector: action.read, value: big };
            throw new Error("AssertionError: count is 3");
        });
        const iframe = /** @type {any} */ ({ contentWindow: {}, style: {} });
        const actions = [...Array.from({ length: 6 }, () => ({ read: "#out" })), { assert: "false" }];
        const failure = await runLiveApp({ iframe, actions }).catch((e) => e);
        expect(failure.message).toBe("AssertionError: count is 3");
        // six 50 KB reads plus the log would pass 256 KB: the earliest go
        expect(failure.results[0].message).toMatch(/^\[truncated: dropped 2 /);
        expect(failure.results.slice(1).every((r) => r.type === "read")).toBe(true);
        expect(failure.results).toHaveLength(6);
    });
});

describe("waitForIdle", () => {
    /** Whether `p` has settled, without waiting for it. */
    async function settled(p) {
        let done = false;
        p.then(() => { done = true; });
        await Promise.resolve();
        await Promise.resolve();
        return done;
    }

    it("settles after the quiet gap when no call is in flight", async () => {
        vi.useFakeTimers();
        try {
            const p = waitForIdle({}, 15000, 400);
            await vi.advanceTimersByTimeAsync(399);
            expect(await settled(p)).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            expect(await settled(p)).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it("waits out a call in flight, however long, then the quiet gap", async () => {
        vi.useFakeTimers();
        try {
            const iframe = {};
            const p = waitForIdle(iframe, 15000, 400);
            // a click set off an agent task, which takes seconds
            await vi.advanceTimersByTimeAsync(100);
            const done = callStarted(iframe);
            await vi.advanceTimersByTimeAsync(3000);
            expect(await settled(p)).toBe(false);
            done();
            await vi.advanceTimersByTimeAsync(399);
            expect(await settled(p)).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            expect(await settled(p)).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it("counts a call that was already in flight when the wait began", async () => {
        vi.useFakeTimers();
        try {
            const iframe = {};
            const done = callStarted(iframe);
            const p = waitForIdle(iframe, 15000, 400);
            await vi.advanceTimersByTimeAsync(1000);
            expect(await settled(p)).toBe(false);
            done();
            await vi.advanceTimersByTimeAsync(400);
            expect(await settled(p)).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it("settles every wait on the frame, not just the latest", async () => {
        vi.useFakeTimers();
        try {
            const iframe = {};
            const done = callStarted(iframe);
            const first = waitForIdle(iframe, 15000, 400);
            const second = waitForIdle(iframe, 15000, 400);
            await vi.advanceTimersByTimeAsync(1000);
            done();
            await vi.advanceTimersByTimeAsync(400);
            expect(await settled(first)).toBe(true);
            expect(await settled(second)).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it("stops counting the calls a page made once it reloads", async () => {
        vi.useFakeTimers();
        try {
            const iframe = {};
            const old = callStarted(iframe);
            callsLost(iframe);
            const p = waitForIdle(iframe, 15000, 400);
            await vi.advanceTimersByTimeAsync(400);
            expect(await settled(p)).toBe(true);
            // a call of the new page counts, and the old one's late
            // answer doesn't take it off
            const now = callStarted(iframe);
            const q = waitForIdle(iframe, 15000, 400);
            old();
            await vi.advanceTimersByTimeAsync(1000);
            expect(await settled(q)).toBe(false);
            now();
            await vi.advanceTimersByTimeAsync(400);
            expect(await settled(q)).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it("gives up at maxMs on a call that never answers", async () => {
        vi.useFakeTimers();
        try {
            const iframe = {};
            callStarted(iframe);
            const p = waitForIdle(iframe, 5000, 400);
            await vi.advanceTimersByTimeAsync(4999);
            expect(await settled(p)).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            expect(await settled(p)).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("a page that stops answering", () => {
    it("ends the run at the action that timed out", async () => {
        const sent = [];
        vi.mocked(sendControl).mockImplementation(async (_iframe, action) => {
            sent.push(action);
            if (action.eval) throw new Error("TimeoutError: the app didn't answer");
            return null;
        });
        const results = await executeActions(/** @type {any} */ ({}), [{ eval: "hang()" }, { read: "#a" }, { read: "#b" }]);
        expect(sent).toEqual([{ eval: "hang()" }]);
        expect(results).toEqual([{ type: "log", level: "error", message: "TimeoutError: the app didn't answer" }]);
    });
});

describe("a test's app that reloads itself", () => {
    it("is answered once, and the bootloader coming back marks its page gone", () => {
        const posted = [];
        const win = { postMessage: (/** @type {any} */ msg) => posted.push(msg) };
        const iframe = /** @type {any} */ ({ contentWindow: win });
        const page = { html: "<p>app</p>", assets: [] };
        const handler = _attachBridges(iframe, null, [], page);
        const hostReady = /** @type {any} */ ({ source: win, origin: APPS_ORIGIN, data: { type: "agex-host-ready", assets: 1 } });

        handler(hostReady);
        expect(posted.map((m) => m.type)).toEqual(["agex-host-init"]);
        expect(pageGone).not.toHaveBeenCalled();

        // the app reloaded between actions: no action saw it go
        handler(hostReady);
        expect(posted).toHaveLength(1);
        expect(pageGone).toHaveBeenCalledWith(iframe);
    });
});

describe("a test's app that never comes up", () => {
    it("says the sandbox didn't load when it never asked for the app", () => {
        expect(bootFailure(false, 10000)).toMatch(/didn't load within 10000ms/);
    });

    it("points at the app's script, and in development the studio's origin, when it did", () => {
        vi.stubGlobal("location", { origin: "http://localhost:4176" });
        try {
            const text = bootFailure(true, 10000);
            expect(text).toMatch(/module-eval error/);
            expect(text).toContain("this studio is at http://localhost:4176");
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
