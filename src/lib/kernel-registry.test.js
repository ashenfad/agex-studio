/**
 * Kernel registry tests — exercises the lazy-boot, dedup, and dispose
 * semantics using a fake adapter via vi.mock so we don't have to
 * boot Pyodide.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the adapter constructor BEFORE importing the registry. The
// registry calls `createPyAdapter()` inside `ensure('py')`; the mock
// returns a controllable test double instead of the real adapter.
let mockInitCalls = 0;
let mockDisposeCalls = 0;
let mockInitImpl = async (_settings, _opts) => {};

vi.mock("./py-kernel-adapter.js", () => ({
    createPyAdapter: () => ({
        kernel: "py",
        init: async (settings, opts) => {
            mockInitCalls++;
            return mockInitImpl(settings, opts);
        },
        dispose: async () => {
            mockDisposeCalls++;
        },
    }),
}));

import { createKernelRegistry } from "./kernel-registry.js";

beforeEach(() => {
    mockInitCalls = 0;
    mockDisposeCalls = 0;
    mockInitImpl = async () => {};
});

describe("kernelRegistry.ensure", () => {
    it("boots the adapter on first call and returns it", async () => {
        const registry = createKernelRegistry();
        const adapter = await registry.ensure("py", { apiKey: "k", model: "m" });
        expect(adapter.kernel).toBe("py");
        expect(mockInitCalls).toBe(1);
    });

    it("returns the cached adapter on subsequent calls without re-init", async () => {
        const registry = createKernelRegistry();
        const a1 = await registry.ensure("py", { apiKey: "k", model: "m" });
        const a2 = await registry.ensure("py", { apiKey: "k2", model: "m2" });
        expect(a1).toBe(a2);
        expect(mockInitCalls).toBe(1);
    });

    it("dedupes concurrent calls into a single init", async () => {
        const registry = createKernelRegistry();
        // Slow init so both callers race
        let resolveInit;
        mockInitImpl = () => new Promise((r) => { resolveInit = r; });

        const p1 = registry.ensure("py", { apiKey: "k", model: "m" });
        const p2 = registry.ensure("py", { apiKey: "k", model: "m" });
        // Both calls observe the same in-flight init
        expect(mockInitCalls).toBe(1);
        resolveInit();
        const [a1, a2] = await Promise.all([p1, p2]);
        expect(a1).toBe(a2);
        expect(mockInitCalls).toBe(1);
    });

    it("evicts the entry on init failure so a future call retries cleanly", async () => {
        const registry = createKernelRegistry();
        mockInitImpl = async () => { throw new Error("boom"); };

        await expect(
            registry.ensure("py", { apiKey: "k", model: "m" }),
        ).rejects.toThrow("boom");
        expect(registry.has("py")).toBe(false);

        // Next call retries — fresh adapter, fresh init.
        mockInitImpl = async () => {};
        const adapter = await registry.ensure("py", { apiKey: "k", model: "m" });
        expect(adapter.kernel).toBe("py");
        expect(mockInitCalls).toBe(2);
    });

    it("rejects unknown kernel names", async () => {
        const registry = createKernelRegistry();
        await expect(
            // @ts-expect-error: testing the runtime error path
            registry.ensure("rust", { apiKey: "k", model: "m" }),
        ).rejects.toThrow(/unknown kernel/);
    });

    it("rejects ts (not yet implemented) with a clear message", async () => {
        const registry = createKernelRegistry();
        await expect(
            registry.ensure("ts", { apiKey: "k", model: "m" }),
        ).rejects.toThrow(/ts kernel adapter not yet implemented/);
    });
});

describe("kernelRegistry.has / get", () => {
    it("has() returns false before any ensure", () => {
        const registry = createKernelRegistry();
        expect(registry.has("py")).toBe(false);
        expect(registry.has("ts")).toBe(false);
    });

    it("has() returns true after a successful ensure", async () => {
        const registry = createKernelRegistry();
        await registry.ensure("py", { apiKey: "k", model: "m" });
        expect(registry.has("py")).toBe(true);
        expect(registry.has("ts")).toBe(false);
    });

    it("get() returns null before ensure, the adapter after", async () => {
        const registry = createKernelRegistry();
        expect(registry.get("py")).toBe(null);
        const adapter = await registry.ensure("py", { apiKey: "k", model: "m" });
        expect(registry.get("py")).toBe(adapter);
    });

    it("has() does not trigger a boot", () => {
        const registry = createKernelRegistry();
        expect(registry.has("py")).toBe(false);
        expect(mockInitCalls).toBe(0);
    });

    it("get() does not trigger a boot", () => {
        const registry = createKernelRegistry();
        expect(registry.get("py")).toBe(null);
        expect(mockInitCalls).toBe(0);
    });
});

describe("kernelRegistry.dispose", () => {
    it("disposes all booted adapters and clears the registry", async () => {
        const registry = createKernelRegistry();
        await registry.ensure("py", { apiKey: "k", model: "m" });
        expect(registry.has("py")).toBe(true);
        await registry.dispose();
        expect(registry.has("py")).toBe(false);
        expect(mockDisposeCalls).toBe(1);
    });

    it("is a no-op when nothing has been booted", async () => {
        const registry = createKernelRegistry();
        await registry.dispose();
        expect(mockDisposeCalls).toBe(0);
    });
});
