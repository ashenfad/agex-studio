import { Repo } from "@agex-ts/kvgit";
import { Memory } from "@agex-ts/kvgit/backends/memory";
import { describe, expect, it } from "vitest";
import { BUNDLE_MAGIC, applyBundle, bundleFileName, encodeBundle, readBundleHeader } from "./bundle.js";

const enc = new TextEncoder();

/** A repo over memory with a branch `s` of two commits; its head. */
async function source() {
    const kv = new Memory();
    const repo = await Repo.open(kv);
    await repo.branches.create("s");
    const wt = await repo.worktree("s");
    wt.set("a", enc.encode("one"));
    await wt.commit({ info: { tool: "t" } });
    wt.set("b", enc.encode("two"));
    const { commit } = await wt.commit({ info: { tool: "t" } });
    return { kv, head: /** @type {string} */ (commit) };
}

describe("bundles", () => {
    it("carry a branch's history, and open as a branch elsewhere", async () => {
        const { kv, head } = await source();
        const bytes = await encodeBundle(kv, head, { title: "Two commits", shape: "everything" });
        expect(new TextDecoder().decode(bytes.subarray(0, BUNDLE_MAGIC.length))).toBe(BUNDLE_MAGIC);
        expect(readBundleHeader(bytes).header).toMatchObject({ format: 1, title: "Two commits", head, shape: "everything", commits: 3 });

        const other = new Memory();
        const repo = await Repo.open(other);
        const header = await applyBundle(other, bytes, "copy");
        expect(header.head).toBe(head);
        expect(await repo.branches.get("copy")).toBe(head);
        const snap = await repo.snapshot({ branch: "copy" });
        expect(new TextDecoder().decode(/** @type {Uint8Array} */ (await snap.get("b")))).toBe("two");
    });

    it("refuse what isn't one, naming why", async () => {
        expect(() => readBundleHeader(enc.encode("PK\x03\x04zip"))).toThrow("isn't an agex studio bundle");
        expect(() => readBundleHeader(enc.encode(`${BUNDLE_MAGIC}{"format": 1`))).toThrow("cut short");
        expect(() => readBundleHeader(enc.encode(`${BUNDLE_MAGIC}{"format": 2, "head": "x"}\n`))).toThrow("format 2");
    });

    it("are named for their session", () => {
        expect(bundleFileName("Budget: Q3 / draft!")).toBe("budget-q3-draft.agex");
        expect(bundleFileName("")).toBe("session.agex");
    });
});

describe("a snapshot", () => {
    it("keeps the files and the conversation, not the cache, the agent's git or undo points", async () => {
        const { kept } = await import("./snapshot.js");
        expect(kept("__file__/workspace/a.txt")).toBe(true);
        expect(kept("__conversation__/index")).toBe(true);
        expect(kept("__plane__/studio/meta")).toBe(true);
        expect(kept("__cache__/x")).toBe(false);
        expect(kept("__ws_git__")).toBe(false);
        expect(kept("__plane__/studio/turns/r1")).toBe(false);
    });
});
