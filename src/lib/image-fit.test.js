import { describe, expect, it } from "vitest";
import { fitPrompt, fittingImages, sizeOf } from "./image-fit.js";

/** A fit that marks what it fitted, as a smaller WebP. */
const fit = async (/** @type {{ data: string, mediaType: string }} */ image) =>
    image.data.length > 10 ? { data: "small", mediaType: "image/webp" } : image;

const prompt = [
    { role: "system", content: "Be brief." },
    {
        role: "user",
        content: [
            { type: "text", text: "Look." },
            { type: "file", mediaType: "image/png", data: "x".repeat(50) },
            { type: "file", mediaType: "application/pdf", data: "y".repeat(50) },
        ],
    },
    {
        role: "tool",
        content: [
            {
                type: "tool-result",
                toolCallId: "c1",
                toolName: "test_app",
                output: {
                    type: "content",
                    value: [
                        { type: "text", text: "screenshot 1: attached" },
                        { type: "file", mediaType: "image/png", data: { type: "data", data: "z".repeat(50) } },
                        { type: "file", mediaType: "image/png", data: { type: "data", data: "tiny" } },
                    ],
                },
            },
        ],
    },
];

describe("fitting a request's images", () => {
    it("fits every image, in a message or a tool result, and leaves the rest", async () => {
        const out = /** @type {any} */ (await fitPrompt(prompt, { fit }));
        expect(out[0]).toEqual(prompt[0]);
        expect(out[1].content[1]).toEqual({ type: "file", mediaType: "image/webp", data: "small" });
        // not an image: as it was
        expect(out[1].content[2]).toEqual(prompt[1]?.content[2]);
        const value = out[2].content[0].output.value;
        expect(value[1]).toEqual({ type: "file", mediaType: "image/webp", data: { type: "data", data: "small" } });
        // small enough: the same part
        expect(value[2]).toBe(/** @type {any} */ (prompt[2]).content[0].output.value[2]);
        // the record's own prompt isn't changed
        expect(/** @type {any} */ (prompt[1]).content[1].data).toBe("x".repeat(50));
    });

    it("wraps a model: the same model, its requests fitted", async () => {
        /** @type {any[]} */
        const seen = [];
        const model = {
            specificationVersion: "v4",
            provider: "anthropic.messages",
            modelId: "claude-x",
            doStream: async (/** @type {any} */ o) => {
                seen.push(o);
                return { stream: "s" };
            },
            doGenerate: async (/** @type {any} */ o) => {
                seen.push(o);
                return { content: [] };
            },
        };
        const wrapped = fittingImages(model);
        expect([wrapped.specificationVersion, wrapped.provider, wrapped.modelId]).toEqual(["v4", "anthropic.messages", "claude-x"]);
        const tiny = [{ role: "user", content: [{ type: "file", mediaType: "image/png", data: "tiny" }] }];
        expect(await wrapped.doStream({ prompt: tiny, maxOutputTokens: 9 })).toEqual({ stream: "s" });
        expect(seen[0]).toEqual({ prompt: tiny, maxOutputTokens: 9 });
    });

    it("fits one image at a time", async () => {
        let running = 0;
        let most = 0;
        const slow = async (/** @type {{ data: string, mediaType: string }} */ image) => {
            running += 1;
            most = Math.max(most, running);
            await new Promise((r) => setTimeout(r, 5));
            running -= 1;
            return image;
        };
        await fitPrompt(prompt, { fit: slow });
        expect(most).toBe(1);
    });
});

describe("an image's size, from its header", () => {
    const b64 = (/** @type {number[]} */ bytes) => Buffer.from(bytes).toString("base64");
    const be32 = (/** @type {number} */ n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    const le16 = (/** @type {number} */ n) => [n & 255, (n >>> 8) & 255];
    const le24 = (/** @type {number} */ n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];
    const ascii = (/** @type {string} */ t) => [...t].map((c) => c.charCodeAt(0));

    it("reads PNG and GIF", () => {
        const png = [0x89, ...ascii("PNG"), 13, 10, 26, 10, 0, 0, 0, 13, ...ascii("IHDR"), ...be32(9000), ...be32(300), 8, 6];
        expect(sizeOf(b64(png))).toEqual({ width: 9000, height: 300 });
        expect(sizeOf(b64([...ascii("GIF89a"), ...le16(640), ...le16(480), 0, 0]))).toEqual({ width: 640, height: 480 });
    });

    it("reads WebP, each kind", () => {
        const riff = (/** @type {string} */ chunk, /** @type {number[]} */ rest) => [...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP"), ...ascii(chunk), ...rest];
        const vp8x = riff("VP8X", [0, 0, 0, 0, 0, 0, 0, 0, ...le24(8999), ...le24(4999), 0, 0]);
        expect(sizeOf(b64(vp8x))).toEqual({ width: 9000, height: 5000 });
        const bits = (1919 & 0x3fff) | ((1079 & 0x3fff) << 14);
        const vp8l = riff("VP8L", [0, 0, 0, 0, 0x2f, bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255, 0, 0, 0, 0, 0]);
        expect(sizeOf(b64(vp8l))).toEqual({ width: 1920, height: 1080 });
        const vp8 = riff("VP8 ", [0, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(800), ...le16(600), 0, 0]);
        expect(sizeOf(b64(vp8))).toEqual({ width: 800, height: 600 });
    });

    it("reads a JPEG's frame header, past its other segments", () => {
        const app1 = [0xff, 0xe1, 0x00, 0x10, ...new Array(14).fill(0)];
        const sof0 = [0xff, 0xc0, 0x00, 0x11, 8, ...[0x1f, 0x40], ...[0x23, 0x28], 3, ...new Array(9).fill(0)];
        // height 8000 (0x1f40), width 9000 (0x2328)
        expect(sizeOf(b64([0xff, 0xd8, ...app1, ...sof0, 0, 0]))).toEqual({ width: 9000, height: 8000 });
    });

    it("says nothing for what it can't read", () => {
        expect(sizeOf(b64(ascii("not an image at all")))).toBeNull();
        expect(sizeOf("@@@@")).toBeNull();
    });
});
