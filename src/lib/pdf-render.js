/**
 * Shared PDF rendering helpers — used by both kernels.
 *
 * pdf.js has to live on the main thread (it needs DOM `<canvas>`),
 * which fits cleanly here: agex-ts host fns already run on the main
 * thread, and the py kernel postMessages from its worker into a
 * main-thread bridge in `pyodide.js`.
 *
 * Two surfaces:
 *   - `renderPdfPagesToBytes(bytes, pages?, scale?)` — Uint8Array in,
 *     Uint8Array[] of PNGs out. The TS path uses this directly; the
 *     py path wraps it with base64 encode/decode.
 *   - `getPdfPageCount(bytes)` — Uint8Array in, number out.
 *
 * pdf.js is loaded lazily on first call from the jsdelivr CDN. The
 * worker script for pdf.js's own internal worker is fetched from the
 * same CDN — no bundler config needed.
 */
const PDFJS_CDN = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build";

/** @type {any | null} */
let _pdfjsLib = null;

/** Lazy-load pdf.js. Subsequent calls reuse the cached module. */
async function ensurePdfJs() {
    if (_pdfjsLib) return _pdfjsLib;
    // `@vite-ignore` because the URL is composed at runtime — vite
    // would otherwise try to resolve it during import-analysis.
    const mod = await import(/* @vite-ignore */ `${PDFJS_CDN}/pdf.min.mjs`);
    mod.GlobalWorkerOptions.workerSrc = `${PDFJS_CDN}/pdf.worker.min.mjs`;
    _pdfjsLib = mod;
    // Mirror onto window for any legacy callers (the py kernel's
    // pyodide.js path historically reached for `window.pdfjsLib`).
    if (typeof window !== "undefined") window.pdfjsLib = mod;
    return mod;
}

/** Default page cap when the caller doesn't supply `pages`. Bounds
 *  the cost of "render this PDF" against an 800-page document. */
export const DEFAULT_MAX_PAGES = 20;

/** Test seam: replace the lazy pdf.js loader with a fake. The fake
 *  must mirror the `pdfjs.getDocument({ data }).promise` →
 *  `{ numPages, getPage(i) → { getViewport, render } }` shape. Pass
 *  `null` to restore the real loader. Only the test suite calls this. */
export function _setPdfjsForTesting(fake) {
    _pdfjsLib = fake;
}

/**
 * Render selected pages of a PDF to PNG byte arrays.
 *
 * @param {Uint8Array} bytes - PDF file bytes.
 * @param {ReadonlyArray<number> | null | undefined} pages - 0-based
 *   page indices to render. When null/undefined, renders the first
 *   `DEFAULT_MAX_PAGES` pages of the document.
 * @param {number} [scale=2] - pdf.js viewport scale factor. 2 ≈ 144
 *   DPI; usually enough for legible OCR / model reading without
 *   ballooning byte size.
 * @returns {Promise<Uint8Array[]>} PNG byte arrays in the order of
 *   `pages` (or natural order for the default range). Out-of-range
 *   page indices yield an empty `Uint8Array` slot rather than
 *   throwing — keeps batch renders robust.
 */
export async function renderPdfPagesToBytes(bytes, pages, scale = 2) {
    const pdfjs = await ensurePdfJs();
    // pdf.js mutates the data buffer it's given; pass a fresh copy
    // so callers can keep using `bytes` after this returns.
    const pdf = await pdfjs.getDocument({ data: bytes.slice() }).promise;

    const pageNums = pages
        ? Array.from(pages)
        : Array.from(
              { length: Math.min(pdf.numPages, DEFAULT_MAX_PAGES) },
              (_, i) => i,
          );

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    /** @type {Uint8Array[]} */
    const results = [];
    try {
        for (const pageIdx of pageNums) {
            if (pageIdx < 0 || pageIdx >= pdf.numPages) {
                results.push(new Uint8Array());
                continue;
            }
            // pdf.js is 1-indexed; agent API mirrors py's 0-indexed.
            const page = await pdf.getPage(pageIdx + 1);
            const viewport = page.getViewport({ scale });
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            await page.render({ canvasContext: ctx, viewport }).promise;
            const blob = await new Promise((resolve) =>
                canvas.toBlob(resolve, "image/png"),
            );
            const pngBytes = new Uint8Array(await blob.arrayBuffer());
            results.push(pngBytes);
        }
    } finally {
        canvas.remove();
    }
    return results;
}

/**
 * Return the number of pages in a PDF.
 *
 * @param {Uint8Array} bytes - PDF file bytes.
 * @returns {Promise<number>}
 */
export async function getPdfPageCount(bytes) {
    const pdfjs = await ensurePdfJs();
    const pdf = await pdfjs.getDocument({ data: bytes.slice() }).promise;
    return pdf.numPages;
}
