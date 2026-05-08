/**
 * Session-index tests — covers the pure-JS bits (cache CRUD,
 * classifyDbName, reconcileWithBareNames). The IDB-enumeration
 * helpers (`enumerateBareNames`, `_readBranchNames`,
 * `reconcileCache`) are integration-shaped (they touch real
 * `indexedDB`) and intentionally not covered here — happy-dom's IDB
 * polyfill is partial and the value of mock-testing them is low.
 * They'll get exercised once both adapters are live.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Minimal localStorage stub — vitest's default jsdom-less env doesn't
// provide one. Matches the pattern used in settings.test.js.
const store = {};
vi.stubGlobal("localStorage", {
    getItem: (k) => store[k] ?? null,
    setItem: (k, v) => {
        store[k] = v;
    },
    removeItem: (k) => {
        delete store[k];
    },
});

import {
    cacheSession,
    clearCache,
    classifyDbName,
    loadCache,
    reconcileWithBareNames,
    uncacheSession,
} from "./session-index.js";

beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
});

describe("classifyDbName", () => {
    it("identifies the agex-py default db as py", () => {
        expect(classifyDbName("kvgit")).toBe("py");
    });

    it("identifies session-suffixed kvgit names as ts", () => {
        expect(classifyDbName("kvgit/default")).toBe("ts");
        expect(classifyDbName("kvgit/alice")).toBe("ts");
    });

    it("rejects unrelated db names", () => {
        expect(classifyDbName("agex-studio-app-storage")).toBe(null);
        expect(classifyDbName("random-other-app")).toBe(null);
        expect(classifyDbName("")).toBe(null);
        expect(classifyDbName(undefined)).toBe(null);
    });

    it("rejects close-but-wrong patterns", () => {
        // No trailing slash — exact 'kvgit' is py; 'kvgit-other' is
        // not a kvgit-shaped store.
        expect(classifyDbName("kvgit-other")).toBe(null);
    });
});

describe("cache CRUD", () => {
    it("returns [] for an empty cache", () => {
        expect(loadCache()).toEqual([]);
    });

    it("returns [] for a malformed cache", () => {
        localStorage.setItem("agex-sessions-cache", "not-json{");
        expect(loadCache()).toEqual([]);
    });

    it("returns [] when the cache stores a non-array", () => {
        localStorage.setItem(
            "agex-sessions-cache",
            JSON.stringify({ branch: "chat-x" }),
        );
        expect(loadCache()).toEqual([]);
    });

    it("filters out malformed entries on load", () => {
        localStorage.setItem(
            "agex-sessions-cache",
            JSON.stringify([
                { kernel: "py", branch: "chat-1", title: "ok" },
                { kernel: "wat", branch: "chat-2" },
                { branch: "chat-3" },
                null,
                { kernel: "py", branch: "" },
                { kernel: "ts", branch: "chat-4", title: "also ok" },
            ]),
        );
        const records = loadCache();
        expect(records).toHaveLength(2);
        expect(records.map((r) => r.branch)).toEqual(["chat-1", "chat-4"]);
    });

    it("inserts a new session", () => {
        cacheSession({
            kernel: "py",
            branch: "chat-abc",
            title: "Hello",
            name: "",
            description: "",
            updated: "2026-05-07T00:00:00Z",
        });
        const records = loadCache();
        expect(records).toHaveLength(1);
        expect(records[0].title).toBe("Hello");
    });

    it("updates an existing session in place (not duplicate)", () => {
        cacheSession({
            kernel: "py",
            branch: "chat-abc",
            title: "First",
            name: "",
            description: "",
            updated: "2026-05-07T00:00:00Z",
        });
        cacheSession({
            kernel: "py",
            branch: "chat-abc",
            title: "Second",
            name: "Renamed",
            description: "",
            updated: "2026-05-07T00:01:00Z",
        });
        const records = loadCache();
        expect(records).toHaveLength(1);
        expect(records[0].title).toBe("Second");
        expect(records[0].name).toBe("Renamed");
    });

    it("treats (kernel, branch) as the cache key — same branch in different kernels coexists", () => {
        cacheSession({
            kernel: "py",
            branch: "chat-abc",
            title: "Py side",
            name: "",
            description: "",
            updated: "",
        });
        cacheSession({
            kernel: "ts",
            branch: "chat-abc",
            title: "Ts side",
            name: "",
            description: "",
            updated: "",
        });
        expect(loadCache()).toHaveLength(2);
    });

    it("silently ignores invalid records", () => {
        // Missing kernel
        cacheSession({ branch: "chat-x" });
        // Wrong kernel value
        cacheSession({ kernel: "wat", branch: "chat-y" });
        // Empty branch
        cacheSession({ kernel: "py", branch: "" });
        expect(loadCache()).toEqual([]);
    });

    it("removes a session", () => {
        cacheSession({
            kernel: "py",
            branch: "chat-abc",
            title: "X",
            name: "",
            description: "",
            updated: "",
        });
        cacheSession({
            kernel: "py",
            branch: "chat-def",
            title: "Y",
            name: "",
            description: "",
            updated: "",
        });
        uncacheSession("py", "chat-abc");
        const records = loadCache();
        expect(records).toHaveLength(1);
        expect(records[0].branch).toBe("chat-def");
    });

    it("uncacheSession is a no-op for unknown entries", () => {
        cacheSession({
            kernel: "py",
            branch: "chat-abc",
            title: "X",
            name: "",
            description: "",
            updated: "",
        });
        uncacheSession("ts", "chat-abc"); // wrong kernel
        uncacheSession("py", "chat-zzz"); // wrong branch
        expect(loadCache()).toHaveLength(1);
    });

    it("clearCache wipes everything", () => {
        cacheSession({
            kernel: "py",
            branch: "chat-abc",
            title: "X",
            name: "",
            description: "",
            updated: "",
        });
        clearCache();
        expect(loadCache()).toEqual([]);
    });
});

describe("reconcileWithBareNames", () => {
    const recordOf = (kernel, branch, title = "") => ({
        kernel,
        branch,
        title,
        name: "",
        description: "",
        updated: "",
    });

    it("keeps cache entries that exist in IDB", () => {
        const cached = [recordOf("py", "chat-a"), recordOf("py", "chat-b")];
        const bare = [
            { kernel: "py", branch: "chat-a" },
            { kernel: "py", branch: "chat-b" },
        ];
        const { kept, missing } = reconcileWithBareNames(cached, bare);
        expect(kept).toEqual(cached);
        expect(missing).toEqual([]);
    });

    it("drops cache entries that no longer exist in IDB", () => {
        const cached = [
            recordOf("py", "chat-a"),
            recordOf("py", "chat-deleted"),
        ];
        const bare = [{ kernel: "py", branch: "chat-a" }];
        const { kept, missing } = reconcileWithBareNames(cached, bare);
        expect(kept).toHaveLength(1);
        expect(kept[0].branch).toBe("chat-a");
        expect(missing).toEqual([]);
    });

    it("flags IDB branches not in the cache as missing", () => {
        const cached = [recordOf("py", "chat-a")];
        const bare = [
            { kernel: "py", branch: "chat-a" },
            { kernel: "py", branch: "chat-new" },
        ];
        const { kept, missing } = reconcileWithBareNames(cached, bare);
        expect(kept).toHaveLength(1);
        expect(missing).toEqual([{ kernel: "py", branch: "chat-new" }]);
    });

    it("disambiguates by kernel — same branch in different kernels is two entries", () => {
        const cached = [recordOf("py", "chat-a"), recordOf("ts", "chat-a")];
        const bare = [
            { kernel: "py", branch: "chat-a" },
            { kernel: "ts", branch: "chat-a" },
        ];
        const { kept, missing } = reconcileWithBareNames(cached, bare);
        expect(kept).toHaveLength(2);
        expect(missing).toEqual([]);
    });

    it("handles a fully fresh IDB (cache has stale entries, IDB empty)", () => {
        const cached = [recordOf("py", "chat-old")];
        const bare = [];
        const { kept, missing } = reconcileWithBareNames(cached, bare);
        expect(kept).toEqual([]);
        expect(missing).toEqual([]);
    });

    it("handles a fully fresh cache (IDB has entries, cache empty)", () => {
        const cached = [];
        const bare = [
            { kernel: "py", branch: "chat-a" },
            { kernel: "ts", branch: "chat-b" },
        ];
        const { kept, missing } = reconcileWithBareNames(cached, bare);
        expect(kept).toEqual([]);
        expect(missing).toEqual(bare);
    });
});
