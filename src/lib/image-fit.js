/**
 * Images a model will take: every image in a request, fitted on its way
 * out. Anthropic refuses one past 5 MB of base64 (and others have limits
 * of their own), so an image past `IMAGE_LIMIT` is re-encoded, smaller,
 * before it's sent: a screenshot, an image `view_image` read, an upload.
 *
 * The record keeps the image as it was; only what is sent changes. So a
 * session that already holds one too large works again.
 */

/** The most base64 one image may be: Anthropic's 5 MB, with room. */
export const IMAGE_LIMIT = 4_000_000;
/** The longest side an image may have: Anthropic's 8000px, with room. */
export const MAX_SIDE = 7680;
/** Quality for the lossy re-encoding. */
const QUALITY = 0.85;

/** Fitted images by their data, so the history's images aren't
 *  re-encoded with every request. */
const cache = new Map();
const CACHE_MAX = 32;

/** @typedef {{ data: string, mediaType: string }} Img */

/** A cache key for an image's data: cheap, and distinct in practice.
 *  @param {string} data */
const keyOf = (data) => `${data.length}:${data.slice(0, 96)}:${data.slice(-96)}`;

/**
 * `image`, fitted: as it is when its base64 is within `limit`; else
 * re-encoded as WebP (which keeps transparency), or JPEG on white where
 * the browser can't write WebP, scaled down until it fits.
 *
 * @param {Img} image
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<Img>}
 */
export async function fitImage(image, { limit = IMAGE_LIMIT } = {}) {
    if (image.data.length <= limit) return image;
    const key = keyOf(image.data);
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const blob = await (await fetch(`data:${image.mediaType};base64,${image.data}`)).blob();
    const bitmap = await createImageBitmap(blob);
    try {
        let scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
        /** @type {Img | null} */
        let out = null;
        for (let tries = 0; tries < 8; tries++) {
            out = await encode(bitmap, scale);
            if (out.data.length <= limit) break;
            // the size goes with the area: shrink by its square root, and a bit
            scale *= Math.sqrt(limit / out.data.length) * 0.92;
        }
        const fitted = /** @type {Img} */ (out);
        cache.set(key, fitted);
        if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
        return fitted;
    } finally {
        bitmap.close();
    }
}

/** @param {ImageBitmap} bitmap @param {number} scale @returns {Promise<Img>} */
async function encode(bitmap, scale) {
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const g = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext("2d"));
    g.drawImage(bitmap, 0, 0, width, height);
    let blob = await canvas.convertToBlob({ type: "image/webp", quality: QUALITY });
    if (blob.type !== "image/webp") {
        // no WebP writer: JPEG, over white, since it has no transparency
        g.globalCompositeOperation = "destination-over";
        g.fillStyle = "#fff";
        g.fillRect(0, 0, width, height);
        blob = await canvas.convertToBlob({ type: "image/jpeg", quality: QUALITY });
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { data: btoa(binary), mediaType: blob.type };
}

/**
 * An AI SDK prompt with every image in it fitted: a `file` part with an
 * image's base64, in a message or in a tool result's content. Everything
 * else is as it was.
 *
 * @template T
 * @param {T} prompt
 * @param {{ fit?: (image: Img) => Promise<Img> }} [opts]
 * @returns {Promise<T>}
 */
export async function fitPrompt(prompt, { fit = fitImage } = {}) {
    /** @param {any} value @returns {Promise<any>} */
    const walk = async (value) => {
        if (Array.isArray(value)) return Promise.all(value.map(walk));
        if (typeof value !== "object" || value === null || value instanceof Uint8Array || value instanceof URL) return value;
        if (value.type === "file" && typeof value.mediaType === "string" && value.mediaType.startsWith("image/")) {
            // the data as a string, or as `{ type: 'data', data }` in a tool result
            const inner = typeof value.data === "object" && value.data !== null && value.data.type === "data";
            const data = inner ? value.data.data : value.data;
            if (typeof data !== "string") return value;
            const fitted = await fit({ data, mediaType: value.mediaType });
            if (fitted.data === data) return value;
            return { ...value, mediaType: fitted.mediaType, data: inner ? { ...value.data, data: fitted.data } : fitted.data };
        }
        /** @type {Record<string, unknown>} */
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = await walk(v);
        return out;
    };
    return walk(prompt);
}

/**
 * `model`, its requests' images fitted first: the same model otherwise
 * (its provider, id and the rest are read through to it).
 *
 * @template {{ doStream: Function, doGenerate: Function }} M
 * @param {M} model
 * @returns {M}
 */
export function fittingImages(model) {
    const wrapped = Object.create(model);
    wrapped.doStream = async (/** @type {any} */ options) => model.doStream({ ...options, prompt: await fitPrompt(options.prompt) });
    wrapped.doGenerate = async (/** @type {any} */ options) => model.doGenerate({ ...options, prompt: await fitPrompt(options.prompt) });
    return wrapped;
}
