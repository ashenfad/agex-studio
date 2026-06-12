import { describe, expect, it } from "vitest";
import { downsampleImagePart } from "./image-downsample.js";

describe("downsampleImagePart", () => {
    it("declines gracefully when canvas APIs are unavailable (jsdom)", async () => {
        // jsdom has neither createImageBitmap nor OffscreenCanvas; the
        // transform must return null so callers keep the original part
        // rather than throwing mid-snapshot.
        expect(typeof globalThis.createImageBitmap).not.toBe("function");
        const result = await downsampleImagePart({ format: "png", data: "AAAA" });
        expect(result).toBeNull();
    });
});
