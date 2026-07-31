/**
 * `PyKernelAdapter` shape check.
 *
 * Real adapter behavior is integration-shaped — it talks to a live
 * Pyodide worker via `runPython`. Spinning Pyodide up in a unit test
 * is too slow / fragile to be useful here. Instead we verify the
 * surface: every method named in the typedef is present and callable.
 *
 * Still open: a parameterized conformance suite exercising actual
 * round-trip behavior against both adapters (the higher-leverage test
 * layer). Both adapters exist now; this shape check and its twin in
 * ts-kernel-adapter.test.js are the current stand-in.
 */

import { describe, it, expect } from "vitest";
import { createPyAdapter } from "./py-kernel-adapter.js";

const EXPECTED_METHODS = [
    // Lifecycle
    "init",
    "dispose",
    // Branch operations
    "listBranches",
    "listBranchesWithMeta",
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
    "readAppBinaries",
    "wipeAgentMemory",
    // Bundle payloads
    "exportBundlePayload",
    "importBundlePayload",
    "getBundleStats",
    "profilePublishSizes",
    "snapshotToBranch",
    // History rendering
    "loadHistory",
    // Query bridge
    "runQuery",
    "getCacheValue",
    "spawn",
    // Token telemetry
    "estimateLogTokens",
    "getTokenHistory",
    // Debug
    "getSessionDebugInfo",
];

describe("PyKernelAdapter shape", () => {
    it("exposes the kernel discriminator as 'py'", () => {
        const adapter = createPyAdapter();
        expect(adapter.kernel).toBe("py");
    });

    it.each(EXPECTED_METHODS)(
        "exposes %s as a function",
        (method) => {
            const adapter = createPyAdapter();
            expect(typeof adapter[method]).toBe("function");
        },
    );

    it("does not expose unexpected top-level keys", () => {
        const adapter = createPyAdapter();
        const allowed = new Set(["kernel", ...EXPECTED_METHODS]);
        const extras = Object.keys(adapter).filter((k) => !allowed.has(k));
        expect(extras).toEqual([]);
    });
});
