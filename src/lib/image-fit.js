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

/** A cache key for an image: a digest of its data, and its type.
 *  @param {Img} image */
async function keyOf(image) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(image.data));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return `${image.mediaType}:${hex}`;
}

/** How much of an image's start is read for its size, in base64: a
 *  JPEG's frame header may follow a large EXIF block. */
const HEAD = 349_528;

/**
 * An image's width and height, read from its header (PNG, GIF, WebP,
 * JPEG); null when the header doesn't say.
 *
 * @param {string} data base64
 * @returns {{ width: number, height: number } | null}
 */
export function sizeOf(data) {
    /** @type {Uint8Array} */
    let b;
    try {
        // whole base64 quanta only
        const head = data.slice(0, Math.min(data.length, HEAD) - (Math.min(data.length, HEAD) % 4));
        b = Uint8Array.from(atob(head), (c) => c.charCodeAt(0));
    } catch {
        return null;
    }
    const u16be = (i) => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
    const u16le = (i) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
    const u24le = (i) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16);
    const u32be = (i) => (((b[i] ?? 0) << 24) | ((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0)) >>> 0;
    const ascii = (i, n) => String.fromCharCode(...b.subarray(i, i + n));
    if (b[0] === 0x89 && ascii(1, 3) === "PNG" && b.length >= 24) return { width: u32be(16), height: u32be(20) };
    if (ascii(0, 3) === "GIF" && b.length >= 10) return { width: u16le(6), height: u16le(8) };
    if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP" && b.length >= 30) {
        const chunk = ascii(12, 4);
        if (chunk === "VP8X") return { width: u24le(24) + 1, height: u24le(27) + 1 };
        if (chunk === "VP8L") {
            const bits = (b[21] ?? 0) | ((b[22] ?? 0) << 8) | ((b[23] ?? 0) << 16) | ((b[24] ?? 0) << 24);
            return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
        }
        if (chunk === "VP8 ") return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
        return null;
    }
    if (b[0] === 0xff && b[1] === 0xd8) {
        // the markers, to the frame header (SOF0-15, but DHT, JPG and DAC)
        let i = 2;
        while (i + 9 < b.length) {
            if (b[i] !== 0xff) return null;
            const marker = b[i + 1] ?? 0;
            if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
                i += 2;
                continue;
            }
            if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                return { width: u16be(i + 7), height: u16be(i + 5) };
            }
            i += 2 + u16be(i + 2);
        }
    }
    return null;
}

/** Whether `image` goes as it is: within the limit, and within the
 *  side, as its header says (or, when it doesn't say, as decoding it
 *  says). @param {Img} image @param {number} limit */
async function fits(image, limit) {
    if (image.data.length > limit) return false;
    const size = sizeOf(image.data);
    if (size !== null) return Math.max(size.width, size.height) <= MAX_SIDE;
    try {
        const bitmap = await createImageBitmap(await (await fetch(`data:${image.mediaType};base64,${image.data}`)).blob());
        const ok = Math.max(bitmap.width, bitmap.height) <= MAX_SIDE;
        bitmap.close();
        return ok;
    } catch {
        // not one this browser decodes: the provider will say
        return true;
    }
}

/**
 * `image`, fitted: as it is when its base64 is within `limit` and its
 * longest side within `MAX_SIDE`; else re-encoded as WebP (which keeps
 * transparency), or JPEG on white where the browser can't write WebP,
 * scaled down until it fits.
 *
 * @param {Img} image
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<Img>}
 */
export async function fitImage(image, { limit = IMAGE_LIMIT } = {}) {
    if (await fits(image, limit)) return image;
    const key = await keyOf(image);
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
        if (cache.size > CACHE_MAX) cache.delete(/** @type {string} */ (cache.keys().next().value));
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
    // one image at a time: each holds a decoded bitmap and a canvas while
    // it's fitted, and a history may hold many
    /** @param {any} value @returns {Promise<any>} */
    const walk = async (value) => {
        if (Array.isArray(value)) {
            const out = [];
            for (const item of value) out.push(await walk(item));
            return out;
        }
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
