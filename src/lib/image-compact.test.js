import { describe, expect, it } from "vitest";
import { COMPACT_MIN, KEEP_RATIO, THUMB_QUALITY, THUMB_SIDE, compactImage, thumbnailImage } from "./image-compact.js";

const big = { data: "P".repeat(COMPACT_MIN + 1000), mediaType: "image/png" };

/** A re-encoding that answers `size` characters of WebP, and notes what it was asked. */
function reencoder(/** @type {number} */ size) {
    /** @type {{ maxSide?: number, quality?: number }[]} */
    const asked = [];
    /** @type {import("./image-compact.js").Reencode} */
    const reencode = async (_image, opts) => {
        asked.push(opts);
        return { data: "W".repeat(size), mediaType: "image/webp" };
    };
    return { reencode, asked };
}

describe("compacting an image", () => {
    it("keeps a small image as it came, without decoding it", async () => {
        const small = { data: "P".repeat(COMPACT_MIN), mediaType: "image/png" };
        const { reencode, asked } = reencoder(10);
        expect(await compactImage(small, { reencode })).toBe(small);
        expect(asked).toEqual([]);
    });

    it("keeps a large image re-encoded when that's much smaller", async () => {
        const { reencode, asked } = reencoder(1000);
        expect(await compactImage(big, { reencode })).toEqual({ data: "W".repeat(1000), mediaType: "image/webp" });
        // at full size, at the default quality
        expect(asked).toEqual([{}]);
    });

    it("keeps a large image as it came when the re-encoding saves too little", async () => {
        const { reencode } = reencoder(Math.ceil(big.data.length * KEEP_RATIO) + 1);
        expect(await compactImage(big, { reencode })).toBe(big);
    });

    it("keeps an image as it came when it can't be re-encoded", async () => {
        const reencode = async () => {
            throw new Error("no OffscreenCanvas");
        };
        expect(await compactImage(big, { reencode })).toBe(big);
    });
});

describe("a thumbnail", () => {
    it("is the image at most THUMB_SIDE across, at a lower quality", async () => {
        const { reencode, asked } = reencoder(500);
        expect(await thumbnailImage(big, { reencode })).toEqual({ data: "W".repeat(500), mediaType: "image/webp" });
        expect(asked).toEqual([{ maxSide: THUMB_SIDE, quality: THUMB_QUALITY }]);
    });

    it("isn't made of a small image", async () => {
        const small = { data: "P".repeat(100), mediaType: "image/png" };
        const { reencode, asked } = reencoder(10);
        expect(await thumbnailImage(small, { reencode })).toBe(small);
        expect(asked).toEqual([]);
    });
});
