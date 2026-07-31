/**
 * End-to-end tests for the per-branch agent pool.
 *
 * Drives the REAL kernel path — `createTsAdapter` → `ts-agent` pool →
 * agex-ts agent → eval runtime → kvgit-backed state — but with test
 * doubles injected via `_configureForTesting`:
 *   - `evalRuntime` instead of the Web Worker (agent code runs in-process)
 *   - a scripted `Dummy` LLM per branch (no tokens, deterministic)
 *   - a single shared in-memory kvgit store (no IndexedDB)
 *
 * This is the behavioral net the pool refactor otherwise lacks: it
 * exercises persistence round-trips, two-session isolation, and — the
 * whole point of the pool — concurrent turns on different sessions
 * landing on their own branches without cross-talk.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Dummy } from "agex-ts/llm-dummy";
import { evalRuntime } from "agex-ts/runtime-eval";
import { Memory } from "@agex-ts/kvgit/backends/memory";
import { _configureForTesting, _resetForTesting } from "./ts-agent.js";
import { createTsAdapter } from "./ts-kernel-adapter.js";

/** A scripted LLM whose single turn echoes the branch into the result,
 *  so we can assert which session produced which reply. */
function dummyFor(branch) {
    return new Dummy({
        responses: [
            {
                emissions: [
                    {
                        type: "ts",
                        code: `taskSuccess(${JSON.stringify(`reply:${branch}`)})`,
                    },
                ],
            },
        ],
    });
}

/** Boot an adapter wired to the in-process doubles. One shared Memory
 *  store across all branches (the pool's shared substrate). */
async function bootAdapter() {
    const store = new Memory();
    _configureForTesting({
        makeStore: () => store,
        makeRuntime: () => evalRuntime(),
        makeLlm: (branch) => dummyFor(branch),
    });
    const adapter = createTsAdapter();
    await adapter.init({ apiKey: "test", model: "dummy", chapteringTrigger: 1e9 });
    return adapter;
}

/** Flatten a loaded-history message to comparable text. */
function textOf(msg) {
    const c = msg.content;
    if (typeof c === "string") return c;
    if (c && typeof c === "object") {
        if (typeof c.content === "string") return c.content;
        if (Array.isArray(c.parts)) {
            return c.parts.map((p) => p.content ?? "").join(" ");
        }
    }
    return "";
}

beforeEach(() => {
    _resetForTesting();
});
afterEach(() => {
    _resetForTesting();
});

describe("agent pool — persistence round-trip", () => {
    it("a turn's user message + agent reply survive into loadHistory", async () => {
        const adapter = await bootAdapter();
        await adapter.createBranch("chat-a");
        const resp = await adapter.sendMessage("chat-a", "hello", {});
        expect(resp.result).toEqual({ type: "text", content: "reply:chat-a" });

        const msgs = await adapter.loadHistory("chat-a");
        const user = msgs.find((m) => m.role === "user");
        const agent = msgs.find((m) => m.role === "agent");
        expect(textOf(user)).toBe("hello");
        expect(textOf(agent)).toBe("reply:chat-a");
    });
});

describe("agent pool — session isolation", () => {
    it("sequential turns on two sessions stay on their own branches", async () => {
        const adapter = await bootAdapter();
        await adapter.createBranch("chat-a");
        await adapter.createBranch("chat-b");
        await adapter.sendMessage("chat-a", "to A", {});
        await adapter.sendMessage("chat-b", "to B", {});

        const a = (await adapter.loadHistory("chat-a")).map(textOf).join("\n");
        const b = (await adapter.loadHistory("chat-b")).map(textOf).join("\n");
        expect(a).toContain("to A");
        expect(a).toContain("reply:chat-a");
        expect(a).not.toContain("to B");
        expect(b).toContain("to B");
        expect(b).toContain("reply:chat-b");
        expect(b).not.toContain("to A");
    });

    it("CONCURRENT turns on two sessions don't cross-talk", async () => {
        const adapter = await bootAdapter();
        await adapter.createBranch("chat-a");
        await adapter.createBranch("chat-b");

        // Both turns in flight at once — distinct agents + workers (here,
        // eval runtimes) over the one shared store.
        const [ra, rb] = await Promise.all([
            adapter.sendMessage("chat-a", "q-a", {}),
            adapter.sendMessage("chat-b", "q-b", {}),
        ]);
        expect(ra.result).toEqual({ type: "text", content: "reply:chat-a" });
        expect(rb.result).toEqual({ type: "text", content: "reply:chat-b" });

        const a = (await adapter.loadHistory("chat-a")).map(textOf).join("\n");
        const b = (await adapter.loadHistory("chat-b")).map(textOf).join("\n");
        expect(a).toContain("q-a");
        expect(a).not.toContain("q-b");
        expect(b).toContain("q-b");
        expect(b).not.toContain("q-a");
    });
});

describe("agent pool — undo", () => {
    it("rewinds a session to a prior commit without touching others", async () => {
        const adapter = await bootAdapter();
        await adapter.createBranch("chat-a");
        await adapter.createBranch("chat-b");

        await adapter.sendMessage("chat-a", "first", {});
        const afterFirst = await adapter.getCurrentCommit("chat-a");
        await adapter.sendMessage("chat-a", "second", {});
        await adapter.sendMessage("chat-b", "b-turn", {});

        // Two user turns on A before undo.
        const before = (await adapter.loadHistory("chat-a")).filter(
            (m) => m.role === "user",
        );
        expect(before.length).toBe(2);

        await adapter.undoToCommit("chat-a", afterFirst);

        const after = (await adapter.loadHistory("chat-a")).filter(
            (m) => m.role === "user",
        );
        expect(after.length).toBe(1);
        expect(textOf(after[0])).toBe("first");

        // B is unaffected by A's undo.
        const b = (await adapter.loadHistory("chat-b")).map(textOf).join("\n");
        expect(b).toContain("b-turn");
    });
});

describe("agent pool — branch lifecycle", () => {
    it("lists created branches and deletes them", async () => {
        const adapter = await bootAdapter();
        await adapter.createBranch("chat-a");
        await adapter.createBranch("chat-b");
        await adapter.sendMessage("chat-a", "hi", {});

        let branches = await adapter.listBranches();
        expect(branches.sort()).toEqual(["chat-a", "chat-b"]);

        await adapter.deleteBranch("chat-a");
        branches = await adapter.listBranches();
        expect(branches).toEqual(["chat-b"]);
    });
});
