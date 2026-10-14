/**
 * `pdf`, a host object: a workspace PDF's page count, its pages as PNGs
 * written into the workspace (for view_image), and its text.
 *
 * pdf.js needs a canvas, so it runs here on the page, not in the code's
 * worker; it loads from the jsDelivr CDN on first use, its own worker
 * with it. Pages are numbered from 1, as a reader shows them.
 */

import { hostFactory, typedHost, withCall } from "@agex-ts/world";
import { z } from "zod";
import { inWorkspace, parentOf, writeFile } from "./ws-paths.js";

const PDFJS_CDN = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build";

/** The pages rendered when none are named: bounds "render this PDF"
 *  against an 800-page document. */
export const DEFAULT_PAGES = 20;

/** @type {any} */
let pdfjs = null;

async function loadPdfjs() {
    if (pdfjs !== null) return pdfjs;
    const mod = await import(/* @vite-ignore */ `${PDFJS_CDN}/pdf.min.mjs`);
    mod.GlobalWorkerOptions.workerSrc = `${PDFJS_CDN}/pdf.worker.min.mjs`;
    pdfjs = mod;
    return mod;
}

/** Test seam: a stand-in for pdf.js, with its `getDocument({data})
 *  .promise` → `{numPages, getPage(n)}` shape; null restores the real
 *  one. @param {any} fake */
export function _setPdfjsForTesting(fake) {
    pdfjs = fake;
}

/** A canvas's PNG bytes. @param {HTMLCanvasElement} canvas */
async function pngOf(canvas) {
    const blob = await new Promise((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("the page could not be encoded"))), "image/png"),
    );
    return new Uint8Array(await /** @type {Blob} */ (blob).arrayBuffer());
}

/**
 * A page's text from pdf.js's text items, with the separators their
 * positions imply: pdf.js marks some line ends (`hasEOL`) but not the
 * space between two runs of text (a change of font, a table's cells),
 * so a gap along the line is a space and a move to another line is a
 * line break.
 *
 * @param {any[]} items
 */
export function pageText(items) {
    let text = "";
    /** @type {{ y: number, end: number } | null} */
    let last = null;
    for (const item of items) {
        if (typeof item?.str !== "string") continue; // marked content, no text
        const [, , c = 0, d = 0, x = 0, y = 0] = Array.isArray(item.transform) ? item.transform : [];
        // the font's size, from its matrix
        const size = Math.hypot(c, d) || item.height || 1;
        if (last !== null && item.str !== "" && !text.endsWith("\n")) {
            if (Math.abs(y - last.y) > size / 2) text += "\n";
            else if (x - last.end > size * 0.1 && !/\s$/.test(text) && !/^\s/.test(item.str)) text += " ";
        }
        text += item.str;
        if (item.hasEOL) text += "\n";
        if (item.str !== "" || item.hasEOL) last = { y, end: x + (item.width ?? 0) };
    }
    return text.trim();
}

/** @typedef {import("@agex-ts/world").Workspace} Workspace */
/** @typedef {import("@agex-ts/world").HostCall} HostCall */

/** Read the PDFs in one session's workspace. */
export class Pdf {
    /** @param {Workspace} ws */
    constructor(ws) {
        this._ws = ws;
    }

    /** How many pages the PDF at `path` has. */
    pages = withCall(
        /** @param {HostCall | undefined} call @param {string} path */
        async (call, path) => (await this._open(call, "pdf.pages", path)).doc.numPages,
    );

    /**
     * Render pages of the PDF at `path` to PNGs: `pages` (from 1; the
     * first 20 when left out) at `scale` (2, about 144 DPI, by default),
     * each written to `dir` (by default `<name>-pages/` beside the PDF) as
     * `page-<n>.png`.
     */
    render = withCall(
        /**
         * @param {HostCall | undefined} call
         * @param {string} path
         * @param {{ pages?: number[], scale?: number, dir?: string }} [options]
         */
        async (call, path, options = {}) => {
            const { doc, src, fs } = await this._open(call, "pdf.render", path);
            const pages = this._pages("pdf.render", doc.numPages, options.pages, DEFAULT_PAGES);
            const stem = src.slice(src.lastIndexOf("/") + 1).replace(/\.pdf$/i, "");
            const dir = inWorkspace("pdf.render", this._ws.root, options.dir ?? `${parentOf(src)}/${stem}-pages`);
            const scale = options.scale ?? 2;
            const canvas = document.createElement("canvas");
            const out = [];
            try {
                for (const n of pages) {
                    const page = await doc.getPage(n);
                    const viewport = page.getViewport({ scale });
                    canvas.width = Math.ceil(viewport.width);
                    canvas.height = Math.ceil(viewport.height);
                    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
                    const target = `${dir}/page-${n}.png`;
                    await writeFile(fs, target, await pngOf(canvas));
                    out.push({ page: n, path: target, width: canvas.width, height: canvas.height });
                }
            } finally {
                canvas.remove();
            }
            return out;
        },
    );

    /**
     * The text of pages of the PDF at `path` (from 1; every page when
     * left out), as `{page, text}`: what the PDF holds as text, so a
     * scanned page reads empty (render it instead).
     */
    text = withCall(
        /**
         * @param {HostCall | undefined} call
         * @param {string} path
         * @param {{ pages?: number[] }} [options]
         */
        async (call, path, options = {}) => {
            const { doc } = await this._open(call, "pdf.text", path);
            const out = [];
            for (const n of this._pages("pdf.text", doc.numPages, options.pages, doc.numPages)) {
                const content = await (await doc.getPage(n)).getTextContent();
                out.push({ page: n, text: pageText(content.items) });
            }
            return out;
        },
    );

    /** @param {HostCall | undefined} call @param {string} label @param {string} path */
    async _open(call, label, path) {
        const fs = (call?.ws ?? this._ws).files.fs;
        const src = inWorkspace(label, this._ws.root, path);
        /** @type {Uint8Array} */
        let bytes;
        try {
            bytes = await fs.read(src);
        } catch {
            throw new Error(`${label}: no file at ${src}`);
        }
        const lib = await loadPdfjs();
        let doc;
        try {
            // pdf.js takes over the buffer it is given: hand it a copy
            doc = await lib.getDocument({ data: bytes.slice() }).promise;
        } catch (e) {
            throw new Error(`${label}: ${src} could not be read as a PDF: ${e instanceof Error ? e.message : String(e)}`);
        }
        return { doc, src, fs };
    }

    /** The pages asked for, checked, or the first `fallback`.
     *  @param {string} label @param {number} count @param {number[] | undefined} asked @param {number} fallback */
    _pages(label, count, asked, fallback) {
        if (asked === undefined) return Array.from({ length: Math.min(count, fallback) }, (_, i) => i + 1);
        for (const n of asked) {
            if (n < 1 || n > count) throw new Error(`${label}: there is no page ${n}; the PDF has ${count}, numbered from 1`);
        }
        return asked;
    }
}

const pageList = z.array(z.number().int()).optional();

/** `pdf` as the profile grants it: one per session, its arguments
 *  checked. */
export function pdfHost() {
    return typedHost(
        hostFactory((ws) => new Pdf(ws)),
        {
            pages: { args: { path: z.string() }, returns: z.number() },
            render: {
                args: {
                    path: z.string(),
                    options: z
                        .strictObject({ pages: pageList, scale: z.number().min(0.5).max(4).optional(), dir: z.string().optional() })
                        .optional(),
                },
                returns: z.array(z.object({ page: z.number(), path: z.string(), width: z.number(), height: z.number() })),
            },
            text: {
                args: { path: z.string(), options: z.strictObject({ pages: pageList }).optional() },
                returns: z.array(z.object({ page: z.number(), text: z.string() })),
            },
        },
    );
}
