/**
 * Browser-side image downsampling for publish-time size reduction.
 *
 * Operates on event-log image OutputParts ({format, data: base64}):
 * decode → cap the long edge → re-encode as JPEG. Screenshots (the
 * bulk of observation images) are full-size PNGs that compress
 * brutally well under this treatment.
 *
 * Returns `null` whenever it can't (or shouldn't) transform — missing
 * canvas APIs (jsdom, old browsers), decode failures, or a result
 * that isn't actually smaller — and callers keep the original part.
 */

import { base64ToBytes, bytesToBase64 } from "./bytes.js";

const MAX_DIM = 1024;
const JPEG_QUALITY = 0.75;

/**
 * @param {{ format: string, data: string }} part — image OutputPart
 * @returns {Promise<{ format: string, data: string } | null>}
 */
export async function downsampleImagePart(part, { maxDim = MAX_DIM, quality = JPEG_QUALITY } = {}) {
    if (
        typeof createImageBitmap !== "function" ||
        typeof OffscreenCanvas === "undefined"
    ) {
        return null;
    }
    try {
        const bytes = base64ToBytes(part.data);
        const bitmap = await createImageBitmap(
            new Blob([bytes], { type: `image/${part.format}` }),
        );
        const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
        const w = Math.max(1, Math.round(bitmap.width * scale));
        const h = Math.max(1, Math.round(bitmap.height * scale));
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext("2d");
        if (ctx === null) return null;
        // JPEG has no alpha channel — flatten transparency onto white
        // rather than letting it default to black.
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(bitmap, 0, 0, w, h);
        bitmap.close();
        const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
        const out = new Uint8Array(await blob.arrayBuffer());
        // A tiny PNG can re-encode LARGER as JPEG — only swap on a win.
        if (out.length >= bytes.length) return null;
        return { format: "jpeg", data: bytesToBase64(out) };
    } catch {
        return null;
    }
}
