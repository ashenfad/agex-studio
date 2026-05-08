/**
 * `TsKernelAdapter` shape check + the methods that don't depend on
 * the chat task / LLM / runtime.
 *
 * The chat-task-dependent surface (`sendMessage`, `runChaptering`,
 * `runQuery`) currently throws `not yet implemented (Phase 5 PR 2)`;
 * a small set of tests covers that contract so the throw doesn't
 * silently turn into a no-op when PR 2 lands without removing the
 * stubs.
 *
 * The richer round-trip behavior (branch ops, VFS, bundle, history,
 * telemetry) gets exercised through ts-bundle's own round-trip suite
 * and the future cross-adapter conformance tests; the adapter shape
 * check here just confirms the surface is wired.
 */

import { describe, it, expect } from "vitest";
import { createTsAdapter } from "./ts-kernel-adapter.js";

const EXPECTED_METHODS = [
    // Lifecycle
    "init",
    "dispose",
    // Branch operations
    "listBranches",
    "createBranch",
    "deleteBranch",
    "readBranchMeta",
    "writeBranchMeta",
    // Messaging
    "sendMessage",
    "runChaptering",
    // State / commits
    "getCurrentCommit",
    "undoToCommit",
    // VFS
    "listFiles",
    "readFile",
    "fileSize",
    "writeFiles",
    "deleteFiles",
    "readAppFiles",
    // Bundle payloads
    "exportBundlePayload",
    "importBundlePayload",
    "getBundleStats",
    // History rendering
    "loadHistory",
    // Query bridge
    "runQuery",
    // Token telemetry
    "estimateLogTokens",
    "getTokenHistory",
    // Debug
    "getSessionDebugInfo",
];

describe("TsKernelAdapter shape", () => {
    it("exposes the kernel discriminator as 'ts'", () => {
        const adapter = createTsAdapter();
        expect(adapter.kernel).toBe("ts");
    });

    it.each(EXPECTED_METHODS)(
        "exposes %s as a function",
        (method) => {
            const adapter = createTsAdapter();
            expect(typeof adapter[method]).toBe("function");
        },
    );

    it("does not expose unexpected top-level keys", () => {
        const adapter = createTsAdapter();
        const allowed = new Set(["kernel", ...EXPECTED_METHODS]);
        const extras = Object.keys(adapter).filter((k) => !allowed.has(k));
        expect(extras).toEqual([]);
    });

    it("matches the Py adapter's method set", async () => {
        // Cross-adapter shape-equivalence — should drift be discovered
        // via this assertion before the TS path actually breaks at
        // runtime against typedef expectations.
        const { createPyAdapter } = await import("./py-kernel-adapter.js");
        const py = createPyAdapter();
        const ts = createTsAdapter();
        const pyKeys = new Set(Object.keys(py).sort());
        const tsKeys = new Set(Object.keys(ts).sort());
        expect([...tsKeys].sort()).toEqual([...pyKeys].sort());
    });
});

describe("TsKernelAdapter PR-1-deferred contracts", () => {
    it("sendMessage throws 'not yet implemented'", async () => {
        const adapter = createTsAdapter();
        await expect(
            adapter.sendMessage("chat-x", "hi", {}),
        ).rejects.toThrow(/not yet implemented/);
    });

    it("runChaptering throws 'not yet implemented'", async () => {
        const adapter = createTsAdapter();
        await expect(adapter.runChaptering("chat-x")).rejects.toThrow(
            /not yet implemented/,
        );
    });

    it("runQuery throws 'not yet implemented'", async () => {
        const adapter = createTsAdapter();
        await expect(
            adapter.runQuery("chat-x", "1+1", null),
        ).rejects.toThrow(/not yet implemented/);
    });
});
