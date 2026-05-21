/**
 * `ts-bundle` round-trip tests against a live @agex-ts/kvgit in-memory
 * store. Builds a real branch (multi-commit, multi-key), exports it,
 * imports back into a fresh store, and verifies the imported state
 * is byte-identical to the source.
 *
 * Format-shape tests (`inspectBundle` reads the manifest of either
 * kernel's output) live alongside the round-trip ones to catch
 * manifest-field drift between Py and Ts implementations.
 */

import { describe, it, expect } from "vitest";
import { Memory } from "@agex-ts/kvgit/backends/memory";
import { Staged, VersionedKV } from "@agex-ts/kvgit";
import { exportBundle, importBundle, inspectBundle, bundleStats } from "./ts-bundle.js";

async function _newSession() {
    const store = new Memory();
    const versioned = await VersionedKV.open(store);
    const staged = new Staged(versioned);
    return { store, versioned, staged };
}

async function _writeAndCommit(staged, entries, info = undefined) {
    for (const [k, v] of Object.entries(entries)) {
        staged.set(k, v);
    }
    return staged.commit(info ? { info } : {});
}

describe("ts-bundle round-trip", () => {
    it("exports an empty branch and round-trips", async () => {
        const src = await _newSession();
        // VersionedKV.open seeds an initial commit on the default
        // branch — that's the branch we'll export.
        const branch = src.versioned.currentBranch;

        const { bytes, manifest } = await exportBundle(
            src.versioned,
            branch,
            { kernel: "ts" },
        );
        expect(manifest.kernel).toBe("ts");
        expect(manifest.format_version).toBe(1);
        expect(manifest.stats.commits).toBeGreaterThanOrEqual(1);

        const dst = await _newSession();
        const { branch: imported } = await importBundle(dst.versioned, bytes);
        expect(imported).toMatch(/^chat-[a-f0-9]{8}$/);
        // After import, the dst store has the imported branch HEAD.
        const headRaw = await dst.store.get(`__branch_head__${imported}`);
        expect(headRaw).not.toBeNull();
    });

    it("round-trips a multi-commit branch with many keys", async () => {
        const src = await _newSession();
        const branch = src.versioned.currentBranch;

        // Three commits, each touching different keys.  Builds a
        // history that exercises HAMT-node sharing across commits.
        await _writeAndCommit(src.staged, {
            "user/alice": { age: 30, role: "engineer" },
            "user/bob": { age: 25, role: "designer" },
            "config/theme": "dark",
        });
        await _writeAndCommit(src.staged, {
            "user/carol": { age: 40, role: "manager" },
            "config/locale": "en-US",
        });
        await _writeAndCommit(src.staged, {
            "user/alice": { age: 31, role: "engineer", title: "senior" },
        });

        const headBefore = src.versioned.currentCommit;

        const { bytes, manifest } = await exportBundle(
            src.versioned,
            branch,
            { kernel: "ts", name: "test session" },
        );
        // 4 commits including the initial seed
        expect(manifest.stats.commits).toBe(4);
        expect(manifest.head).toBe(headBefore);

        const dst = await _newSession();
        await importBundle(dst.versioned, bytes, { branchName: "imported-test" });

        // Read every key through the imported branch and verify
        // values match.
        await dst.versioned.switchBranch("imported-test");
        const dstStaged = new Staged(dst.versioned);
        for (const key of [
            "user/alice", "user/bob", "user/carol",
            "config/theme", "config/locale",
        ]) {
            const srcVal = await src.staged.get(key);
            const dstVal = await dstStaged.get(key);
            expect(dstVal).toEqual(srcVal);
        }
    });

    it("re-importing the same bundle yields a different branch but identical content", async () => {
        const src = await _newSession();
        await _writeAndCommit(src.staged, { "key": "value" });
        const { bytes } = await exportBundle(
            src.versioned,
            src.versioned.currentBranch,
            { kernel: "ts" },
        );

        const dst = await _newSession();
        const { branch: b1 } = await importBundle(dst.versioned, bytes);
        const { branch: b2 } = await importBundle(dst.versioned, bytes);
        expect(b1).not.toBe(b2);

        // Both branches point at the same HEAD (content-addressed).
        const head1 = await dst.store.get(`__branch_head__${b1}`);
        const head2 = await dst.store.get(`__branch_head__${b2}`);
        expect(head1).not.toBeNull();
        expect(head2).not.toBeNull();
        expect(head1).toEqual(head2);
    });

    it("exports the chat- prefix shape for fresh-import branch names", async () => {
        const src = await _newSession();
        const { bytes } = await exportBundle(
            src.versioned,
            src.versioned.currentBranch,
            { kernel: "ts" },
        );
        const dst = await _newSession();
        const { branch } = await importBundle(dst.versioned, bytes);
        expect(branch).toMatch(/^chat-[a-f0-9]{8}$/);
    });

    it("honors an explicit branchName on import", async () => {
        const src = await _newSession();
        const { bytes } = await exportBundle(
            src.versioned,
            src.versioned.currentBranch,
            { kernel: "ts" },
        );
        const dst = await _newSession();
        const { branch } = await importBundle(dst.versioned, bytes, {
            branchName: "my-named-branch",
        });
        expect(branch).toBe("my-named-branch");
    });
});

describe("ts-bundle.inspectBundle", () => {
    it("reads manifest fields without touching the store", async () => {
        const src = await _newSession();
        const { bytes } = await exportBundle(
            src.versioned,
            src.versioned.currentBranch,
            {
                kernel: "ts",
                name: "Q1 analysis",
                description: "Quarterly numbers",
                author: "alice",
            },
        );
        const m = inspectBundle(bytes);
        expect(m.name).toBe("Q1 analysis");
        expect(m.description).toBe("Quarterly numbers");
        expect(m.author).toBe("alice");
        expect(m.kernel).toBe("ts");
        expect(m.runtime_version).toBe("agex-studio-v1");
        expect(typeof m.created_at).toBe("number");
    });

    it("throws on a non-bundle blob", () => {
        expect(() => inspectBundle(new Uint8Array([1, 2, 3, 4])))
            .toThrow();
    });
});

describe("ts-bundle.bundleStats", () => {
    it("counts commits without doing the HAMT walk", async () => {
        const src = await _newSession();
        const branch = src.versioned.currentBranch;
        await _writeAndCommit(src.staged, { a: 1 });
        await _writeAndCommit(src.staged, { b: 2 });

        const stats = await bundleStats(src.versioned, branch);
        expect(stats.branch).toBe(branch);
        expect(stats.commits).toBe(3);  // initial + 2
        expect(stats.head).toBe(src.versioned.currentCommit);
    });

    it("rejects unknown branches", async () => {
        const src = await _newSession();
        await expect(bundleStats(src.versioned, "nonexistent"))
            .rejects.toThrow(/branch not found/);
    });
});
