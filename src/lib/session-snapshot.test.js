import { describe, expect, it } from "vitest";
import { Memory } from "@agex-ts/kvgit/backends/memory";
import { VersionedKV } from "@agex-ts/kvgit";
import {
    polymorphicDecoder,
    polymorphicEncoder,
} from "@agex-ts/termish/fs/kvgit";
import { bytesToBase64 } from "./bytes.js";
import {
    estimatePublishSizes,
    keyCategory,
    profileSession,
    snapshotBranch,
    transformEventImages,
} from "./session-snapshot.js";

const enc = new TextEncoder();

/** A fake "screenshot": deterministic bytes, sized to spot in sums. */
function fakeImageBytes(n) {
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i++) b[i] = i % 251;
    return b;
}

function outputEvent(parts) {
    return {
        type: "output",
        timestamp: "2026-06-12T00:00:00.000Z",
        agentName: "chat",
        parts,
    };
}

/** Build a session-shaped branch over a Memory store with raw commits
 *  (same byte-level layout the real Staged produces: encoded events
 *  under evt/, raw file bytes under f:, scratch under cache/). */
async function seedSession() {
    const store = new Memory();
    const vk = await VersionedKV.open(store, { branch: "chat-src" });

    const textEvent = polymorphicEncoder(
        outputEvent([{ type: "text", text: "hello world" }]),
    );
    const imageB64 = bytesToBase64(fakeImageBytes(900));
    const imageEvent = polymorphicEncoder(
        outputEvent([
            { type: "text", text: "see screenshot" },
            { type: "image", format: "png", data: imageB64, altText: "app view" },
        ]),
    );
    const fileV1 = enc.encode("<html>v1</html>");
    const fileV2 = enc.encode("<html>version two</html>");
    const photo = fakeImageBytes(300);
    const cacheBlob = enc.encode("llm-scratch-cache-value");
    const meta = polymorphicEncoder("My App");
    const eventLog = polymorphicEncoder(["evt/t1/0", "evt/t2/0"]);

    await vk.commit({
        updates: new Map([
            ["f:app/index.html", fileV1],
            ["__session_title__", meta],
            ["evt/t1/0", textEvent],
        ]),
    });
    await vk.commit({
        updates: new Map([
            ["f:app/index.html", fileV2], // supersedes v1 → history bytes
            ["f:photo.png", photo],
            ["evt/t2/0", imageEvent],
            ["__event_log__", eventLog],
            ["cache/llm", cacheBlob],
        ]),
    });

    return {
        store,
        vk,
        sizes: {
            textEvent: textEvent.length,
            imageEvent: imageEvent.length,
            fileV1: fileV1.length,
            fileV2: fileV2.length,
            photo: photo.length,
            cacheBlob: cacheBlob.length,
            meta: meta.length,
            eventLog: eventLog.length,
        },
        raw: { textEvent, imageEvent, fileV2, photo, eventLog, meta },
        imageB64,
    };
}

describe("keyCategory", () => {
    it("buckets keys the way the studio thinks about them", () => {
        expect(keyCategory("f:app/index.html")).toBe("files");
        expect(keyCategory("d:app")).toBe("files");
        expect(keyCategory("evt/t1/0")).toBe("chat");
        expect(keyCategory("__event_log__")).toBe("chat");
        expect(keyCategory("cache/llm")).toBe("cache");
        expect(keyCategory("__session_title__")).toBe("meta");
    });
});

describe("profileSession", () => {
    it("sums tip categories from pointer sizes and isolates history overhead", async () => {
        const { vk, sizes, imageB64 } = await seedSession();
        const profile = await profileSession(vk, "chat-src");

        expect(profile.tip.files).toBe(sizes.fileV2 + sizes.photo);
        expect(profile.tip.chat).toBe(
            sizes.textEvent + sizes.imageEvent + sizes.eventLog,
        );
        expect(profile.tip.cache).toBe(sizes.cacheBlob);
        expect(profile.tip.meta).toBe(sizes.meta);
        expect(profile.tip.total).toBe(
            profile.tip.files + profile.tip.chat + profile.tip.cache + profile.tip.meta,
        );
        // Embedded image bytes ≈ decoded base64 length (floor'd).
        expect(profile.tip.images).toBe(Math.floor((imageB64.length * 3) / 4));
        // The superseded file version is the only history-only blob.
        expect(profile.history).toBe(sizes.fileV1);
        expect(profile.total).toBe(profile.tip.total + sizes.fileV1);
    });

    it("estimates publish shapes from the profile", async () => {
        const { vk } = await seedSession();
        const profile = await profileSession(vk, "chat-src");
        const est = estimatePublishSizes(profile);
        expect(est.full).toBe(profile.total);
        expect(est.flat).toBe(profile.tip.total - profile.tip.cache);
        expect(est.flatStripped).toBe(est.flat - profile.tip.images);
        expect(est.flatDownsampled).toBeGreaterThan(est.flatStripped);
        expect(est.flatDownsampled).toBeLessThan(est.flat);
    });
});

describe("transformEventImages", () => {
    it("returns null for events without images (caller keeps original bytes)", async () => {
        const bytes = polymorphicEncoder(
            outputEvent([{ type: "text", text: "no pictures here" }]),
        );
        expect(await transformEventImages(bytes, "strip")).toBeNull();
        // Non-event values (meta strings, file records) are left alone too.
        expect(await transformEventImages(polymorphicEncoder("title"), "strip")).toBeNull();
    });

    it("strips image parts into placeholder text", async () => {
        const bytes = polymorphicEncoder(
            outputEvent([
                { type: "text", text: "before" },
                { type: "image", format: "png", data: "AAAA", altText: "chart" },
            ]),
        );
        const result = await transformEventImages(bytes, "strip");
        expect(result.count).toBe(1);
        const event = polymorphicDecoder(result.bytes);
        expect(event.parts).toEqual([
            { type: "text", text: "before" },
            { type: "text", text: "[image removed for publishing: chart]" },
        ]);
        // Non-part fields survive the rewrite.
        expect(event.agentName).toBe("chat");
    });

    it("downsamples via the injected transform, keeping parts it declines", async () => {
        const bytes = polymorphicEncoder(
            outputEvent([
                { type: "image", format: "png", data: "BIG1", altText: "a" },
                { type: "image", format: "png", data: "BIG2" },
            ]),
        );
        const shrink = async (part) =>
            part.altText === "a" ? { format: "jpeg", data: "tiny" } : null;
        const result = await transformEventImages(bytes, "downsample", shrink);
        expect(result.count).toBe(1);
        const event = polymorphicDecoder(result.bytes);
        expect(event.parts[0]).toEqual({
            type: "image",
            format: "jpeg",
            data: "tiny",
            altText: "a",
        });
        expect(event.parts[1]).toEqual({ type: "image", format: "png", data: "BIG2" });
    });

    it("returns null when every transform declines (nothing changed)", async () => {
        const bytes = polymorphicEncoder(
            outputEvent([{ type: "image", format: "png", data: "BIG" }]),
        );
        expect(await transformEventImages(bytes, "downsample", async () => null)).toBeNull();
    });
});

describe("snapshotBranch", () => {
    it("copies the tip byte-exactly into one fresh commit, dropping cache/", async () => {
        const { store, vk, raw } = await seedSession();
        const result = await snapshotBranch(vk, "chat-src", "snap-1");
        expect(result.keys).toBe(6); // 2 files + 2 events + log + meta
        expect(result.imagesTransformed).toBe(0);

        const dest = await VersionedKV.open(store, { branch: "snap-1" });
        expect(await dest.get("cache/llm")).toBeNull();
        expect(await dest.get("f:app/index.html")).toEqual(raw.fileV2);
        expect(await dest.get("f:photo.png")).toEqual(raw.photo);
        expect(await dest.get("evt/t1/0")).toEqual(raw.textEvent);
        expect(await dest.get("evt/t2/0")).toEqual(raw.imageEvent);
        expect(await dest.get("__event_log__")).toEqual(raw.eventLog);
        expect(await dest.get("__session_title__")).toEqual(raw.meta);

        // Flat: initial empty commit + the snapshot, nothing more.
        let commits = 0;
        for await (const _ of dest.history(dest.currentCommit, { allParents: true })) commits++;
        expect(commits).toBe(2);

        // Source untouched: full history still walks 3 commits.
        let srcCommits = 0;
        for await (const _ of vk.history(vk.currentCommit, { allParents: true })) srcCommits++;
        expect(srcCommits).toBe(3);
    });

    it("applies image treatment during the copy; untouched events stay byte-exact", async () => {
        const { store, vk, raw } = await seedSession();
        const result = await snapshotBranch(vk, "chat-src", "snap-2", { images: "strip" });
        expect(result.imagesTransformed).toBe(1);

        const dest = await VersionedKV.open(store, { branch: "snap-2" });
        // The image event was rewritten…
        const stripped = polymorphicDecoder(await dest.get("evt/t2/0"));
        expect(stripped.parts.some((p) => p.type === "image")).toBe(false);
        // …the text-only event is the ORIGINAL bytes, no re-encode.
        expect(await dest.get("evt/t1/0")).toEqual(raw.textEvent);
        // Profile of the snapshot shows the image bytes gone.
        const profile = await profileSession(dest, "snap-2");
        expect(profile.tip.images).toBe(0);
        expect(profile.tip.cache).toBe(0);
    });

    it("refuses to overwrite an existing destination branch", async () => {
        const { vk } = await seedSession();
        await snapshotBranch(vk, "chat-src", "snap-3");
        await expect(snapshotBranch(vk, "chat-src", "snap-3")).rejects.toThrow(
            /already exists/,
        );
    });
});
