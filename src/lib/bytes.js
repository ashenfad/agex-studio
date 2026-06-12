/**
 * Byte-array utilities used in multiple places — kept in one module
 * so the variants don't drift.
 *
 * - `formatBytes(n)` — human-readable size string ("12.3 KB", "1.0 MB",
 *   "847 B"). Used by file chips, file-modal banners, session-drawer
 *   storage badges, gist-publish status output.
 * - `bytesToBase64(bytes)` — canonical base64 string from raw bytes.
 *   Chunked through `String.fromCharCode.apply` to avoid the call-
 *   stack-exhaust trap that `String.fromCharCode(...arr)` hits on
 *   large arrays. Used by the py worker's PDF + esbuild-bridge
 *   paths, and the TS esbuild-terminal's binary-image inlining.
 */

/** Render a byte count as a short human-readable string. Always uses
 *  binary (1024-based) units with one decimal place above 1 KB. */
export function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Encode raw bytes to canonical base64. The naive
 *  `btoa(String.fromCharCode(...bytes))` form crashes the call stack
 *  on arrays over ~100K elements (browser-dependent arg-list cap);
 *  chunked apply keeps each fromCharCode call inside the limit while
 *  still beating per-byte string concatenation by a wide margin. */
export function bytesToBase64(bytes) {
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(
            null,
            /** @type {any} */ (bytes.subarray(i, i + CHUNK)),
        );
    }
    return btoa(binary);
}

/** Decode canonical base64 back to raw bytes. */
export function base64ToBytes(b64) {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
}
