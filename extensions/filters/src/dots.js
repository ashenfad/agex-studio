/**
 * The toolbar icon's dot, on a site's tabs, as the studio marks its
 * sessions: the extension's braces with a dot drawn in their corner, in
 * the studio's colours.
 *
 * - `working`: the site's agent is at work (the studio's accent).
 * - `ready`: a filter waits to be previewed (green).
 * - `stopped`: the last turn stopped, or ended without a filter, and the
 *   person hasn't looked since (amber).
 */

/** @typedef {"working" | "ready" | "stopped"} Dot */

/** The dots' colours: the studio's --accent, --success and --caution. */
export const DOT_COLORS = { working: "#e94560", ready: "#4caf50", stopped: "#d9a441" };

/** The icon's sizes on the toolbar. */
const SIZES = [16, 32];

/** The plain icon, as bitmaps by size, read once. @type {Promise<Record<number, ImageBitmap>> | null} */
let plain = null;

/** @returns {Promise<Record<number, ImageBitmap>>} */
function bitmaps() {
    plain ??= Promise.all(
        SIZES.map(async (size) => /** @type {const} */ ([size, await createImageBitmap(await (await fetch(`icons/${size}.png`)).blob())])),
    ).then((pairs) => Object.fromEntries(pairs));
    return plain;
}

/**
 * The icon with `dot` in its lower right, at each size.
 *
 * @param {Dot} dot
 * @returns {Promise<Record<number, ImageData>>}
 */
async function dotted(dot) {
    const base = await bitmaps();
    /** @type {Record<number, ImageData>} */
    const out = {};
    for (const size of SIZES) {
        const canvas = new OffscreenCanvas(size, size);
        const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext("2d"));
        ctx.drawImage(base[size], 0, 0, size, size);
        ctx.beginPath();
        ctx.arc(size * 0.74, size * 0.74, size * 0.24, 0, 2 * Math.PI);
        ctx.fillStyle = DOT_COLORS[dot];
        ctx.fill();
        // a light ring, so the dot reads on a dark toolbar and a light one
        ctx.lineWidth = Math.max(1, size * 0.06);
        ctx.strokeStyle = "rgba(255, 255, 255, 0.6)";
        ctx.stroke();
        out[size] = ctx.getImageData(0, 0, size, size);
    }
    return out;
}

/**
 * Tab `tabId`'s icon: with `dot`, or plain for none.
 *
 * @param {number} tabId @param {Dot | null} dot
 */
export async function paint(tabId, dot) {
    if (dot === null) await chrome.action.setIcon({ tabId, path: Object.fromEntries(SIZES.map((s) => [s, `icons/${s}.png`])) });
    else await chrome.action.setIcon({ tabId, imageData: await dotted(dot) });
}
