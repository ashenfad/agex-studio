/**
 * Generative-media helpers backing the TS-side `createImage` agent.fn
 * (and, later, `createMusic` / `createSpeech`).
 *
 * All route through OpenRouter with the user's `apiKey` — same key, same
 * egress as `search` (see search.js). Image and music use the chat-
 * completions endpoint; speech uses the dedicated `/audio/speech` endpoint.
 * Each generator follows one shape:
 *
 *   run<Media>({ ...inputs, settings, fetchImpl }) -> Promise<Uint8Array>
 *
 * — build a request body, POST it through `_postChat`, decode the response
 * to media bytes. Adding a modality = add one parallel `run<Media>` + its
 * response decoder. `fetchImpl` is injected so tests stub HTTP without the
 * network or the global.
 */

import { getSettings } from "./settings.js";
import { bytesToBase64, base64ToBytes } from "./bytes.js";

/** OpenRouter's OpenAI-compatible chat-completions endpoint. Hardcoded —
 *  the media models the generators target are OpenRouter-routed. */
const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

/** OpenRouter's dedicated text-to-speech endpoint — returns raw audio
 *  bytes (not JSON / not SSE), unlike the chat-completions generators. */
const OPENROUTER_SPEECH_URL = "https://openrouter.ai/api/v1/audio/speech";

/** Image models. `quality: 'high'` escalates to Nano Banana Pro for
 *  slower/better output (mirrors search's shallow/deep). */
const IMAGE_MODELS = {
    standard: "google/gemini-3.1-flash-image",
    high: "google/gemini-3-pro-image-preview",
};

/** Music models (Lyria). `length: 'clip'` = a 30s clip; `'full'` = a
 *  longer structured song (slower, costlier). Both stream MP3. */
const MUSIC_MODELS = {
    clip: "google/lyria-3-clip-preview",
    full: "google/lyria-3-pro-preview",
};

/** Speech model — Gemini Flash TTS: prompt-steerable (inline emotion tags
 *  in the text), ~30 prebuilt voices. */
const SPEECH_MODEL = "google/gemini-3.1-flash-tts-preview";

/**
 * POST a chat-completions body to OpenRouter and return the parsed JSON.
 * The shared auth + error-surfacing boilerplate for every generator (the
 * search.js pattern, factored). `label` namespaces thrown errors per
 * modality so the agent's next-turn observation says which call failed.
 */
async function _post({ label, url = OPENROUTER_CHAT_URL, body, settings, fetchImpl = fetch }) {
    if (!settings?.apiKey) {
        throw new Error(
            `${label}: no API key configured — set one in the settings drawer`,
        );
    }
    let response;
    try {
        response = await fetchImpl(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${settings.apiKey}`,
            },
            body: JSON.stringify(body),
        });
    } catch (e) {
        throw new Error(`${label}: network error — ${e?.message || String(e)}`);
    }
    if (!response.ok) {
        if (response.status === 401) {
            throw new Error(
                `${label}: HTTP 401 — this uses OpenRouter; the configured API key ` +
                    "isn't valid for OpenRouter. Switch the provider to OpenRouter or use an OpenRouter key.",
            );
        }
        let detail = "";
        try {
            detail = await response.text();
        } catch {
            // ignore — surface just the status
        }
        const trimmed = detail.length > 500 ? detail.slice(0, 500) + "…" : detail;
        throw new Error(
            `${label}: HTTP ${response.status} ${response.statusText}` +
                (trimmed ? ` — ${trimmed}` : ""),
        );
    }
    // On success the body is unread, so the caller decodes it however it
    // needs — `.json()` (image), an SSE stream (music), or `.arrayBuffer()`
    // (speech, future).
    return response;
}

/** `_post` + JSON decode — the non-streaming path (image). */
async function _postChat(args) {
    const response = await _post(args);
    try {
        return await response.json();
    } catch (e) {
        throw new Error(
            `${args.label}: response was not valid JSON — ${e?.message || String(e)}`,
        );
    }
}

/** Sniff an image MIME from magic bytes (for labelling input/reference
 *  images on edit). Defaults to png — most models accept the declaration
 *  loosely, but matching is safer. */
function _imageMime(b) {
    if (b instanceof Uint8Array && b.length >= 4) {
        if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
        if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
        if (
            b.length >= 12 &&
            b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
            b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
        ) {
            return "image/webp";
        }
    }
    return "image/png";
}

/** User-message content: the text prompt plus any input images (edit /
 *  compose mode), each as a base64 data: URL. */
function _imageContent(prompt, images) {
    const content = [{ type: "text", text: prompt }];
    for (const bytes of images) {
        content.push({
            type: "image_url",
            image_url: {
                url: `data:${_imageMime(bytes)};base64,${bytesToBase64(bytes)}`,
            },
        });
    }
    return content;
}

/** Pull generated image bytes from a chat-completions response. OpenRouter
 *  returns them on `message.images[].image_url.url` as a data: URL; fall
 *  back to an `image_url` content part. Handles base64 data URLs and
 *  (defensively) a hosted http(s) URL. */
async function _extractImageBytes(data, fetchImpl) {
    const msg = data?.choices?.[0]?.message;
    const url =
        msg?.images?.[0]?.image_url?.url ??
        (Array.isArray(msg?.content)
            ? msg.content.find((p) => p?.type === "image_url")?.image_url?.url
            : undefined);
    if (typeof url !== "string" || !url) {
        throw new Error(
            `createImage: no image in response (got: ${JSON.stringify(data).slice(0, 200)})`,
        );
    }
    if (url.startsWith("data:")) {
        return base64ToBytes(url.slice(url.indexOf(",") + 1));
    }
    const r = await (fetchImpl || fetch)(url);
    if (!r.ok) {
        throw new Error(`createImage: failed to fetch image url (HTTP ${r.status})`);
    }
    return new Uint8Array(await r.arrayBuffer());
}

/**
 * Generate (or edit) an image. With `image` set, the input(s) are sent as
 * reference images and the prompt edits / composes them (multiple images
 * compose). Returns the generated image bytes (PNG).
 *
 * @param {{
 *   prompt: string,
 *   image?: Uint8Array | Uint8Array[],
 *   quality?: 'standard' | 'high',
 *   settings: { apiKey: string },
 *   fetchImpl?: typeof fetch,
 * }} opts
 * @returns {Promise<Uint8Array>}
 */
export async function runCreateImage(opts) {
    const { prompt, image, quality = "standard", settings, fetchImpl = fetch } = opts;
    if (!prompt || typeof prompt !== "string") {
        throw new Error("createImage: prompt must be a non-empty string");
    }
    const images = image == null ? [] : Array.isArray(image) ? image : [image];
    const model = quality === "high" ? IMAGE_MODELS.high : IMAGE_MODELS.standard;
    const data = await _postChat({
        label: "createImage",
        body: {
            model,
            messages: [{ role: "user", content: _imageContent(prompt, images) }],
            modalities: ["image", "text"],
        },
        settings,
        fetchImpl,
    });
    return _extractImageBytes(data, fetchImpl);
}

/**
 * Convenience wrapper for the `agent.fn` registration — pulls settings from
 * the store and uses global `fetch`. Tests exercise `runCreateImage`
 * directly with stubs.
 *
 * @param {string} prompt
 * @param {{ image?: Uint8Array | Uint8Array[], quality?: 'standard' | 'high' }} [opts]
 * @returns {Promise<Uint8Array>}
 */
export function createImage(prompt, opts = {}) {
    return runCreateImage({ prompt, ...opts, settings: getSettings() });
}

// ---------------------------------------------------------------------------
// Music (Lyria) — streaming
// ---------------------------------------------------------------------------
//
// Unlike image, Lyria REQUIRES `stream: true` ("Audio output requires stream:
// true"). The generated audio arrives as base64 on `choices[].delta.audio.data`
// — a single chunk for clips, but we concatenate across chunks defensively
// for longer songs. We accumulate the base64 string and decode once (the
// chunks form one continuous base64 stream).

/** Read an OpenRouter SSE stream and concatenate the audio deltas into one
 *  base64 string. Throws on an error event or an audio-less stream. */
async function _collectAudioStream(response, label) {
    if (!response.body || typeof response.body.getReader !== "function") {
        throw new Error(`${label}: streaming response has no readable body`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let audio = "";
    let streamErr = null;
    const handleLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) return;
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") return;
        let json;
        try {
            json = JSON.parse(data);
        } catch {
            return; // keepalive / partial — ignore
        }
        if (json?.error) {
            streamErr = json.error?.message || JSON.stringify(json.error);
            return;
        }
        const part = json?.choices?.[0]?.delta?.audio?.data;
        if (typeof part === "string") audio += part;
    };
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf("\n")) >= 0) {
            handleLine(buffer.slice(0, nl));
            buffer = buffer.slice(nl + 1);
        }
    }
    if (buffer) handleLine(buffer); // trailing line without a newline
    if (streamErr) throw new Error(`${label}: ${streamErr}`);
    if (!audio) throw new Error(`${label}: response contained no audio`);
    return audio;
}

/**
 * Generate music from a text prompt (Lyria). `length: 'clip'` (default) is a
 * 30-second clip; `'full'` is a longer structured song. All musical control
 * — genre, tempo, key, structure — lives in the prompt; there's no duration
 * or seed parameter. Returns MP3 bytes.
 *
 * @param {{
 *   prompt: string,
 *   length?: 'clip' | 'full',
 *   settings: { apiKey: string },
 *   fetchImpl?: typeof fetch,
 * }} opts
 * @returns {Promise<Uint8Array>}
 */
export async function runCreateMusic(opts) {
    const { prompt, length = "clip", settings, fetchImpl = fetch } = opts;
    if (!prompt || typeof prompt !== "string") {
        throw new Error("createMusic: prompt must be a non-empty string");
    }
    const model = length === "full" ? MUSIC_MODELS.full : MUSIC_MODELS.clip;
    const response = await _post({
        label: "createMusic",
        body: {
            model,
            messages: [{ role: "user", content: prompt }],
            modalities: ["text", "audio"],
            stream: true,
        },
        settings,
        fetchImpl,
    });
    const b64 = await _collectAudioStream(response, "createMusic");
    return base64ToBytes(b64);
}

/**
 * Convenience wrapper for the `agent.fn` registration — pulls settings from
 * the store and uses global `fetch`. Tests exercise `runCreateMusic` directly.
 *
 * @param {string} prompt
 * @param {{ length?: 'clip' | 'full' }} [opts]
 * @returns {Promise<Uint8Array>}
 */
export function createMusic(prompt, opts = {}) {
    return runCreateMusic({ prompt, ...opts, settings: getSettings() });
}

// ---------------------------------------------------------------------------
// Speech (Gemini Flash TTS) — dedicated /audio/speech endpoint
// ---------------------------------------------------------------------------
//
// Unlike image/music, TTS uses OpenRouter's `/audio/speech` endpoint and
// returns RAW audio bytes (not JSON, not SSE). Emotion / delivery is authored
// INLINE in the text via Gemini's tags ("[whispers] ... [angry] ..."); `voice`
// picks one of ~30 prebuilt voices. Gemini TTS only emits headerless PCM
// (24 kHz / 16-bit / mono), so we wrap it in a WAV container — the returned
// bytes are a playable .wav.

/** Wrap raw little-endian 16-bit PCM in a 44-byte WAV header so the bytes are
 *  a self-contained, playable file. Defaults match Gemini TTS's PCM output
 *  (24 kHz / 16-bit / mono). */
function _pcmToWav(pcm, { sampleRate = 24000, channels = 1, bitDepth = 16 } = {}) {
    const blockAlign = (channels * bitDepth) / 8;
    const header = new DataView(new ArrayBuffer(44));
    const ascii = (off, s) => {
        for (let i = 0; i < s.length; i++) header.setUint8(off + i, s.charCodeAt(i));
    };
    ascii(0, "RIFF");
    header.setUint32(4, 36 + pcm.length, true);
    ascii(8, "WAVE");
    ascii(12, "fmt ");
    header.setUint32(16, 16, true); // fmt chunk size
    header.setUint16(20, 1, true); // PCM
    header.setUint16(22, channels, true);
    header.setUint32(24, sampleRate, true);
    header.setUint32(28, sampleRate * blockAlign, true); // byte rate
    header.setUint16(32, blockAlign, true);
    header.setUint16(34, bitDepth, true);
    ascii(36, "data");
    header.setUint32(40, pcm.length, true);
    const out = new Uint8Array(44 + pcm.length);
    out.set(new Uint8Array(header.buffer), 0);
    out.set(pcm, 44);
    return out;
}

/**
 * Generate spoken audio from text (Gemini Flash TTS). `voice` is one of the
 * prebuilt voices (default Kore); direct emotion/pacing with inline tags in
 * the text. Returns WAV bytes (24 kHz mono — Gemini emits PCM, wrapped here).
 *
 * @param {{
 *   text: string,
 *   voice?: string,
 *   settings: { apiKey: string },
 *   fetchImpl?: typeof fetch,
 * }} opts
 * @returns {Promise<Uint8Array>}
 */
export async function runCreateSpeech(opts) {
    const { text, voice = "Kore", settings, fetchImpl = fetch } = opts;
    if (!text || typeof text !== "string") {
        throw new Error("createSpeech: text must be a non-empty string");
    }
    const response = await _post({
        label: "createSpeech",
        url: OPENROUTER_SPEECH_URL,
        body: {
            model: SPEECH_MODEL,
            input: text,
            voice,
            response_format: "pcm", // Gemini TTS only supports pcm
        },
        settings,
        fetchImpl,
    });
    const pcm = new Uint8Array(await response.arrayBuffer());
    if (pcm.length === 0) {
        throw new Error("createSpeech: response contained no audio");
    }
    return _pcmToWav(pcm);
}

/**
 * Convenience wrapper for the `agent.fn` registration — pulls settings from
 * the store and uses global `fetch`. Tests exercise `runCreateSpeech` directly.
 *
 * @param {string} text
 * @param {{ voice?: string }} [opts]
 * @returns {Promise<Uint8Array>}
 */
export function createSpeech(text, opts = {}) {
    return runCreateSpeech({ text, ...opts, settings: getSettings() });
}
