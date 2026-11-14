import { walkDelta } from "@agex-ts/kvgit";
import { Memory } from "@agex-ts/kvgit/backends/memory";
import { Store } from "@agex-ts/world";
import { describe, expect, it } from "vitest";
import { compactConversation, snapshotBranch, snapshotParts } from "./snapshot.js";

/** @param {string} data */
const image = (data) => ({ kind: "image", data, mediaType: "image/png" });

/** A tool call's message and its result's, the result with `images`.
 *  @param {string} id @param {string[]} images */
const call = (id, images) => [
    { id: `${id}-call`, role: "assistant", parts: [{ kind: "tool_call", callId: id, name: "test_app", args: {} }] },
    { id: `${id}-result`, role: "tool", parts: [{ kind: "tool_result", callId: id, name: "test_app", content: "screenshot 1: attached", images: images.map(image) }] },
];

/** A conversation of two runs, with the folds given: run r1 has screenshots
 *  A and B, run r2 has C; and a file beside it.
 *  @param {Record<string, unknown>[]} folds */
function conversation(folds = []) {
    /** @type {Map<string, unknown>} */
    const values = new Map();
    values.set("__conversation__/index", { format: 1, harness: "agex", session: "s", runs: ["r1", "r2"], forkedFrom: null });
    values.set("__conversation__/runs/r1", {
        format: 1,
        runId: "r1",
        status: "completed",
        messages: [{ id: "u1", role: "user", parts: [{ kind: "text", text: "Make a map." }] }, ...call("a", ["A"]), ...call("b", ["B"])],
    });
    values.set("__conversation__/runs/r2", {
        format: 1,
        runId: "r2",
        status: "completed",
        messages: [{ id: "u2", role: "user", parts: [{ kind: "text", text: "Again." }] }, ...call("c", ["C"])],
    });
    folds.forEach((fold, i) => values.set(`__compaction__/fold/${String(i + 1).padStart(6, "0")}`, { summary: "so far", runs: 1, first: null, ...fold }));
    values.set("__file__/workspace/a.txt", new TextEncoder().encode("hi"));
    return values;
}

const compact = async (/** @type {{ data: string, mediaType: string }} */ img) => ({ data: `compact ${img.data}`, mediaType: "image/webp" });
const thumbnail = async (/** @type {{ data: string, mediaType: string }} */ img) => ({ data: `thumb ${img.data}`, mediaType: "image/webp" });

/** Each run's images' data, by run. @param {Map<string, unknown>} values */
const imagesOf = (values) =>
    Object.fromEntries(
        ["r1", "r2"].map((id) => [
            id,
            /** @type {any} */ (values.get(`__conversation__/runs/${id}`)).messages.flatMap((/** @type {any} */ m) =>
                m.parts.flatMap((/** @type {any} */ p) => (p.images ?? []).map((/** @type {any} */ i) => `${i.data} (${i.mediaType})`)),
            ),
        ]),
    );

describe("a snapshot's conversation", () => {
    it("thumbnails the images the fold in force covers, and compacts the rest", async () => {
        // the second fold covers through b's result: r1 whole
        const out = await compactConversation(conversation([{ through: "a-result" }, { through: "b-result" }]), { compact, thumbnail });
        expect(imagesOf(out)).toEqual({
            r1: ["thumb A (image/webp)", "thumb B (image/webp)"],
            r2: ["compact C (image/webp)"],
        });
    });

    it("covers from the start through the anchor, within a run", async () => {
        const out = await compactConversation(conversation([{ through: "a-result" }]), { compact, thumbnail });
        expect(imagesOf(out)).toEqual({
            r1: ["thumb A (image/webp)", "compact B (image/webp)"],
            r2: ["compact C (image/webp)"],
        });
    });

    it("covers a chapter from its first message", async () => {
        const out = await compactConversation(conversation([{ first: "b-call", through: "c-result" }]), { compact, thumbnail });
        expect(imagesOf(out)).toEqual({
            r1: ["compact A (image/webp)", "thumb B (image/webp)"],
            r2: ["thumb C (image/webp)"],
        });
    });

    it("thumbnails nothing when no fold is in force", async () => {
        // an anchor no message here has: the fold isn't in force, so the model is sent everything
        for (const folds of [[], [{ through: "gone" }]]) {
            const out = await compactConversation(conversation(folds), { compact, thumbnail });
            expect(imagesOf(out)).toEqual({
                r1: ["compact A (image/webp)", "compact B (image/webp)"],
                r2: ["compact C (image/webp)"],
            });
        }
    });

    it("leaves everything else as it was, and a run whose images stay keeps its body", async () => {
        const values = conversation();
        const same = async (/** @type {{ data: string, mediaType: string }} */ img) => (img.data === "C" ? img : compact(img));
        const out = await compactConversation(values, { compact: same, thumbnail });
        expect(out).not.toBe(values);
        expect(out.get("__conversation__/runs/r2")).toBe(values.get("__conversation__/runs/r2"));
        expect(out.get("__conversation__/index")).toBe(values.get("__conversation__/index"));
        expect(out.get("__file__/workspace/a.txt")).toBe(values.get("__file__/workspace/a.txt"));
        // the run that changed keeps every field and message but the images
        const before = /** @type {any} */ (values.get("__conversation__/runs/r1"));
        const after = /** @type {any} */ (out.get("__conversation__/runs/r1"));
        expect({ ...after, messages: undefined }).toEqual({ ...before, messages: undefined });
        expect(after.messages[0]).toBe(before.messages[0]);
        expect(after.messages[2].parts[0]).toEqual({ ...before.messages[2].parts[0], images: [{ kind: "image", data: "compact A", mediaType: "image/webp" }] });
        // the values it was given aren't changed
        expect(imagesOf(values).r1).toEqual(["A (image/png)", "B (image/png)"]);
    });

    it("is the values as they were without a conversation", async () => {
        const values = new Map([["__file__/workspace/a.txt", new Uint8Array([1])]]);
        expect(await compactConversation(values, { compact, thumbnail })).toBe(values);
    });
});

/** A session "s" holding `conversation` (folded through a's result),
 *  a cache entry, and `files` beside a.txt; the store and its head.
 *  @param {Record<string, Uint8Array>} [files] */
async function session(files = {}) {
    const store = await Store.open(new Memory());
    await store.repo.branches.create("s");
    const wt = await store.repo.worktree("s");
    for (const [key, value] of conversation([{ through: "a-result" }])) wt.set(key, value);
    for (const [path, bytes] of Object.entries(files)) wt.set(`__file__/workspace/${path}`, bytes);
    wt.set("__cache__/x", "rebuilds");
    const { commit } = await wt.commit({ info: { tool: "t" } });
    return { store, commit: /** @type {string} */ (commit) };
}

/** The commits from the root to `head`, as a sync or a bundle carries them.
 *  @param {Store} store @param {string} head */
async function commitsTo(store, head) {
    /** @type {import("@agex-ts/kvgit").WireCommit[]} */
    const out = [];
    for await (const wc of walkDelta(store.repo.store, { want: head })) out.push(wc);
    return out;
}

describe("snapshotBranch", () => {
    it("makes one commit from the root, its conversation's images made small, without the cache", async () => {
        const { store, commit } = await session();
        const head = await snapshotBranch(store, commit, "s.snap", { session: "s" }, { compact, thumbnail });
        const snap = await store.repo.snapshot({ commit: head });
        const keys = await snap.keys();
        expect(keys).not.toContain("__cache__/x");
        expect(keys).toContain("__file__/workspace/a.txt");
        expect(imagesOf(await snap.getMany(keys))).toEqual({
            r1: ["thumb A (image/webp)", "compact B (image/webp)"],
            r2: ["compact C (image/webp)"],
        });
        // the root, then the snapshot: no parts to count
        const commits = await commitsTo(store, head);
        expect(commits).toHaveLength(2);
        expect(commits[1].info).toEqual({ tool: "studio.snapshot", from: commit, session: "s" });
    });

    it("writes a snapshot past the part size as commits that each fit, files first and the index last", async () => {
        const files = Object.fromEntries([1, 2, 3, 4, 5].map((i) => [`f${i}.bin`, new Uint8Array(300).fill(i)]));
        const { store, commit } = await session(files);
        const head = await snapshotBranch(store, commit, "s.snap", { session: "s" }, { compact, thumbnail, partBytes: 700 });

        const parts = (await commitsTo(store, head)).slice(1);
        expect(parts.length).toBeGreaterThan(2);
        parts.forEach((wc, i) => {
            expect(wc.info).toEqual({ tool: "studio.snapshot", from: commit, session: "s", part: `${i + 1}/${parts.length}` });
            // within the limit, or one value alone
            const sizes = [...wc.updates.values()].map((v) => v.length);
            if (sizes.length > 1) expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(700);
        });
        /** The part that adds `key`. @param {string} key */
        const partOf = (key) => parts.findIndex((wc) => wc.updates.has(key));
        const fileParts = Object.keys(files).map((path) => partOf(`__file__/workspace/${path}`));
        const runParts = ["r1", "r2"].map((id) => partOf(`__conversation__/runs/${id}`));
        expect(Math.max(...fileParts)).toBeLessThanOrEqual(Math.min(...runParts));
        expect(Math.max(...runParts)).toBeLessThanOrEqual(partOf("__conversation__/index"));
        expect(partOf("__conversation__/index")).toBe(parts.length - 1);

        // the last holds the whole snapshot, the same as one commit would
        const whole = await snapshotBranch(store, commit, "s.whole", { session: "s" }, { compact, thumbnail });
        const [a, b] = [await store.repo.snapshot({ commit: head }), await store.repo.snapshot({ commit: whole })];
        const keys = await b.keys();
        expect((await a.keys()).sort()).toEqual([...keys].sort());
        expect(await a.getMany(keys)).toEqual(await b.getMany(keys));
    });
});

describe("snapshotParts", () => {
    const size = (/** @type {unknown} */ v) => /** @type {number} */ (v);

    it("puts the files first, the runs next and the rest last, each in key order", () => {
        const values = new Map(
            ["__plane__/studio/meta", "__conversation__/runs/b", "__file__/workspace/z", "__conversation__/index", "__meta__/workspace/z", "__conversation__/runs/a", "__file__/workspace/a"].map((k) => [k, 1]),
        );
        expect(snapshotParts(values, size, 100)).toEqual([
            ["__file__/workspace/a", "__file__/workspace/z", "__meta__/workspace/z", "__conversation__/runs/a", "__conversation__/runs/b", "__conversation__/index", "__plane__/studio/meta"],
        ]);
    });

    it("starts a part where the next value would pass the limit, and gives a larger value a part of its own", () => {
        const values = new Map([
            ["__file__/workspace/a", 4],
            ["__file__/workspace/b", 4],
            ["__file__/workspace/big", 25],
            ["__file__/workspace/c", 2],
            ["__conversation__/index", 1],
        ]);
        expect(snapshotParts(values, size, 10)).toEqual([["__file__/workspace/a", "__file__/workspace/b"], ["__file__/workspace/big"], ["__file__/workspace/c", "__conversation__/index"]]);
    });

    it("is one empty part for no values", () => {
        expect(snapshotParts(new Map(), size, 10)).toEqual([[]]);
    });
});
