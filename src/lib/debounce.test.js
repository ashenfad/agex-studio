import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Debouncer } from "./debounce.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("the debouncer", () => {
    it("runs a job a moment after its last call", () => {
        const d = new Debouncer(60_000);
        const job = vi.fn();
        d.schedule("a", 10_000, job);
        vi.advanceTimersByTime(9_000);
        d.schedule("a", 10_000, job);
        vi.advanceTimersByTime(9_000);
        expect(job).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1_000);
        expect(job).toHaveBeenCalledTimes(1);
    });

    it("runs it by `most` after the first call, however often it's called", () => {
        const d = new Debouncer(60_000);
        const job = vi.fn();
        for (let t = 0; t < 60_000; t += 1_000) {
            d.schedule("a", 10_000, job);
            vi.advanceTimersByTime(1_000);
        }
        expect(job).toHaveBeenCalledTimes(1);
        // and counts afresh from the next call
        d.schedule("a", 10_000, job);
        vi.advanceTimersByTime(10_000);
        expect(job).toHaveBeenCalledTimes(2);
    });

    it("keeps keys apart, and drops every job when cleared", () => {
        const d = new Debouncer(60_000);
        const a = vi.fn();
        const b = vi.fn();
        d.schedule("a", 1_000, a);
        d.schedule("b", 1_000, b);
        vi.advanceTimersByTime(1_000);
        expect([a.mock.calls.length, b.mock.calls.length]).toEqual([1, 1]);
        d.schedule("a", 1_000, a);
        d.clear();
        vi.advanceTimersByTime(60_000);
        expect(a).toHaveBeenCalledTimes(1);
    });
});
