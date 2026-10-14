/**
 * `media`, a host object: images, speech and music through OpenRouter.
 *
 * Each call writes its file into the session's workspace and returns
 * plain facts about it (its path, size, length and cost), read from the
 * file written. The write goes through the calling workspace's
 * filesystem, so it lands in the code's own commit.
 *
 * It is the agent's, not an app's: an app's code runs in the preview,
 * which has no host objects.
 */

import { hostFactory, typedHost, withCall } from "@agex-ts/world";
import { z } from "zod";
import { base64ToBytes, bytesToBase64 } from "./bytes.js";
import { costOf, routerJson, routerPost } from "./openrouter-api.js";
import { inWorkspace, writeFile } from "./ws-paths.js";

/** Real transparency (an alpha channel, not a painted checkerboard) is
 *  an OpenAI image-model feature on OpenRouter. A low-quality 1024x1024
 *  takes about 11s, for $0.006. */
export const IMAGE_MODEL = "openai/gpt-image-2.5-sunburst";
export const IMAGE_ASPECTS = /** @type {const} */ (["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9"]);
export const IMAGE_QUALITIES = /** @type {const} */ (["low", "medium", "high", "xhigh", "max"]);
const MAX_REFERENCES = 16;

/** Gemini's speech model reads its input as a verbatim transcript: a
 *  direction written into the text ("[whispers]", "Say cheerfully:") is
 *  spoken. Delivery goes in `style`, passed to Google AI Studio as a
 *  provider option; only momentary sounds in angle brackets (`<laugh>`,
 *  `<sigh>`, `<short pause>`) stay inline. */
export const SPEECH_MODEL = "google/gemini-3.8-flash-tts";
const SPEECH_PROVIDER = "google-ai-studio";
/** Gemini's prebuilt voices, with the tone each is described by. The
 *  provider answers an unknown name with a bare 400, so names are
 *  checked here, where the error can list them. */
export const VOICES = /** @type {const} */ ({
    Achernar: "soft",
    Achird: "friendly",
    Algenib: "gravelly",
    Algieba: "smooth",
    Alnilam: "firm",
    Aoede: "breezy",
    Autonoe: "bright",
    Callirrhoe: "easy-going",
    Charon: "informative",
    Despina: "smooth",
    Enceladus: "breathy",
    Erinome: "clear",
    Fenrir: "excitable",
    Gacrux: "mature",
    Iapetus: "clear",
    Kore: "firm",
    Laomedeia: "upbeat",
    Leda: "youthful",
    Orus: "firm",
    Puck: "upbeat",
    Pulcherrima: "forward",
    Rasalgethi: "informative",
    Sadachbia: "lively",
    Sadaltager: "knowledgeable",
    Schedar: "even",
    Sulafat: "warm",
    Umbriel: "easy-going",
    Vindemiatrix: "gentle",
    Zephyr: "bright",
    Zubenelgenubi: "casual",
});
const VOICE_NAMES = /** @type {[keyof typeof VOICES, ...(keyof typeof VOICES)[]]} */ (Object.keys(VOICES));

/** Lyria 3: a clip is about 30s for $0.04; a song follows the length
 *  its prompt asks for, roughly, for $0.08. Both answer with a 44.1kHz
 *  stereo MP3, in about 10s and 25s. */
export const MUSIC_MODELS = { clip: "google/lyria-3-clip-preview", song: "google/lyria-3-pro-preview" };
/** Audio first: asked for ["text", "audio"], Lyria answers with its
 *  text alone, and an empty stop. */
const MUSIC_MODALITIES = ["audio", "text"];

// Gemini speech arrives as raw 16-bit PCM; the response's content type
// names the rate and channels, and these are what it said when measured.
const PCM_RATE = 24_000;
const PCM_CHANNELS = 1;

const IMAGE_TIMEOUT = 150;
const SPEECH_TIMEOUT = 120;
const MUSIC_TIMEOUT = 150;

/** @typedef {import("@agex-ts/world").Workspace} Workspace */
/** @typedef {import("@agex-ts/world").HostCall} HostCall */

/**
 * Generate images, speech and music into one session's workspace.
 * Each method takes its arguments by name, as one object.
 */
export class Media {
    /** @param {Workspace} ws @param {{ fetchImpl?: typeof fetch }} [opts] */
    constructor(ws, { fetchImpl } = {}) {
        this._ws = ws;
        this._fetch = fetchImpl;
    }

    /**
     * Generate a PNG from `prompt` and write it to `path`. `transparent`
     * gives a real alpha channel; `references` are workspace images to
     * work from (a character or style to keep, or an image to edit).
     */
    image = withCall(
        /**
         * @param {HostCall | undefined} call
         * @param {{ prompt: string, path: string, transparent?: boolean, aspect?: string, quality?: string, references?: string[] }} spec
         */
        async (call, spec) => {
            const fs = this._fs(call);
            const prompt = spec.prompt.trim();
            if (prompt === "") throw new Error("media.image: the prompt is empty");
            const dest = this._dest("media.image", spec.path, ".png");
            /** @type {Record<string, unknown>} */
            const body = {
                model: IMAGE_MODEL,
                prompt,
                aspect_ratio: spec.aspect ?? "1:1",
                quality: spec.quality ?? "low",
                background: spec.transparent ? "transparent" : "opaque",
                output_format: "png",
            };
            const refs = spec.references ?? [];
            if (refs.length > 0) {
                body.input_references = await Promise.all(refs.map((r) => this._reference(fs, r)));
            }
            const data = await routerJson({ label: "media.image", path: "/images", body, timeout: IMAGE_TIMEOUT, fetchImpl: this._fetch });
            const b64 = data?.data?.[0]?.b64_json;
            if (typeof b64 !== "string") throw new Error("media.image: the response held no image");
            const png = base64ToBytes(b64);
            await writeFile(fs, dest, png);
            return { path: dest, ...pngFacts(png), cost: costOf(data?.usage) };
        },
    );

    /**
     * Speak `text` in `voice` and write a WAV to `path`. The text is
     * spoken word for word; `style` says how, in plain words.
     */
    speech = withCall(
        /**
         * @param {HostCall | undefined} call
         * @param {{ text: string, path: string, voice?: string, style?: string }} spec
         */
        async (call, spec) => {
            const fs = this._fs(call);
            const text = spec.text.trim();
            if (text === "") throw new Error("media.speech: the text is empty");
            const dest = this._dest("media.speech", spec.path, ".wav");
            /** @type {Record<string, unknown>} */
            const body = { model: SPEECH_MODEL, input: text, voice: spec.voice ?? "Kore", response_format: "pcm" };
            const style = spec.style?.trim();
            if (style) body.provider = { options: { [SPEECH_PROVIDER]: { speech_metadata: { style } } } };
            const r = await routerPost({ label: "media.speech", path: "/audio/speech", body, timeout: SPEECH_TIMEOUT, fetchImpl: this._fetch });
            const pcm = new Uint8Array(await r.arrayBuffer());
            if (pcm.length === 0) throw new Error("media.speech: the response held no audio");
            const { rate, channels } = pcmFormat(r.headers.get("content-type") ?? "");
            await writeFile(fs, dest, wav(pcm, rate, channels));
            return { path: dest, seconds: round2(pcm.length / (2 * rate * channels)) };
        },
    );

    /**
     * Compose music from `prompt` and write an MP3 to `path`: a clip of
     * about 30s, or a song of about the length the prompt asks for.
     */
    music = withCall(
        /**
         * @param {HostCall | undefined} call
         * @param {{ prompt: string, path: string, length?: "clip" | "song" }} spec
         */
        async (call, spec) => {
            const fs = this._fs(call);
            const prompt = spec.prompt.trim();
            if (prompt === "") throw new Error("media.music: the prompt is empty");
            const dest = this._dest("media.music", spec.path, ".mp3");
            const r = await routerPost({
                label: "media.music",
                path: "/chat/completions",
                body: {
                    model: MUSIC_MODELS[spec.length ?? "clip"],
                    messages: [{ role: "user", content: prompt }],
                    modalities: MUSIC_MODALITIES,
                    stream: true,
                },
                timeout: MUSIC_TIMEOUT,
                fetchImpl: this._fetch,
            });
            const { audio, text, usage } = await gatherStream("media.music", r);
            if (audio.length === 0) {
                throw new Error("media.music: the model answered without music; reword the prompt and try again");
            }
            await writeFile(fs, dest, audio);
            return { path: dest, seconds: mp3Seconds(audio), lyrics: lyricsOf(text), cost: costOf(usage) };
        },
    );

    /** The calling workspace's filesystem: part of the code's call. A
     *  call straight from the host (no `call`) uses the session's own.
     *  @param {HostCall | undefined} call */
    _fs(call) {
        return (call?.ws ?? this._ws).files.fs;
    }

    /** @param {string} label @param {string} path @param {string} ext */
    _dest(label, path, ext) {
        const dest = inWorkspace(label, this._ws.root, path);
        if (!dest.toLowerCase().endsWith(ext)) {
            throw new Error(`${label}: the file is ${ext.slice(1).toUpperCase()}, so name it *${ext}`);
        }
        return dest;
    }

    /** A workspace image as an image reference.
     *  @param {Workspace["files"]["fs"]} fs @param {string} path */
    async _reference(fs, path) {
        const src = inWorkspace("media.image", this._ws.root, path);
        /** @type {Uint8Array} */
        let data;
        try {
            data = await fs.read(src);
        } catch {
            throw new Error(`media.image: no reference image at ${src}`);
        }
        const ext = src.slice(src.lastIndexOf(".") + 1).toLowerCase();
        const kind = { jpg: "jpeg", jpeg: "jpeg", webp: "webp", gif: "gif" }[ext] ?? "png";
        return { type: "image_url", image_url: { url: `data:image/${kind};base64,${bytesToBase64(data)}` } };
    }
}

/** @param {number} n */
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * A streamed chat completion, gathered: its audio, its text and its
 * usage. Audio output is only offered streamed.
 *
 * @param {string} label @param {Response} r
 */
export async function gatherStream(label, r) {
    /** @type {string[]} */
    const audio = [];
    let text = "";
    /** @type {any} */
    let usage = null;
    /** @param {string} line */
    const take = (line) => {
        if (!line.startsWith("data: ") || line === "data: [DONE]") return;
        /** @type {any} */
        let event;
        try {
            event = JSON.parse(line.slice(6));
        } catch {
            return; // a keepalive, or a partial line
        }
        if (event?.error) {
            throw new Error(`${label}: ${typeof event.error === "object" ? (event.error.message ?? JSON.stringify(event.error)) : event.error}`);
        }
        usage = event?.usage ?? usage;
        for (const choice of event?.choices ?? []) {
            const delta = choice?.delta ?? {};
            if (typeof delta.content === "string") text += delta.content;
            if (typeof delta.audio?.data === "string") audio.push(delta.audio.data);
        }
    };
    const reader = /** @type {ReadableStream<Uint8Array>} */ (r.body).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
            take(buffer.slice(0, nl).trimEnd());
            buffer = buffer.slice(nl + 1);
            nl = buffer.indexOf("\n");
        }
    }
    take(buffer.trimEnd());
    let bytes;
    try {
        bytes = base64ToBytes(audio.join(""));
    } catch {
        throw new Error(`${label}: the audio could not be decoded`);
    }
    return { audio: bytes, text, usage };
}

/** Width, height and whether it has an alpha channel, from a PNG's IHDR
 *  chunk (colour types 4 and 6 carry alpha); nulls for what isn't one.
 *  @param {Uint8Array} png */
export function pngFacts(png) {
    const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (png.length < 26 || SIG.some((b, i) => png[i] !== b)) return { width: null, height: null, alpha: null };
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20), alpha: png[25] === 4 || png[25] === 6 };
}

/** The rate and channel count an `audio/pcm;rate=…;channels=…` content
 *  type names, defaulting to what was measured. @param {string} type */
export function pcmFormat(type) {
    let rate = PCM_RATE;
    let channels = PCM_CHANNELS;
    for (const part of type.split(";").slice(1)) {
        const [key, value] = part.trim().split("=");
        if (key === "rate" && /^\d+$/.test(value ?? "")) rate = Number(value);
        if (key === "channels" && /^\d+$/.test(value ?? "")) channels = Number(value);
    }
    return { rate, channels };
}

/** 16-bit PCM in a WAV container, which a browser plays.
 *  @param {Uint8Array} pcm @param {number} rate @param {number} channels */
export function wav(pcm, rate, channels) {
    const block = channels * 2;
    const head = new DataView(new ArrayBuffer(44));
    const ascii = (/** @type {number} */ at, /** @type {string} */ s) => {
        for (let i = 0; i < s.length; i++) head.setUint8(at + i, s.charCodeAt(i));
    };
    ascii(0, "RIFF");
    head.setUint32(4, 36 + pcm.length, true);
    ascii(8, "WAVEfmt ");
    head.setUint32(16, 16, true);
    head.setUint16(20, 1, true);
    head.setUint16(22, channels, true);
    head.setUint32(24, rate, true);
    head.setUint32(28, rate * block, true);
    head.setUint16(32, block, true);
    head.setUint16(34, 16, true);
    ascii(36, "data");
    head.setUint32(40, pcm.length, true);
    const out = new Uint8Array(44 + pcm.length);
    out.set(new Uint8Array(head.buffer), 0);
    out.set(pcm, 44);
    return out;
}

// MPEG audio, by version bits: Layer III bitrates (kbps) by index, and
// sample rates by index.
/** @type {Record<number, number[]>} */
const MP3_BITRATES = {
    3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
/** @type {Record<number, number[]>} */
const MP3_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/**
 * An MP3's length in seconds, from walking its Layer III frames: each
 * holds 1152 samples (576 below MPEG-1). A leading ID3v2 tag is skipped,
 * and so is an encoder's Xing or Info frame, which holds no sound. Null
 * when no frame is found.
 *
 * @param {Uint8Array} mp3
 */
export function mp3Seconds(mp3) {
    let pos = 0;
    if (mp3.length >= 10 && mp3[0] === 0x49 && mp3[1] === 0x44 && mp3[2] === 0x33) {
        let size = 0;
        for (let i = 6; i < 10; i++) size = (size << 7) | ((mp3[i] ?? 0) & 0x7f); // syncsafe
        pos = 10 + size;
    }
    let samples = 0;
    /** @type {number | null} */
    let rate = null;
    let first = true;
    while (pos + 4 <= mp3.length) {
        const h = (((mp3[pos] ?? 0) << 24) | ((mp3[pos + 1] ?? 0) << 16) | ((mp3[pos + 2] ?? 0) << 8) | (mp3[pos + 3] ?? 0)) >>> 0;
        const version = (h >>> 19) & 3;
        const layer = (h >>> 17) & 3;
        const bitrateIndex = (h >>> 12) & 0xf;
        const rateIndex = (h >>> 10) & 3;
        if (h >>> 21 !== 0x7ff || version === 1 || layer !== 1) {
            if (samples > 0) break; // the sound ends here: a trailing tag or padding
            pos += 1; // not a frame yet: look for the first one
            continue;
        }
        if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) break;
        const kbps = /** @type {number} */ (MP3_BITRATES[version === 3 ? 3 : 2]?.[bitrateIndex]);
        rate = /** @type {number} */ (MP3_RATES[version]?.[rateIndex]);
        const perFrame = version === 3 ? 1152 : 576;
        const size = Math.floor((Math.floor(perFrame / 8) * kbps * 1000) / rate) + ((h >>> 9) & 1);
        const head = new TextDecoder("latin1").decode(mp3.subarray(pos, pos + Math.min(size, 64)));
        if (!(first && (head.includes("Xing") || head.includes("Info")))) samples += perFrame;
        first = false;
        pos += size;
    }
    return samples === 0 || rate === null ? null : round2(samples / rate);
}

/**
 * The sung lines in Lyria's text, as `{at, line}`: a line reads `[12.5:]
 * words` when the model timed it and `[:] words` when it did not (`at`
 * is null). An instrumental's text holds no such lines.
 *
 * @param {string} text
 */
export function lyricsOf(text) {
    return [...text.matchAll(/^\[(\d+(?:\.\d+)?)?:\][ \t]*(.*\S)/gm)].map((m) => ({
        at: m[1] === undefined ? null : Number(m[1]),
        line: /** @type {string} */ (m[2]),
    }));
}

const nullableNumber = z.number().nullable();

/** `media` as the profile grants it: one per session, its arguments
 *  checked. @param {{ fetchImpl?: typeof fetch }} [opts] */
export function mediaHost(opts) {
    return typedHost(
        hostFactory((ws) => new Media(ws, opts)),
        {
            image: {
                args: {
                    spec: z.strictObject({
                        prompt: z.string(),
                        path: z.string(),
                        transparent: z.boolean().optional(),
                        aspect: z.enum(IMAGE_ASPECTS).optional(),
                        quality: z.enum(IMAGE_QUALITIES).optional(),
                        references: z.array(z.string()).max(MAX_REFERENCES).optional(),
                    }),
                },
                returns: z.object({
                    path: z.string(),
                    width: nullableNumber,
                    height: nullableNumber,
                    alpha: z.boolean().nullable(),
                    cost: nullableNumber,
                }),
            },
            speech: {
                args: {
                    spec: z.strictObject({
                        text: z.string(),
                        path: z.string(),
                        voice: z.enum(VOICE_NAMES).optional(),
                        style: z.string().optional(),
                    }),
                },
                returns: z.object({ path: z.string(), seconds: z.number() }),
            },
            music: {
                args: {
                    spec: z.strictObject({
                        prompt: z.string(),
                        path: z.string(),
                        length: z.enum(["clip", "song"]).optional(),
                    }),
                },
                returns: z.object({
                    path: z.string(),
                    seconds: nullableNumber,
                    lyrics: z.array(z.object({ at: nullableNumber, line: z.string() })),
                    cost: nullableNumber,
                }),
            },
        },
    );
}
