import { describe, it, expect, vi } from "vitest";
import { runCreateImage } from "./media.js";
import { bytesToBase64 } from "./bytes.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const DATA_URL = `data:image/png;base64,${bytesToBase64(PNG)}`;
const settings = { apiKey: "sk-test" };

const okResponse = (url = DATA_URL) => ({
    ok: true,
    json: async () => ({
        choices: [{ message: { images: [{ image_url: { url } }] } }],
    }),
});
const bodyOf = (fetchMock) => JSON.parse(fetchMock.mock.calls[0][1].body);

describe("runCreateImage", () => {
    it("returns the generated image bytes from a data: URL", async () => {
        const fetchImpl = vi.fn(async () => okResponse());
        const out = await runCreateImage({ prompt: "a castle", settings, fetchImpl });
        expect(out).toEqual(PNG);
    });

    it("posts the prompt as a text content part, standard model + image modality", async () => {
        const fetchImpl = vi.fn(async () => okResponse());
        await runCreateImage({ prompt: "a castle", settings, fetchImpl });
        const body = bodyOf(fetchImpl);
        expect(body.model).toBe("google/gemini-3.1-flash-image");
        expect(body.modalities).toEqual(["image", "text"]);
        expect(body.messages[0].content).toEqual([{ type: "text", text: "a castle" }]);
        expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe("Bearer sk-test");
    });

    it("escalates to the pro model on quality:'high'", async () => {
        const fetchImpl = vi.fn(async () => okResponse());
        await runCreateImage({ prompt: "x", quality: "high", settings, fetchImpl });
        expect(bodyOf(fetchImpl).model).toBe("google/gemini-3-pro-image-preview");
    });

    it("sends input images as image_url parts (edit / compose), sniffing mime", async () => {
        const fetchImpl = vi.fn(async () => okResponse());
        const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9]);
        await runCreateImage({ prompt: "recolor", image: [PNG, jpeg], settings, fetchImpl });
        const content = bodyOf(fetchImpl).messages[0].content;
        expect(content[0]).toEqual({ type: "text", text: "recolor" });
        expect(content[1].image_url.url).toMatch(/^data:image\/png;base64,/);
        expect(content[2].image_url.url).toMatch(/^data:image\/jpeg;base64,/);
    });

    it("accepts a single Uint8Array for image (not just an array)", async () => {
        const fetchImpl = vi.fn(async () => okResponse());
        await runCreateImage({ prompt: "edit", image: PNG, settings, fetchImpl });
        expect(bodyOf(fetchImpl).messages[0].content).toHaveLength(2);
    });

    it("throws a labelled 401 that points at OpenRouter", async () => {
        const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, statusText: "Unauthorized" }));
        await expect(
            runCreateImage({ prompt: "x", settings, fetchImpl }),
        ).rejects.toThrow(/createImage: HTTP 401.*OpenRouter/s);
    });

    it("throws when the response carries no image", async () => {
        const fetchImpl = vi.fn(async () => ({
            ok: true,
            json: async () => ({ choices: [{ message: { content: "no image" } }] }),
        }));
        await expect(
            runCreateImage({ prompt: "x", settings, fetchImpl }),
        ).rejects.toThrow(/no image in response/);
    });

    it("requires a prompt and an api key", async () => {
        await expect(
            runCreateImage({ prompt: "", settings, fetchImpl: vi.fn() }),
        ).rejects.toThrow(/non-empty string/);
        await expect(
            runCreateImage({ prompt: "x", settings: {}, fetchImpl: vi.fn() }),
        ).rejects.toThrow(/no API key/);
    });
});
