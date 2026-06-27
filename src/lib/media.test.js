import { describe, it, expect, vi } from "vitest";
import { runCreateImage, runCreateMusic, runCreateSpeech } from "./media.js";
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

const AUDIO = new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]); // ID3-ish mp3 bytes
const AUDIO_B64 = bytesToBase64(AUDIO);

/** A streamed (SSE) Response stub. `events` become `data: {json}\n\n` lines
 *  followed by `data: [DONE]`. `splitAt` cuts the byte stream into two
 *  reads to exercise cross-read line buffering. */
function streamResponse(events, { splitAt } = {}) {
    const text =
        events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") +
        "data: [DONE]\n\n";
    const bytes = new TextEncoder().encode(text);
    const pieces = splitAt
        ? [bytes.slice(0, splitAt), bytes.slice(splitAt)]
        : [bytes];
    let i = 0;
    return {
        ok: true,
        body: {
            getReader: () => ({
                read: async () =>
                    i < pieces.length
                        ? { done: false, value: pieces[i++] }
                        : { done: true },
            }),
        },
    };
}

describe("runCreateMusic", () => {
    const settings = { apiKey: "sk-test" };

    it("streams, collects delta.audio.data, returns the decoded bytes", async () => {
        const fetchImpl = vi.fn(async () =>
            streamResponse([
                { choices: [{ delta: { content: "<instrumental>" } }] },
                { choices: [{ delta: { audio: { data: AUDIO_B64 } } }] },
                { choices: [{ delta: { content: "" }, finish_reason: "stop" }] },
            ]),
        );
        const out = await runCreateMusic({ prompt: "lofi", settings, fetchImpl });
        expect(out).toEqual(AUDIO);
        const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
        expect(body.stream).toBe(true);
        expect(body.modalities).toEqual(["text", "audio"]);
        expect(body.model).toBe("google/lyria-3-clip-preview");
        expect(body.messages[0].content).toBe("lofi");
    });

    it("escalates to the full (Pro) model on length:'full'", async () => {
        const fetchImpl = vi.fn(async () =>
            streamResponse([{ choices: [{ delta: { audio: { data: AUDIO_B64 } } }] }]),
        );
        await runCreateMusic({ prompt: "x", length: "full", settings, fetchImpl });
        expect(JSON.parse(fetchImpl.mock.calls[0][1].body).model).toBe(
            "google/lyria-3-pro-preview",
        );
    });

    it("concatenates audio across multiple chunks", async () => {
        const fetchImpl = vi.fn(async () =>
            streamResponse([
                { choices: [{ delta: { audio: { data: AUDIO_B64.slice(0, 4) } } }] },
                { choices: [{ delta: { audio: { data: AUDIO_B64.slice(4) } } }] },
            ]),
        );
        expect(await runCreateMusic({ prompt: "x", settings, fetchImpl })).toEqual(AUDIO);
    });

    it("survives a data: line split across two reads", async () => {
        const events = [{ choices: [{ delta: { audio: { data: AUDIO_B64 } } }] }];
        const fetchImpl = vi.fn(async () => streamResponse(events, { splitAt: 20 }));
        expect(await runCreateMusic({ prompt: "x", settings, fetchImpl })).toEqual(AUDIO);
    });

    it("throws on a stream error event", async () => {
        const fetchImpl = vi.fn(async () =>
            streamResponse([{ error: { message: "model overloaded" } }]),
        );
        await expect(
            runCreateMusic({ prompt: "x", settings, fetchImpl }),
        ).rejects.toThrow(/createMusic: model overloaded/);
    });

    it("throws when the stream carries no audio", async () => {
        const fetchImpl = vi.fn(async () =>
            streamResponse([{ choices: [{ delta: { content: "hi" } }] }]),
        );
        await expect(
            runCreateMusic({ prompt: "x", settings, fetchImpl }),
        ).rejects.toThrow(/no audio/);
    });
});

const speechResponse = (bytes = AUDIO) => ({
    ok: true,
    arrayBuffer: async () => bytes.buffer,
});

describe("runCreateSpeech", () => {
    const settings = { apiKey: "sk-test" };

    it("requests pcm from /audio/speech and wraps it as a WAV", async () => {
        const fetchImpl = vi.fn(async () => speechResponse());
        const out = await runCreateSpeech({
            text: "[whispers] hi",
            settings,
            fetchImpl,
        });
        const [url, init] = fetchImpl.mock.calls[0];
        expect(url).toBe("https://openrouter.ai/api/v1/audio/speech");
        const body = JSON.parse(init.body);
        expect(body.model).toBe("google/gemini-3.1-flash-tts-preview");
        expect(body.input).toBe("[whispers] hi");
        expect(body.voice).toBe("Kore");
        expect(body.response_format).toBe("pcm");
        // 44-byte RIFF/WAVE header wrapping the original PCM payload.
        expect(out.length).toBe(44 + AUDIO.length);
        expect(String.fromCharCode(...out.slice(0, 4))).toBe("RIFF");
        expect(String.fromCharCode(...out.slice(8, 12))).toBe("WAVE");
        expect(out.slice(44)).toEqual(AUDIO);
    });

    it("passes a custom voice", async () => {
        const fetchImpl = vi.fn(async () => speechResponse());
        await runCreateSpeech({ text: "hi", voice: "Charon", settings, fetchImpl });
        expect(JSON.parse(fetchImpl.mock.calls[0][1].body).voice).toBe("Charon");
    });

    it("throws on empty audio", async () => {
        const fetchImpl = vi.fn(async () => speechResponse(new Uint8Array(0)));
        await expect(
            runCreateSpeech({ text: "hi", settings, fetchImpl }),
        ).rejects.toThrow(/no audio/);
    });

    it("requires text and an api key", async () => {
        await expect(
            runCreateSpeech({ text: "", settings, fetchImpl: vi.fn() }),
        ).rejects.toThrow(/non-empty string/);
        await expect(
            runCreateSpeech({ text: "hi", settings: {}, fetchImpl: vi.fn() }),
        ).rejects.toThrow(/no API key/);
    });
});
