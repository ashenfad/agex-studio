/**
 * Tests for the shared relative-time formatters.
 *
 * Both are pure given the current clock, so we freeze time with
 * vitest's fake timers and assert each bucket boundary plus the
 * empty / unparseable fallbacks. The key behavioral difference under
 * test: `formatDate` falls back to an absolute date past a week, while
 * `relativeTime` stays relative all the way to years.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { formatDate, relativeTime } from "./format-time.js";

// A fixed "now" so relative math is deterministic.
const NOW = new Date("2026-06-21T12:00:00.000Z");
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();

const SEC = 1000;
const MIN = 60 * SEC;
const HR = 60 * MIN;
const DAY = 24 * HR;

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
});

afterEach(() => {
    vi.useRealTimers();
});

describe("formatDate", () => {
    it("returns '' for missing or unparseable input", () => {
        expect(formatDate("")).toBe("");
        expect(formatDate(null)).toBe("");
        expect(formatDate(undefined)).toBe("");
        expect(formatDate("not-a-date")).toBe("");
    });

    it("buckets sub-week ages relatively", () => {
        expect(formatDate(ago(30 * SEC))).toBe("just now");
        expect(formatDate(ago(5 * MIN))).toBe("5m ago");
        expect(formatDate(ago(3 * HR))).toBe("3h ago");
        expect(formatDate(ago(2 * DAY))).toBe("2d ago");
    });

    it("falls back to an absolute date past a week", () => {
        const old = ago(10 * DAY);
        expect(formatDate(old)).toBe(new Date(old).toLocaleDateString());
    });
});

describe("relativeTime", () => {
    it("returns '' for unparseable input", () => {
        expect(relativeTime("nope")).toBe("");
        expect(relativeTime(undefined)).toBe("");
    });

    it("buckets across seconds, minutes, hours, days", () => {
        expect(relativeTime(ago(10 * SEC))).toBe("just now");
        expect(relativeTime(ago(5 * MIN))).toBe("5m ago");
        expect(relativeTime(ago(3 * HR))).toBe("3h ago");
        expect(relativeTime(ago(5 * DAY))).toBe("5d ago");
    });

    it("stays relative out to months and years (no absolute fallback)", () => {
        expect(relativeTime(ago(60 * DAY))).toBe("2mo ago");
        expect(relativeTime(ago(400 * DAY))).toBe("1y ago");
    });

    it("clamps future timestamps to 'just now'", () => {
        expect(relativeTime(new Date(NOW.getTime() + 5 * MIN).toISOString())).toBe(
            "just now",
        );
    });
});
