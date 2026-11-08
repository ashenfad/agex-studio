/**
 * Images as a session keeps them. A screenshot is stored in its turn's
 * record, so every later commit holds it, and it travels wherever the
 * session does: its sync (where one commit has to fit in one request),
 * its bundles and its gists. So an image is kept re-encoded when it is
 * large and the re-encoding is much smaller:
 *
 * - `compactImage`, for an image a tool just returned: WebP at the
 *   quality a request's images are fitted at. A screenshot of a busy
 *   page (a map, a game, a photo) is several times smaller as WebP than
 *   as PNG; a small or flat one, whose PNG is already small, is kept as
 *   it came, every pixel.
 * - `thumbnailImage`, for an image the model is no longer sent (a fold
 *   replaced the messages it's in with a summary), which only the
 *   transcript still shows: its longest side at most `THUMB_SIDE`, at a
 *   lower quality.
 *
 * An image this browser can't decode or encode is kept as it came.
 */

import { reencode as browserReencode } from "./image-fit.js";

/** @typedef {{ data: string, mediaType: string }} Img */
/** @typedef {(image: Img, opts: { maxSide?: number, quality?: number }) => Promise<Img>} Reencode */

/** An image with no more base64 than this is kept as it came. */
export const COMPACT_MIN = 100_000;
/** The most a re-encoding may be, as a share of the original's base64,
 *  to be kept in its place: a smaller saving isn't worth the loss. */
export const KEEP_RATIO = 0.75;
/** A thumbnail's longest side, in pixels. */
export const THUMB_SIDE = 640;
/** A thumbnail's quality. */
export const THUMB_QUALITY = 0.7;

/**
 * `image` as a session keeps it when a tool returns it: re-encoded as
 * WebP when that pays, else as it came.
 *
 * @param {Img} image
 * @param {{ reencode?: Reencode }} [opts]
 * @returns {Promise<Img>}
 */
export function compactImage(image, { reencode = browserReencode } = {}) {
    return smaller(image, () => reencode(image, {}));
}

/**
 * `image` as a thumbnail for the transcript, when that pays, else as it
 * came.
 *
 * @param {Img} image
 * @param {{ reencode?: Reencode }} [opts]
 * @returns {Promise<Img>}
 */
export function thumbnailImage(image, { reencode = browserReencode } = {}) {
    return smaller(image, () => reencode(image, { maxSide: THUMB_SIDE, quality: THUMB_QUALITY }));
}

/** What `make` gives for `image` when `image` is past `COMPACT_MIN` and
 *  that is at most `KEEP_RATIO` of it; else `image`.
 *  @param {Img} image @param {() => Promise<Img>} make @returns {Promise<Img>} */
async function smaller(image, make) {
    if (typeof image.data !== "string" || image.data.length <= COMPACT_MIN) return image;
    try {
        const out = await make();
        return out.data.length <= image.data.length * KEEP_RATIO ? out : image;
    } catch {
        return image;
    }
}
