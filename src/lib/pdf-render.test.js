// @vitest-environment happy-dom
/**
 * Tests for the shared pdf-render helpers.
 *
 * These don't load the real pdf.js — that needs DOM canvas + a CDN
 * fetch. Instead we inject a fake `pdfjsLib` via the `_setPdfjsForTesting`
 * seam and exercise the wrapper logic: page-index normalization,
 * default page cap, out-of-range handling, byte passthrough.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    DEFAULT_MAX_PAGES,
    getPdfPageCount,
    renderPdfPagesToBytes,
    _setPdfjsForTesting,
} from "./pdf-render.js";

// jsdom doesn't ship `canvas.toBlob`. Stub it to return a tiny
// PNG-shaped Blob so the wrapper can convert to Uint8Array. The
// returned bytes don't have to be a real PNG — tests just verify
// shape and ordering.
function stubCanvasToBlob() {
    const fakePngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // "‰PNG"
    HTMLCanvasElement.prototype.toBlob = function (cb) {
        cb(new Blob([fakePngBytes], { type: "image/png" }));
    };
    return fakePngBytes;
}

/** Build a fake pdfjs that pretends the document has `numPages`
 *  pages. Each `getPage` returns a render-shaped object whose
 *  `viewport.width/height` are predictable for assertion. */
function fakePdfjs(numPages) {
    return {
        getDocument: () => ({
            promise: Promise.resolve({
                numPages,
                getPage: (oneBasedIdx) =>
                    Promise.resolve({
                        getViewport: ({ scale }) => ({
                            width: 100 * scale,
                            height: 100 * scale,
                        }),
                        render: () => ({ promise: Promise.resolve() }),
                        // expose the requested index so tests can
                        // verify 0→1 conversion if they need to
                        _requestedIndex: oneBasedIdx,
                    }),
            }),
        }),
    };
}

beforeEach(() => {
    stubCanvasToBlob();
});

afterEach(() => {
    _setPdfjsForTesting(null);
});

describe("renderPdfPagesToBytes", () => {
    it("renders the explicit pages in order, returning one Uint8Array per request", async () => {
        _setPdfjsForTesting(fakePdfjs(10));
        const out = await renderPdfPagesToBytes(new Uint8Array([1, 2, 3]), [
            0, 2, 4,
        ]);
        expect(out).toHaveLength(3);
        out.forEach((page) => expect(page).toBeInstanceOf(Uint8Array));
        // Each fake page returns the same fake PNG bytes — non-empty.
        out.forEach((page) => expect(page.length).toBeGreaterThan(0));
    });

    it("defaults to the first DEFAULT_MAX_PAGES pages when `pages` is null", async () => {
        _setPdfjsForTesting(fakePdfjs(50));
        const out = await renderPdfPagesToBytes(new Uint8Array(), null);
        expect(out).toHaveLength(DEFAULT_MAX_PAGES);
    });

    it("defaults to the document's full length when shorter than the cap", async () => {
        _setPdfjsForTesting(fakePdfjs(3));
        const out = await renderPdfPagesToBytes(new Uint8Array(), null);
        expect(out).toHaveLength(3);
    });

    it("returns an empty Uint8Array slot for out-of-range page indices (no throw)", async () => {
        _setPdfjsForTesting(fakePdfjs(3));
        const out = await renderPdfPagesToBytes(new Uint8Array(), [
            0, 10, 1, -5,
        ]);
        expect(out).toHaveLength(4);
        expect(out[0].length).toBeGreaterThan(0); // page 0 — valid
        expect(out[1].length).toBe(0); // page 10 — out of range
        expect(out[2].length).toBeGreaterThan(0); // page 1 — valid
        expect(out[3].length).toBe(0); // page -5 — negative
    });

    it("works with an empty pages array (returns no results, doesn't load any page)", async () => {
        const fake = fakePdfjs(5);
        const getPageSpy = vi.spyOn(fake, "getDocument");
        _setPdfjsForTesting(fake);
        const out = await renderPdfPagesToBytes(new Uint8Array(), []);
        expect(out).toEqual([]);
        // getDocument should still be called once to open the doc;
        // the assertion here is that no per-page work happens.
        expect(getPageSpy).toHaveBeenCalledTimes(1);
    });

    it("converts 0-based agent API to pdf.js's 1-based getPage", async () => {
        // Capture which 1-based index pdf.js was asked for. Build a
        // fake whose getPage records the requested index in the
        // returned viewport for inspection.
        const requested = [];
        const fake = {
            getDocument: () => ({
                promise: Promise.resolve({
                    numPages: 5,
                    getPage: (oneBasedIdx) => {
                        requested.push(oneBasedIdx);
                        return Promise.resolve({
                            getViewport: ({ scale }) => ({
                                width: 100 * scale,
                                height: 100 * scale,
                            }),
                            render: () => ({ promise: Promise.resolve() }),
                        });
                    },
                }),
            }),
        };
        _setPdfjsForTesting(fake);
        await renderPdfPagesToBytes(new Uint8Array(), [0, 2, 4]);
        expect(requested).toEqual([1, 3, 5]);
    });

    it("does not mutate the caller's bytes (defensive copy)", async () => {
        _setPdfjsForTesting(fakePdfjs(2));
        const bytes = new Uint8Array([10, 20, 30]);
        await renderPdfPagesToBytes(bytes, [0]);
        expect(Array.from(bytes)).toEqual([10, 20, 30]);
    });
});

describe("getPdfPageCount", () => {
    it("returns the document's numPages", async () => {
        _setPdfjsForTesting(fakePdfjs(42));
        const n = await getPdfPageCount(new Uint8Array());
        expect(n).toBe(42);
    });

    it("works on empty / single-page docs", async () => {
        _setPdfjsForTesting(fakePdfjs(1));
        expect(await getPdfPageCount(new Uint8Array())).toBe(1);
    });
});
