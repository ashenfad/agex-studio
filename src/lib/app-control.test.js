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

import { describe, expect, it } from "vitest";

import { _enforceTotalCap, resolveViewport } from "./app-control.js";

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
});
