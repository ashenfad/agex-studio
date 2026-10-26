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
    setLiveSettled,
    settleFirstLoad,
    waitForIdle,
    whenLiveSettled,
} from "./app-control.js";
import { APPS_ORIGIN } from "./apps-origin.js";
import { hasLoaded, pageGone, pageLoaded, pageUp, sendControl, waitForLoad } from "./send-control.js";

vi.mock("./send-control.js", () => ({
    CONTROL_TIMEOUT_MS: 30_000,
    sendControl: vi.fn(),
    pageGone: vi.fn(),
    pageUp: vi.fn(),
    pageLoaded: vi.fn(),
    waitForLoad: vi.fn(async () => true),
    hasLoaded: vi.fn(() => true),
}));

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

describe("an action that fails", () => {
    it("ends the call with an error, carrying what came before it (a grid's frames among it)", async () => {
        const sent = [];
        vi.mocked(sendControl).mockImplementation(async (_iframe, action) => {
            sent.push(action);
            if (action.screenshot) return { type: "screenshot", data: "PNG" };
            if (action.click === "#gone") throw new Error('ActionError: click "#gone": nothing matches it (waited 1000ms)');
            return null;
        });
        const failure = await executeActions(/** @type {any} */ ({}), [
            { screenshot: true, grid: "steps", label: "before" },
            { click: "#gone" },
            { read: "#after" },
        ]).catch((e) => e);
        expect(failure.message).toBe('ActionError: click "#gone": nothing matches it (waited 1000ms)');
        expect(failure.results).toEqual([{ type: "screenshot", data: "PNG", grid: "steps", label: "before" }]);
        // nothing after it runs on a page that isn't as the actions expect
        expect(sent.map((a) => Object.keys(a)[0])).toEqual(["screenshot", "click"]);
    });

    it("ends it too for anything else the bridge throws, an unknown action among it", async () => {
        vi.mocked(sendControl).mockImplementation(async (_iframe, action) => {
            if (action.clik) throw new Error('Unknown action: {"clik":"#a"}');
            return { type: "read", selector: action.read, value: "x" };
        });
        const failure = await executeActions(/** @type {any} */ ({}), [{ read: "#a" }, { clik: "#a" }, { read: "#b" }]).catch((e) => e);
        expect(failure.message).toBe('Action failed: Unknown action: {"clik":"#a"}');
        expect(failure.results).toEqual([{ type: "read", selector: "#a", value: "x" }]);
    });

    it("comes back from the live preview with the console, as an assertion's does", async () => {
        vi.mocked(sendControl).mockImplementation(async (_iframe, action) => {
            if (action["get-logs"]) return { logs: [{ level: "log", message: "booted" }] };
            if (action.waitFor) throw new Error('ActionError: waitFor "#x": still nothing matches it after 5000ms');
            return null;
        });
        const iframe = /** @type {any} */ ({ contentWindow: {}, style: {} });
        const failure = await runLiveApp({ iframe, actions: [{ waitFor: "#x" }] }).catch((e) => e);
        expect(failure.message).toMatch(/^ActionError: waitFor "#x"/);
        expect(failure.results).toEqual([{ type: "log", level: "log", message: "booted" }]);
    });
});

describe("a waiting action", () => {
    it("gives the page its wait on top of the usual time to answer", async () => {
        vi.mocked(sendControl).mockResolvedValue(null);
        await executeActions(/** @type {any} */ ({}), [{ waitFor: "#a", timeout: 8000 }, { read: "#a" }]);
        expect(vi.mocked(sendControl).mock.calls.slice(-2).map((c) => c[2])).toEqual([{ timeoutMs: 38_000 }, { timeoutMs: 30_000 }]);
    });

    it("{wait: 0} waits for nothing, and isn't sent to the page", async () => {
        vi.mocked(sendControl).mockClear();
        expect(await executeActions(/** @type {any} */ ({}), [{ wait: 0 }])).toEqual([]);
        expect(sendControl).not.toHaveBeenCalled();
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
        expect(pageGone).toHaveBeenCalledWith(iframe, "app");
    });

    it("stops the gone page's model calls", async () => {
        const posted = [];
        const win = { postMessage: (/** @type {any} */ msg) => posted.push(msg) };
        const iframe = /** @type {any} */ ({ contentWindow: win });
        const pending = [];
        /** @type {import("./app-model.js").ModelRunner} */
        const run = (_call, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("stopped"))));
        const handler = _attachBridges(iframe, null, pending, { html: "<p>app</p>", assets: [] }, null, null, null, run);
        const message = (/** @type {any} */ data) => handler(/** @type {any} */ ({ source: win, origin: APPS_ORIGIN, data }));

        message({ type: "agex-host-ready", assets: 1 });
        message({ type: "agex-model", id: "m", messages: [], tools: [], settings: {} });
        message({ type: "agex-host-ready", assets: 1 });
        await Promise.all(pending);
        expect(posted.at(-1)).toMatchObject({ type: "agex-model-end", id: "m", error: { message: "stopped" } });
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

describe("executeActions — reload action", () => {
    it("is the caller's to do, its entries in the results, and the run goes on", async () => {
        vi.mocked(sendControl).mockImplementation(async (_iframe, action) => ({ type: "read", selector: action.read, value: "kept" }));
        const reload = vi.fn(async () => [{ type: "reload", message: "reloaded" }]);
        const results = await executeActions(/** @type {any} */ ({}), [{ reload: true }, { read: "#saved" }], { reload });
        expect(reload).toHaveBeenCalledOnce();
        expect(results).toEqual([{ type: "reload", message: "reloaded" }, { type: "read", selector: "#saved", value: "kept" }]);
    });

    it("no-ops with a note on the live preview", async () => {
        vi.mocked(sendControl).mockResolvedValue(null);
        const results = await executeActions(/** @type {any} */ ({}), [{ reload: true }]);
        expect(results).toHaveLength(1);
        expect(results[0].level).toBe("warn");
        expect(results[0].message).toMatch(/reload actions are only supported without live: true/);
    });

    it("ends the run when the page doesn't come back", async () => {
        const sent = [];
        vi.mocked(sendControl).mockImplementation(async (_iframe, action) => void sent.push(action));
        const reload = async () => {
            throw new Error("test_app: iframe failed to come up");
        };
        const results = await executeActions(/** @type {any} */ ({}), [{ reload: true }, { read: "#a" }], { reload });
        expect(sent).toEqual([]);
        expect(results).toEqual([{ type: "log", level: "error", message: "reload failed: test_app: iframe failed to come up" }]);
    });
});

describe("a test's page coming up", () => {
    const win = { postMessage: () => {} };
    const iframe = /** @type {any} */ ({ contentWindow: win });
    const from = (data) => /** @type {any} */ ({ source: win, origin: APPS_ORIGIN, data });

    it("is followed: its bridge up, then its document loaded", () => {
        const handler = _attachBridges(iframe, null, [], { html: "", assets: [] });
        handler(from({ type: "agex-bridge-ready" }));
        expect(pageUp).toHaveBeenCalledWith(iframe);
        handler(from({ type: "agex-page-loaded" }));
        expect(pageLoaded).toHaveBeenCalledWith(iframe);
    });

    it("is sent the page due each time the bootloader asks, and none past that", () => {
        const posted = [];
        const frame = /** @type {any} */ ({ contentWindow: { postMessage: (msg) => posted.push(msg) } });
        const ask = /** @type {any} */ ({ source: frame.contentWindow, origin: APPS_ORIGIN, data: { type: "agex-host-ready", assets: 1 } });
        const pages = [{ html: "<p>one</p>", assets: [] }, { html: "<p>two</p>", assets: [] }];
        const handler = _attachBridges(frame, null, [], () => pages.shift() ?? null);
        handler(ask);
        handler(ask);
        expect(posted.map((m) => m.html)).toEqual(["<p>one</p>", "<p>two</p>"]);
        handler(ask);
        expect(posted).toHaveLength(2);
        expect(pageGone).toHaveBeenCalledWith(frame, "app");
    });

    it("hands on the storage it reports, checked, for a reload", () => {
        const onStorage = vi.fn();
        const handler = _attachBridges(iframe, null, [], null, null, onStorage);
        handler(from({ type: "agex-test-storage", local: { saved: "1" }, session: { tab: "a" } }));
        expect(onStorage).toHaveBeenCalledWith({ local: { saved: "1" }, session: { tab: "a" } });
        // a bag the shim wouldn't have kept is dropped
        handler(from({ type: "agex-test-storage", local: { n: 1 }, session: {} }));
        expect(onStorage).toHaveBeenCalledOnce();
        // only from the test's own frame
        handler(/** @type {any} */ ({ source: {}, origin: APPS_ORIGIN, data: { type: "agex-test-storage", local: {}, session: {} } }));
        expect(onStorage).toHaveBeenCalledOnce();
    });
});

describe("a test's database calls", () => {
    it("run on the database the test gives, or fail without one", async () => {
        const posted = [];
        const win = { postMessage: (/** @type {any} */ msg) => posted.push(msg) };
        const iframe = /** @type {any} */ ({ contentWindow: win });
        const from = (data) => /** @type {any} */ ({ source: win, origin: APPS_ORIGIN, data });
        const db = { query: vi.fn(async () => ({ rows: [{ n: 1 }], changes: 0, lastInsertRowid: 0 })) };
        const pending = [];
        const handler = _attachBridges(iframe, null, pending, null, null, null, async () => /** @type {any} */ (db));
        handler(from({ type: "agex-db", id: "q1", op: "query", args: ["SELECT 1 AS n", null] }));
        await Promise.all(pending);
        expect(db.query).toHaveBeenCalledWith("SELECT 1 AS n", null);
        expect(posted).toEqual([{ type: "agex-db-result", id: "q1", value: { rows: [{ n: 1 }], changes: 0, lastInsertRowid: 0 }, error: null }]);

        const none = [];
        const bare = _attachBridges(iframe, null, none);
        bare(from({ type: "agex-db", id: "q2", op: "query", args: ["SELECT 1", null] }));
        await Promise.all(none);
        expect(posted[1]).toEqual({ type: "agex-db-result", id: "q2", value: null, error: { name: "Error", message: "agex.db isn't available here" } });
    });
});

describe("a test's model calls", () => {
    it("run on the runner the test gives, stop when the app cancels, and fail without one", async () => {
        const posted = [];
        const win = { postMessage: (/** @type {any} */ msg) => posted.push(msg) };
        const iframe = /** @type {any} */ ({ contentWindow: win });
        const from = (data) => /** @type {any} */ ({ source: win, origin: APPS_ORIGIN, data });
        /** @type {AbortSignal | null} */
        let seen = null;
        const run = vi.fn(async (/** @type {any} */ _call, /** @type {any} */ { signal, onEvent }) => {
            seen = signal;
            onEvent({ kind: "TextDelta", text: "he" });
            await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("stopped"))));
        });
        const pending = [];
        const handler = _attachBridges(iframe, null, pending, null, null, null, null, run);
        handler(from({ type: "agex-model", id: "m1", messages: [], tools: [], settings: {} }));
        expect(pending).toHaveLength(1);
        handler(from({ type: "agex-model-cancel", id: "m1" }));
        await Promise.all(pending);
        expect(seen?.aborted).toBe(true);
        expect(posted.map((m) => m.type)).toEqual(["agex-model-event", "agex-model-end"]);
        expect(posted[1].error).toMatchObject({ message: "stopped" });

        const none = [];
        _attachBridges(iframe, null, none)(from({ type: "agex-model", id: "m2" }));
        await Promise.all(none);
        expect(posted[2]).toMatchObject({ type: "agex-model-end", id: "m2", error: { message: "agex.model isn't available here" } });
    });
});

describe("the first load", () => {
    it("waits for the page's document, then the app's idle gap", async () => {
        vi.useFakeTimers();
        try {
            /** @type {(v: boolean) => void} */
            let loaded = () => {};
            vi.mocked(waitForLoad).mockImplementationOnce(() => new Promise((r) => (loaded = r)));
            let note;
            const p = settleFirstLoad({}).then((n) => (note = n));
            await vi.advanceTimersByTimeAsync(5000);
            expect(note).toBeUndefined();
            // a cold import arrived, the page loaded
            loaded(true);
            await vi.advanceTimersByTimeAsync(999);
            expect(note).toBeUndefined();
            await vi.advanceTimersByTimeAsync(1);
            await p;
            expect(note).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it("carries on with a note when the page hasn't loaded in time", async () => {
        vi.useFakeTimers();
        try {
            vi.mocked(waitForLoad).mockResolvedValueOnce(false);
            const p = settleFirstLoad({}, { loadMs: 30_000 });
            await vi.advanceTimersByTimeAsync(1000);
            const note = await p;
            expect(note).toMatchObject({ type: "log", level: "warn" });
            expect(note.message).toMatch(/hadn't finished loading after 30s/);
        } finally {
            vi.useRealTimers();
        }
    });

    it("is waited for on the live preview too, with a note when it didn't come", async () => {
        vi.mocked(waitForLoad).mockResolvedValueOnce(false);
        vi.mocked(sendControl).mockResolvedValue(null);
        const results = await runLiveApp({ iframe: /** @type {any} */ ({ contentWindow: {} }), actions: [], loadMs: 5000 });
        expect(waitForLoad).toHaveBeenLastCalledWith(expect.anything(), 5000);
        expect(results[0].message).toMatch(/preview's page hadn't finished loading after 5s/);
    });
});

describe("a live preview that was still loading", () => {
    it("lets the app's calls settle before the first action, and one long loaded starts at once", async () => {
        vi.useFakeTimers();
        try {
            const sent = [];
            vi.mocked(sendControl).mockImplementation(async (_iframe, action) => {
                sent.push(action);
                return null;
            });
            vi.mocked(hasLoaded).mockReturnValueOnce(false);
            const loading = /** @type {any} */ ({ contentWindow: {} });
            const p = runLiveApp({ iframe: loading, actions: [{ read: "#a" }] });
            // its load handler set off a call to the studio
            await vi.advanceTimersByTimeAsync(100);
            const done = callStarted(loading);
            await vi.advanceTimersByTimeAsync(5000);
            expect(sent).toEqual([]);
            done();
            await vi.advanceTimersByTimeAsync(1000);
            await p;
            expect(sent[0]).toEqual({ read: "#a" });

            sent.length = 0;
            const q = runLiveApp({ iframe: /** @type {any} */ ({ contentWindow: {} }), actions: [{ read: "#b" }] });
            await vi.advanceTimersByTimeAsync(0);
            expect(sent[0]).toEqual({ read: "#b" });
            await vi.advanceTimersByTimeAsync(1000);
            await q;
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("a live test after a write", () => {
    it("waits for the preview to go on with the files, at once with no preview, and not past its cap", async () => {
        await whenLiveSettled();
        /** @type {() => void} */
        let rebuilt = () => {};
        setLiveSettled(() => new Promise((r) => (rebuilt = () => r(undefined))));
        let done = false;
        const p = whenLiveSettled().then(() => (done = true));
        await Promise.resolve();
        expect(done).toBe(false);
        rebuilt();
        await p;
        expect(done).toBe(true);

        vi.useFakeTimers();
        try {
            setLiveSettled(() => new Promise(() => {}));
            const capped = whenLiveSettled(15_000);
            await vi.advanceTimersByTimeAsync(15_000);
            await capped;
        } finally {
            vi.useRealTimers();
            setLiveSettled(null);
        }
    });
});
