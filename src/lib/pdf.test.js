import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Pdf, _setPdfjsForTesting, pageText } from "./pdf.js";

/** A stand-in for pdf.js: a document of `texts.length` pages, each
 *  page's text its entry, rendered 100x150 per unit of scale. */
function fakePdfjs(/** @type {string[]} */ texts) {
    return {
        getDocument: (/** @type {{ data: Uint8Array }} */ { data }) => ({
            promise:
                data[0] === 0x25
                    ? Promise.resolve({
                          numPages: texts.length,
                          getPage: async (/** @type {number} */ n) => ({
                              getViewport: ({ scale }) => ({ width: 100 * scale, height: 150 * scale }),
                              render: () => ({ promise: Promise.resolve() }),
                              getTextContent: async () => ({
                                  items: (texts[n - 1] ?? "")
                                      .split(" ")
                                      .map((str, i, all) => ({ str, hasEOL: i < all.length - 1, transform: [10, 0, 0, 10, 0, 700 - 12 * i], width: 20 })),
                              }),
                          }),
                      })
                    : Promise.reject(new Error("Invalid PDF structure")),
        }),
    };
}

function fakeWs() {
    /** @type {Map<string, Uint8Array>} */
    const files = new Map([
        ["/workspace/docs/report.pdf", new Uint8Array([0x25, 0x50, 0x44, 0x46])],
        ["/workspace/notes.txt", new Uint8Array([0x68, 0x69])],
    ]);
    const fs = {
        async mkdir() {},
        async write(/** @type {string} */ path, /** @type {Uint8Array} */ data) {
            files.set(path, data);
        },
        async read(/** @type {string} */ path) {
            const data = files.get(path);
            if (data === undefined) throw new Error("ENOENT");
            return data;
        },
    };
    return { ws: /** @type {any} */ ({ root: "/workspace", files: { fs } }), files };
}

beforeEach(() => {
    _setPdfjsForTesting(fakePdfjs(["one a", "two b", "three c"]));
    // a canvas that encodes to a 3-byte "PNG"
    vi.stubGlobal("document", {
        createElement: () => ({
            width: 0,
            height: 0,
            getContext: () => ({}),
            toBlob: (/** @type {(b: Blob) => void} */ done) => done(new Blob([new Uint8Array([1, 2, 3])])),
            remove() {},
        }),
    });
});

afterEach(() => {
    _setPdfjsForTesting(null);
    vi.unstubAllGlobals();
});

describe("pdf", () => {
    it("counts pages and reads their text, numbered from 1", async () => {
        const pdf = new Pdf(fakeWs().ws);
        expect(await pdf.pages("docs/report.pdf")).toBe(3);
        expect(await pdf.text("/workspace/docs/report.pdf", { pages: [2] })).toEqual([{ page: 2, text: "two\nb" }]);
        expect((await pdf.text("docs/report.pdf")).map((p) => p.page)).toEqual([1, 2, 3]);
    });

    it("renders pages to PNGs beside the PDF, or in the dir asked", async () => {
        const { ws, files } = fakeWs();
        const pdf = new Pdf(ws);
        expect(await pdf.render("docs/report.pdf", { pages: [1, 3] })).toEqual([
            { page: 1, path: "/workspace/docs/report-pages/page-1.png", width: 200, height: 300 },
            { page: 3, path: "/workspace/docs/report-pages/page-3.png", width: 200, height: 300 },
        ]);
        expect([...(files.get("/workspace/docs/report-pages/page-3.png") ?? [])]).toEqual([1, 2, 3]);
        const out = await pdf.render("docs/report.pdf", { scale: 1, dir: "shots" });
        expect(out.map((p) => p.path)).toEqual(["/workspace/shots/page-1.png", "/workspace/shots/page-2.png", "/workspace/shots/page-3.png"]);
        expect(out[0]?.width).toBe(100);
    });

    it("names what is wrong: no file, not a PDF, no such page, outside the workspace", async () => {
        const pdf = new Pdf(fakeWs().ws);
        await expect(pdf.pages("missing.pdf")).rejects.toThrow("pdf.pages: no file at /workspace/missing.pdf");
        await expect(pdf.pages("notes.txt")).rejects.toThrow(/could not be read as a PDF: Invalid PDF structure/);
        await expect(pdf.render("docs/report.pdf", { pages: [0] })).rejects.toThrow("pdf.render: there is no page 0; the PDF has 3, numbered from 1");
        await expect(pdf.text("/etc/x.pdf")).rejects.toThrow(/is outside \/workspace/);
    });
});

describe("pageText", () => {
    /** An item of `str` at (x, y), `width` wide, in a 10pt font. */
    const at = (str, x, y, width, hasEOL = false) => ({ str, transform: [10, 0, 0, 10, x, y], width, height: 10, hasEOL });

    it("puts a space at a gap along a line, a break where the line changes, and nothing between abutting runs", () => {
        const items = [
            at("Total:", 72, 700, 30),
            at("$10", 106, 700, 18), // a gap: a space
            at("Cardamom", 72, 686, 50), // the next line, no hasEOL: a break
            at("bun", 122, 686, 18), // abutting (a font change mid-word): nothing
            { type: "beginMarkedContent" },
            at("4.00", 200, 686, 20, true),
            at("", 0, 0, 0, true), // an empty line end
            at("Rye", 72, 660, 18),
        ];
        expect(pageText(items)).toBe("Total: $10\nCardamombun 4.00\n\nRye");
    });

    it("doesn't double a space the text already has", () => {
        expect(pageText([at("a ", 0, 0, 10), at("b", 20, 0, 5), at(" c", 40, 0, 5)])).toBe("a b c");
    });
});
