/**
 * Screenshot grids: the frames a `test_app` call took under one grid
 * name, tiled into one captioned image, so checking a video's scenes
 * (or an app's states) costs the model one image rather than one per
 * frame.
 */

import { bytesToBase64 } from "./bytes.js";

/** The most frames one grid holds. */
export const GRID_MAX = 12;
/** The widest a grid image gets: past this, providers scale it down. */
const MAX_WIDTH = 1600;
/** The widest one frame gets in a grid. */
const CELL = 640;
/** The band under each frame its label is written in. */
const CAPTION = 34;
const GAP = 8;

/**
 * Where each frame goes: columns by count (1, 2 up to 4 frames, 3 up to
 * 9, else 4), each frame scaled to the cell width, rows as tall as
 * their tallest frame, a caption band under each.
 *
 * @param {readonly { width: number, height: number }[]} sizes
 * @returns {{ width: number, height: number, cells: { x: number, y: number, width: number, height: number, captionY: number }[] }}
 */
export function gridLayout(sizes) {
    const n = sizes.length;
    const columns = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
    const cell = Math.min(CELL, Math.floor((MAX_WIDTH - GAP * (columns + 1)) / columns));
    const scaled = sizes.map((s) => ({ width: cell, height: Math.round((s.height / Math.max(1, s.width)) * cell) }));
    /** @type {{ x: number, y: number, width: number, height: number, captionY: number }[]} */
    const cells = [];
    let y = GAP;
    for (let row = 0; row * columns < n; row++) {
        const inRow = scaled.slice(row * columns, row * columns + columns);
        const tallest = Math.max(...inRow.map((s) => s.height));
        inRow.forEach((s, i) => {
            cells.push({ x: GAP + i * (cell + GAP), y, width: s.width, height: s.height, captionY: y + tallest });
        });
        y += tallest + CAPTION + GAP;
    }
    return { width: GAP + columns * (cell + GAP), height: y, cells };
}

/**
 * The frames tiled into one PNG, each with its label under it; base64,
 * no data-URL prefix (as screenshots come). Needs a browser: it decodes
 * and draws with `createImageBitmap` and an `OffscreenCanvas`.
 *
 * @param {readonly { data: string, label: string }[]} frames base64 PNGs
 * @returns {Promise<string>}
 */
export async function tileGrid(frames) {
    const bitmaps = await Promise.all(
        frames.map(async (f) => createImageBitmap(await (await fetch(`data:image/png;base64,${f.data}`)).blob())),
    );
    const layout = gridLayout(bitmaps.map((b) => ({ width: b.width, height: b.height })));
    const canvas = new OffscreenCanvas(layout.width, layout.height);
    const g = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext("2d"));
    g.fillStyle = "#16161d";
    g.fillRect(0, 0, layout.width, layout.height);
    g.font = "600 18px system-ui, sans-serif";
    g.textBaseline = "middle";
    layout.cells.forEach((cell, i) => {
        const bitmap = /** @type {ImageBitmap} */ (bitmaps[i]);
        g.drawImage(bitmap, cell.x, cell.y, cell.width, cell.height);
        bitmap.close();
        const label = `${i + 1}${frames[i]?.label ? `  ${frames[i]?.label}` : ""}`;
        g.fillStyle = "#e8e8ee";
        g.fillText(fit(g, label, cell.width - 8), cell.x + 4, cell.captionY + CAPTION / 2);
    });
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

/** `text` cut to fit `width` in the canvas's font, with an ellipsis.
 *  @param {OffscreenCanvasRenderingContext2D} g @param {string} text @param {number} width */
function fit(g, text, width) {
    if (g.measureText(text).width <= width) return text;
    let cut = text;
    while (cut.length > 1 && g.measureText(`${cut}…`).width > width) cut = cut.slice(0, -1);
    return `${cut}…`;
}
