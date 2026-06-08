import { describe, it, expect, vi, beforeEach } from "vitest";

// sessions.js reads localStorage at import (cold-start session cache) and
// the gist-info helpers read/write it, so stub it over a plain object.
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

beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
});

async function load() {
    return await import("./sessions.js");
}

describe("session gist-info round-trip", () => {
    it("returns null for a branch that was never published", async () => {
        const { getSessionGistInfo } = await load();
        expect(getSessionGistInfo("chat-abc")).toBe(null);
    });

    it("round-trips gistId / slug / lastPublishedAt", async () => {
        const { getSessionGistInfo, setSessionGistInfo } = await load();
        const info = {
            gistId: "deadbeef",
            slug: "my-app",
            lastPublishedAt: "2026-06-08T00:00:00.000Z",
        };
        setSessionGistInfo("chat-1", info);
        expect(getSessionGistInfo("chat-1")).toEqual(info);
    });

    it("round-trips the `inherited` flag (fresh-fork provenance)", async () => {
        const { getSessionGistInfo, setSessionGistInfo } = await load();
        setSessionGistInfo("chat-fork", {
            gistId: "abc123",
            slug: "forked",
            inherited: true,
        });
        expect(getSessionGistInfo("chat-fork").inherited).toBe(true);
    });

    it("keeps mappings per-branch (no cross-talk)", async () => {
        const { getSessionGistInfo, setSessionGistInfo } = await load();
        setSessionGistInfo("chat-a", { gistId: "aaa", slug: "a" });
        setSessionGistInfo("chat-b", { gistId: "bbb", slug: "b", inherited: true });
        expect(getSessionGistInfo("chat-a")).toEqual({ gistId: "aaa", slug: "a" });
        expect(getSessionGistInfo("chat-b").gistId).toBe("bbb");
        expect(getSessionGistInfo("chat-b").inherited).toBe(true);
    });

    it("clearSessionGistInfo removes the mapping", async () => {
        const { getSessionGistInfo, setSessionGistInfo, clearSessionGistInfo } =
            await load();
        setSessionGistInfo("chat-2", { gistId: "x", slug: "y" });
        clearSessionGistInfo("chat-2");
        expect(getSessionGistInfo("chat-2")).toBe(null);
    });

    it("treats malformed / gistId-less entries as no mapping", async () => {
        const { getSessionGistInfo } = await load();
        store["agex-session-gist-bad-json"] = "{not json";
        store["agex-session-gist-no-id"] = JSON.stringify({ slug: "x" });
        expect(getSessionGistInfo("bad-json")).toBe(null);
        expect(getSessionGistInfo("no-id")).toBe(null);
    });

    it("is a no-op (no throw) for falsy branch / info", async () => {
        const { getSessionGistInfo, setSessionGistInfo } = await load();
        expect(() => setSessionGistInfo("", { gistId: "z" })).not.toThrow();
        expect(() => setSessionGistInfo("chat-3", null)).not.toThrow();
        expect(getSessionGistInfo("")).toBe(null);
        expect(getSessionGistInfo("chat-3")).toBe(null);
    });
});
