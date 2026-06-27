/**
 * Generative-media helpers backing the TS-side `createImage` agent.fn
 * (and, later, `createMusic` / `createSpeech`).
 *
 * All route through OpenRouter's OpenAI-compatible chat-completions
 * endpoint with the user's `apiKey` — same key, same egress as `search`
 * (see search.js). Each generator follows one shape:
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

/** Image models. `quality: 'high'` escalates to Nano Banana Pro for
 *  slower/better output (mirrors search's shallow/deep). */
const IMAGE_MODELS = {
    standard: "google/gemini-3.1-flash-image",
    high: "google/gemini-3-pro-image-preview",
};

/**
 * POST a chat-completions body to OpenRouter and return the parsed JSON.
 * The shared auth + error-surfacing boilerplate for every generator (the
 * search.js pattern, factored). `label` namespaces thrown errors per
 * modality so the agent's next-turn observation says which call failed.
 */
async function _postChat({ label, body, settings, fetchImpl = fetch }) {
    if (!settings?.apiKey) {
        throw new Error(
            `${label}: no API key configured — set one in the settings drawer`,
        );
    }
    let response;
    try {
        response = await fetchImpl(OPENROUTER_CHAT_URL, {
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
    try {
        return await response.json();
    } catch (e) {
        throw new Error(
            `${label}: response was not valid JSON — ${e?.message || String(e)}`,
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
