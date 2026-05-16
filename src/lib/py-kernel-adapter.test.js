/**
 * `PyKernelAdapter` shape check.
 *
 * Real adapter behavior is integration-shaped — it talks to a live
 * Pyodide worker via `runPython`. Spinning Pyodide up in a unit test
 * is too slow / fragile to be useful here. Instead we verify the
 * surface: every method named in the typedef is present and callable.
 *
 * When the Ts adapter lands (Phase 5), a parameterized conformance
 * suite will exercise actual round-trip behavior against both
 * adapters. That's the higher-leverage test layer.
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
    // Bundle payloads
    "exportBundlePayload",
    "importBundlePayload",
    "getBundleStats",
    // History rendering
    "loadHistory",
    // Query bridge
    "runQuery",
    "getCacheValue",
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
