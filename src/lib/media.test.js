import { beforeEach, describe, expect, it } from "vitest";
import { bytesToBase64 } from "./bytes.js";
import { IMAGE_MODEL, MUSIC_MODELS, Media, gatherStream, lyricsOf, mp3Seconds, pcmFormat, pngFacts, wav } from "./media.js";
import { updateSettings } from "./settings.js";

/** A workspace's filesystem in memory: enough of one for `media`. */
function fakeWs() {
    /** @type {Map<string, Uint8Array>} */
    const files = new Map();
    /** @type {string[]} */
    const dirs = [];
    const fs = {
        async mkdir(/** @type {string} */ path) {
            dirs.push(path);
        },
        async write(/** @type {string} */ path, /** @type {Uint8Array} */ data) {
            files.set(path, data);
        },
        async read(/** @type {string} */ path) {
            const data = files.get(path);
            if (data === undefined) throw new Error(`ENOENT: ${path}`);
            return data;
        },
    };
    const ws = /** @type {any} */ ({ root: "/workspace", files: { fs } });
    return { ws, files, dirs };
}

/** A PNG's signature and IHDR: `width` x `height`, colour type `type`. */
function png(width, height, type) {
    const out = new Uint8Array(33);
    out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    const view = new DataView(out.buffer);
    view.setUint32(16, width);
    view.setUint32(20, height);
    out[24] = 8;
    out[25] = type;
    return out;
}

/** `n` MPEG-1 Layer III frames at 128kbps, 44.1kHz (417 bytes each). */
function mp3(n) {
    const size = 417;
    const out = new Uint8Array(size * n);
    for (let i = 0; i < n; i++) out.set([0xff, 0xfb, 0x90, 0x00], i * size);
    return out;
}

/** A fetch answering with `make(url, body)`; what it was sent, kept. */
function stub(make) {
    /** @type {{ url: string, body: any }[]} */
    const sent = [];
    const fetchImpl = /** @type {any} */ (
        async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
            const body = JSON.parse(String(init.body));
            sent.push({ url, body });
            return make(url, body);
        }
    );
    return { fetchImpl, sent };
}

beforeEach(() => updateSettings({ accessMode: "openrouter", apiKey: "sk-test" }));

describe("the file facts", () => {
    it("reads a PNG's size and alpha", () => {
        expect(pngFacts(png(640, 480, 6))).toEqual({ width: 640, height: 480, alpha: true });
        expect(pngFacts(png(10, 20, 2))).toEqual({ width: 10, height: 20, alpha: false });
        expect(pngFacts(new Uint8Array([1, 2, 3]))).toEqual({ width: null, height: null, alpha: null });
    });

    it("reads PCM's format, wraps it as WAV", () => {
        expect(pcmFormat("audio/pcm;rate=16000;channels=2")).toEqual({ rate: 16000, channels: 2 });
        expect(pcmFormat("audio/pcm")).toEqual({ rate: 24000, channels: 1 });
        const out = wav(new Uint8Array(480), 24000, 1);
        expect(out.length).toBe(524);
        expect(new TextDecoder().decode(out.subarray(0, 4))).toBe("RIFF");
        expect(new DataView(out.buffer).getUint32(24, true)).toBe(24000);
    });

    it("times an MP3 by its frames, past an ID3 tag and an Info frame", () => {
        expect(mp3Seconds(mp3(100))).toBeCloseTo((100 * 1152) / 44100, 2);
        const tagged = new Uint8Array(20 + 417 * 3);
        tagged.set([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 10]);
        tagged.set(mp3(3), 20);
        tagged.set(new TextEncoder().encode("Info"), 20 + 36);
        expect(mp3Seconds(tagged)).toBeCloseTo((2 * 1152) / 44100, 2);
        expect(mp3Seconds(new Uint8Array(10))).toBeNull();
    });

    it("reads lyrics, timed and not", () => {
        expect(lyricsOf("[[A0]]\n[0.5:] First line\n[:] Untimed one \n<instrumental>")).toEqual([
            { at: 0.5, line: "First line" },
            { at: null, line: "Untimed one" },
        ]);
    });

    it("gathers a streamed answer's audio, text and usage", async () => {
        const audio = bytesToBase64(new Uint8Array([1, 2, 3, 4, 5, 6]));
        const lines = [
            `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: audio.slice(0, 4) } } }] })}`,
            ": keepalive",
            `data: ${JSON.stringify({ choices: [{ delta: { content: "[1.0:] la", audio: { data: audio.slice(4) } } }] })}`,
            `data: ${JSON.stringify({ choices: [], usage: { cost: 0.04 } })}`,
            "data: [DONE]",
        ];
        const out = await gatherStream("t", new Response(`${lines.join("\n")}\n`));
        expect([...out.audio]).toEqual([1, 2, 3, 4, 5, 6]);
        expect(out.text).toBe("[1.0:] la");
        expect(out.usage).toEqual({ cost: 0.04 });
        await expect(gatherStream("t", new Response(`data: ${JSON.stringify({ error: { message: "nope" } })}\n`))).rejects.toThrow("t: nope");
    });
});

describe("media", () => {
    it("writes an image to the workspace and returns its facts", async () => {
        const { ws, files } = fakeWs();
        files.set("/workspace/ref.jpg", new Uint8Array([9, 9]));
        const { fetchImpl, sent } = stub(
            () => new Response(JSON.stringify({ data: [{ b64_json: bytesToBase64(png(1024, 1024, 6)) }], usage: { cost: 0.006 } })),
        );
        const media = new Media(ws, { fetchImpl });
        const out = await media.image({ prompt: "a fox", path: "art/fox.png", transparent: true, references: ["ref.jpg"] });
        expect(out).toEqual({ path: "/workspace/art/fox.png", width: 1024, height: 1024, alpha: true, cost: 0.006 });
        expect(files.get("/workspace/art/fox.png")?.length).toBe(33);
        expect(sent[0]?.url).toBe("https://openrouter.ai/api/v1/images");
        expect(sent[0]?.body).toMatchObject({ model: IMAGE_MODEL, prompt: "a fox", aspect_ratio: "1:1", quality: "low", background: "transparent" });
        expect(sent[0]?.body.input_references[0].image_url.url).toBe("data:image/jpeg;base64,CQk=");
    });

    it("refuses a path outside the workspace, the wrong extension, or a missing reference", async () => {
        const { ws } = fakeWs();
        const media = new Media(ws, { fetchImpl: stub(() => new Response("{}")).fetchImpl });
        await expect(media.image({ prompt: "x", path: "../etc/x.png" })).rejects.toThrow(/is outside \/workspace/);
        await expect(media.image({ prompt: "x", path: "x.jpg" })).rejects.toThrow("media.image: the file is PNG, so name it *.png");
        await expect(media.image({ prompt: "x", path: "x.png", references: ["no.png"] })).rejects.toThrow(
            "media.image: no reference image at /workspace/no.png",
        );
    });

    it("speaks into a WAV, its style as the provider's option", async () => {
        const { ws, files } = fakeWs();
        const { fetchImpl, sent } = stub(
            () => new Response(new Uint8Array(48000), { headers: { "content-type": "audio/pcm;rate=24000;channels=1" } }),
        );
        const out = await new Media(ws, { fetchImpl }).speech({ text: "Hello <laugh>", path: "vo/a.wav", voice: "Puck", style: "warm" });
        expect(out).toEqual({ path: "/workspace/vo/a.wav", seconds: 1 });
        expect(files.get("/workspace/vo/a.wav")?.length).toBe(48044);
        expect(sent[0]?.url).toBe("https://openrouter.ai/api/v1/audio/speech");
        expect(sent[0]?.body).toMatchObject({ input: "Hello <laugh>", voice: "Puck", response_format: "pcm" });
        expect(sent[0]?.body.provider.options["google-ai-studio"].speech_metadata.style).toBe("warm");
    });

    it("speaks into Opus for an .ogg, and into a WAV where Opus can't be made", async () => {
        const pcm = () => new Response(new Uint8Array(48000), { headers: { "content-type": "audio/pcm;rate=24000;channels=1" } });
        /** @type {any[]} */
        const encoded = [];
        const opus = {
            can: async () => true,
            encode: async (/** @type {Uint8Array} */ bytes, /** @type {number} */ rate, /** @type {number} */ channels) => {
                encoded.push({ length: bytes.length, rate, channels });
                return new Uint8Array([0x4f, 0x67, 0x67, 0x53]);
            },
        };
        const { ws, files } = fakeWs();
        const out = await new Media(ws, { fetchImpl: stub(pcm).fetchImpl, opus }).speech({ text: "Hi", path: "vo/a.ogg" });
        expect(out).toEqual({ path: "/workspace/vo/a.ogg", seconds: 1 });
        expect(encoded).toEqual([{ length: 48000, rate: 24000, channels: 1 }]);
        expect(files.get("/workspace/vo/a.ogg")).toEqual(new Uint8Array([0x4f, 0x67, 0x67, 0x53]));

        const without = { ...opus, can: async () => false };
        const fallback = await new Media(ws, { fetchImpl: stub(pcm).fetchImpl, opus: without }).speech({ text: "Hi", path: "vo/b.ogg" });
        expect(fallback).toEqual({ path: "/workspace/vo/b.wav", seconds: 1 });
        expect(files.get("/workspace/vo/b.wav")?.length).toBe(48044);
        expect(files.has("/workspace/vo/b.ogg")).toBe(false);

        await expect(new Media(ws, { fetchImpl: stub(pcm).fetchImpl, opus }).speech({ text: "Hi", path: "vo/c.mp3" })).rejects.toThrow(
            "media.speech: the file is OGG, so name it *.ogg (or *.wav)",
        );
    });

    it("composes music from a stream, with its length and lyrics", async () => {
        const { ws, files } = fakeWs();
        const body = [
            `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: bytesToBase64(mp3(10)) }, content: "[0.0:] hey" } }] })}`,
            `data: ${JSON.stringify({ choices: [], usage: { cost: 0, cost_details: { upstream_inference_cost: 0.04 } } })}`,
        ].join("\n");
        const { fetchImpl, sent } = stub(() => new Response(body));
        const out = await new Media(ws, { fetchImpl }).music({ prompt: "lo-fi", path: "app/bg.mp3" });
        expect(out).toEqual({ path: "/workspace/app/bg.mp3", seconds: 0.26, lyrics: [{ at: 0, line: "hey" }], cost: 0.04 });
        expect(files.has("/workspace/app/bg.mp3")).toBe(true);
        expect(sent[0]?.body).toMatchObject({ model: MUSIC_MODELS.clip, modalities: ["audio", "text"], stream: true });
    });

    it("says when music came back without audio", async () => {
        const { ws } = fakeWs();
        const { fetchImpl } = stub(() => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "sorry" } }] })}\n`));
        await expect(new Media(ws, { fetchImpl }).music({ prompt: "x", path: "x.mp3" })).rejects.toThrow(/answered without music/);
    });
});
