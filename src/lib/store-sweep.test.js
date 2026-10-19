import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SWEEP_AGAIN, SWEEP_DELAY, Sweeper } from "./store-sweep.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("the store's sweeper", () => {
    it("sweeps once, a while after the last ask", async () => {
        const sweep = vi.fn(async () => 0);
        const sweeper = new Sweeper(sweep);
        sweeper.request();
        vi.advanceTimersByTime(SWEEP_DELAY / 2);
        sweeper.request();
        vi.advanceTimersByTime(SWEEP_DELAY - 1);
        expect(sweep).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(sweep).toHaveBeenCalledTimes(1);
    });

    it("sweeps once more past the hour a sweep keeps, and no more", async () => {
        const sweep = vi.fn(async () => 0);
        const sweeper = new Sweeper(sweep);
        sweeper.request();
        vi.advanceTimersByTime(SWEEP_DELAY);
        vi.advanceTimersByTime(SWEEP_AGAIN - 1);
        expect(sweep).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(1);
        expect(sweep).toHaveBeenCalledTimes(2);
        vi.advanceTimersByTime(10 * SWEEP_AGAIN);
        expect(sweep).toHaveBeenCalledTimes(2);
        // an ask meanwhile moves the one after on, rather than adding one
        sweeper.request();
        vi.advanceTimersByTime(SWEEP_DELAY + SWEEP_AGAIN / 2);
        sweeper.request();
        vi.advanceTimersByTime(SWEEP_DELAY + SWEEP_AGAIN);
        expect(sweep).toHaveBeenCalledTimes(5);
        sweeper.clear();
        vi.advanceTimersByTime(10 * SWEEP_AGAIN);
        expect(sweep).toHaveBeenCalledTimes(5);
    });

    it("warns of a sweep that fails, and sweeps again when asked", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const sweep = vi.fn(async () => {
            throw new Error("busy");
        });
        const sweeper = new Sweeper(sweep, { delay: 10, again: 1_000 });
        sweeper.request();
        await vi.advanceTimersByTimeAsync(10);
        expect(warn).toHaveBeenCalledWith("sweeping the store failed:", expect.any(Error));
        sweeper.request();
        await vi.advanceTimersByTimeAsync(10);
        expect(sweep).toHaveBeenCalledTimes(2);
        warn.mockRestore();
    });
});
