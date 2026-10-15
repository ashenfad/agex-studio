import { describe, expect, it } from "vitest";
import { fitPrompt, fittingImages } from "./image-fit.js";

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
});
