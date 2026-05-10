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

// Mirror mock for the Ts adapter so registry tests that hit `'ts'`
// don't try to construct the real agex-ts agent in a non-browser
// test env. The init path is shared with the py mock for simplicity
// (same closures); the kernel discriminator differs.
vi.mock("./ts-kernel-adapter.js", () => ({
    createTsAdapter: () => ({
        kernel: "ts",
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

    it("returns the same adapter on subsequent calls and re-inits with new settings", async () => {
        // Per the KernelAdapter typedef, `init` may be called more than
        // once to propagate settings updates (model change, API key
        // rotation, etc.). The bootstrap work happens once; subsequent
        // ensure() calls hit the adapter's hot-swap path.
        const registry = createKernelRegistry();
        const initSettingsSeen = [];
        mockInitImpl = async (settings, _opts) => {
            initSettingsSeen.push(settings);
        };
        const a1 = await registry.ensure("py", { apiKey: "k", model: "m" });
        const a2 = await registry.ensure("py", { apiKey: "k2", model: "m2" });
        expect(a1).toBe(a2);
        expect(mockInitCalls).toBe(2);
        expect(initSettingsSeen).toEqual([
            { apiKey: "k", model: "m" },
            { apiKey: "k2", model: "m2" },
        ]);
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

    it("constructs the ts adapter on ensure('ts')", async () => {
        const registry = createKernelRegistry();
        const adapter = await registry.ensure("ts", { apiKey: "k", model: "m" });
        expect(adapter.kernel).toBe("ts");
        expect(mockInitCalls).toBe(1);
    });

    it("py and ts adapters are independent registry entries", async () => {
        const registry = createKernelRegistry();
        const py = await registry.ensure("py", { apiKey: "k", model: "m" });
        const ts = await registry.ensure("ts", { apiKey: "k", model: "m" });
        expect(py.kernel).toBe("py");
        expect(ts.kernel).toBe("ts");
        expect(registry.has("py")).toBe(true);
        expect(registry.has("ts")).toBe(true);
        // Each kernel triggers its own init, so 2 total inits.
        expect(mockInitCalls).toBe(2);
    });

    it("fans onStage milestones out to multiple listeners", async () => {
        const registry = createKernelRegistry();
        const stages1 = [];
        const stages2 = [];
        // Use a slow init so we can register the second listener
        // before any stage fires.
        let resolveInit;
        let dispatchedFromInit = null;
        mockInitImpl = async (_settings, opts) => {
            dispatchedFromInit = opts.onStage;
            await new Promise((r) => { resolveInit = r; });
            // Fire stages once both listeners have registered
            await opts.onStage("history-ready");
            await opts.onStage("send-ready");
        };

        const p1 = registry.ensure("py", { apiKey: "k", model: "m" }, {
            onStage: (s) => { stages1.push(s); },
        });
        // Second caller registers an onStage on the in-flight init
        const p2 = registry.ensure("py", { apiKey: "k", model: "m" }, {
            onStage: (s) => { stages2.push(s); },
        });
        // Both ensure calls await the same init; let it run
        resolveInit();
        await Promise.all([p1, p2]);

        // Both listeners saw both stages
        expect(stages1).toEqual(["history-ready", "send-ready"]);
        expect(stages2).toEqual(["history-ready", "send-ready"]);
        // The init was passed a dispatcher (not the raw caller's onStage)
        expect(dispatchedFromInit).not.toBe(stages1);
    });

    it("late-registered onStage listeners only see subsequent stages", async () => {
        const registry = createKernelRegistry();
        const earlyStages = [];
        const lateStages = [];
        let resolveAfterFirstStage;
        let registryDispatcher;
        mockInitImpl = async (_settings, opts) => {
            registryDispatcher = opts.onStage;
            await opts.onStage("history-ready");
            // Pause so the test can register a late listener BETWEEN
            // history-ready and send-ready.
            await new Promise((r) => { resolveAfterFirstStage = r; });
            await opts.onStage("send-ready");
        };

        const p1 = registry.ensure("py", { apiKey: "k", model: "m" }, {
            onStage: (s) => { earlyStages.push(s); },
        });
        // Wait until the first stage has fired
        await new Promise((r) => setTimeout(r, 5));
        // Now register a late listener — should only see send-ready
        const p2 = registry.ensure("py", { apiKey: "k", model: "m" }, {
            onStage: (s) => { lateStages.push(s); },
        });
        resolveAfterFirstStage();
        await Promise.all([p1, p2]);

        expect(earlyStages).toEqual(["history-ready", "send-ready"]);
        // No replay — late listener only saw post-registration stages.
        expect(lateStages).toEqual(["send-ready"]);
    });

    it("a throwing onStage listener doesn't break others", async () => {
        const registry = createKernelRegistry();
        const goodStages = [];
        let resolveInit;
        mockInitImpl = async (_settings, opts) => {
            await new Promise((r) => { resolveInit = r; });
            await opts.onStage("history-ready");
        };
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

        // Register both listeners BEFORE init's onStage fires.
        const p1 = registry.ensure("py", { apiKey: "k", model: "m" }, {
            onStage: () => { throw new Error("oops"); },
        });
        const p2 = registry.ensure("py", { apiKey: "k", model: "m" }, {
            onStage: (s) => { goodStages.push(s); },
        });
        resolveInit();
        await Promise.all([p1, p2]);

        // Bad listener swallowed via console.warn; good listener still ran.
        expect(goodStages).toEqual(["history-ready"]);
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
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
