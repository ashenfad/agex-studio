/**
 * Session snapshot + size profiling — the shared core behind size-
 * reduced publishing (and, later, "compact" fork variants).
 *
 * Two constraints shape everything here:
 *
 *  1. kvgit is content-addressed and `applyWire` verifies hashes on
 *     transfer, so we can never mutate blob bytes inside an existing
 *     history ("blob surgery"). Any size reduction must produce
 *     honest, freshly-hashed commits — hence `snapshotBranch`, which
 *     copies the source TIP into a single new commit on a new branch.
 *
 *  2. The chat story view reads the event log at the tip, not the
 *     commit walk — so a flat snapshot preserves the entire visible
 *     artifact (app, files, conversation). Only undo-into-the-past is
 *     lost, plus `cache/` (agent scratch the viewer never sees).
 *
 * Image reduction happens during the snapshot copy: event values are
 * decoded (polymorphic codec), image OutputParts are stripped or
 * downsampled, and ONLY modified events are re-encoded — untouched
 * keys are copied as raw bytes, so there is no round-trip fidelity
 * risk for anything we didn't change.
 *
 * Size profiling rides the kvgit keyset pointers (`entry.meta.size`),
 * so category totals need no blob reads; only the tip's `evt/` blobs
 * are read (to measure embedded image bytes specifically).
 */

import { Hamt, Keyset, VersionedKV } from "@agex-ts/kvgit";
import {
    polymorphicDecoder,
    polymorphicEncoder,
} from "@agex-ts/termish/fs/kvgit";

const BRANCH_HEAD = (branch) => `__branch_head__${branch}`;
const COMMIT_ROOT = (commit) => `__commit_root__${commit}`;

const _dec = new TextDecoder();

/** Decode a JSON-over-UTF-8 blob; null on parse failure. */
function _loadsString(raw) {
    if (raw === null || raw === undefined) return null;
    try {
        const value = JSON.parse(_dec.decode(raw));
        return typeof value === "string" ? value : null;
    } catch {
        return null;
    }
}

/** Category for a kvgit user key. Mirrors the studio's mental model:
 *  files = the VFS, chat = event log, cache = agent scratch. */
export function keyCategory(key) {
    if (key.startsWith("f:") || key.startsWith("d:")) return "files";
    if (key.startsWith("evt/") || key === "__event_log__") return "chat";
    if (key.startsWith("cache/")) return "cache";
    return "meta";
}

/** Approximate decoded byte length of a base64 string. */
function _base64Bytes(b64) {
    return Math.floor((b64.length * 3) / 4);
}

/** Is `part` an image OutputPart ({type:'image', format, data: b64})? */
function _isImagePart(part) {
    return (
        part !== null &&
        typeof part === "object" &&
        part.type === "image" &&
        typeof part.data === "string"
    );
}

async function _tipKeyset(store, branch) {
    const head = _loadsString(await store.get(BRANCH_HEAD(branch)));
    if (head === null) throw new Error(`branch not found: ${branch}`);
    const root = _loadsString(await store.get(COMMIT_ROOT(head)));
    if (root === null) throw new Error(`malformed commit root for ${branch}`);
    return { head, keyset: Keyset.fromRoot(store, root) };
}

/**
 * Per-category byte profile for a session branch.
 *
 * @param {import('@agex-ts/kvgit').VersionedKV} versioned
 * @param {string} branch
 * @returns {Promise<{
 *   tip: { files: number, chat: number, cache: number, meta: number,
 *          images: number, total: number },
 *   history: number,
 *   total: number,
 * }>} — `tip.images` is the portion of `tip.chat` that is embedded
 *   image data; `history` is reachable-but-not-at-tip blob bytes
 *   (old file versions, removed events, …).
 */
export async function profileSession(versioned, branch) {
    const store = versioned.store;
    const { head, keyset } = await _tipKeyset(store, branch);
    const tipEntries = await keyset.materialize();

    const tip = { files: 0, chat: 0, cache: 0, meta: 0, images: 0, total: 0 };
    for (const [key, entry] of tipEntries) {
        tip[keyCategory(key)] += entry.meta.size;
        tip.total += entry.meta.size;
    }

    // Embedded images: only the tip's event blobs are read + decoded.
    // Reads fan out in parallel — this is the local store (possibly
    // worker-bridged, where serial round-trips genuinely stall), not
    // a rate-limited API.
    const imageBytes = await Promise.all(
        [...tipEntries]
            .filter(([key]) => key.startsWith("evt/"))
            .map(async ([, entry]) => {
                try {
                    const bytes = await store.get(entry.blob);
                    if (bytes === null) return 0;
                    const event = /** @type {{ parts?: unknown } | null} */ (
                        polymorphicDecoder(bytes)
                    );
                    if (!event || !Array.isArray(event.parts)) return 0;
                    return event.parts
                        .filter(_isImagePart)
                        .reduce((n, p) => n + _base64Bytes(p.data), 0);
                } catch {
                    return 0;
                }
            }),
    );
    tip.images = imageBytes.reduce((a, b) => a + b, 0);

    // Reachable-blob total across the full history — pointer sizes
    // only, deduped by blob pointer, with the shared-subtree skip
    // that keeps work proportional to unique HAMT nodes.
    const emptyH = await Hamt.emptyHash();
    const seenBlobs = new Set();
    const seenNodes = new Set();
    let total = 0;
    for await (const commit of versioned.history(head, { allParents: true })) {
        const root = _loadsString(await store.get(COMMIT_ROOT(commit)));
        if (root === null || root === emptyH) continue;
        const [entries, hamtNodes] = await Keyset.fromRoot(store, root).walk(seenNodes);
        for (const entry of entries.values()) {
            if (seenBlobs.has(entry.blob)) continue;
            seenBlobs.add(entry.blob);
            total += entry.meta.size;
        }
        for (const n of hamtNodes) seenNodes.add(n);
    }

    return { tip, history: Math.max(0, total - tip.total), total };
}

/** Downsampled screenshots land around this fraction of the original
 *  (1024px JPEG q0.75 vs full-size PNG) — an estimate for the modal,
 *  not a promise. */
const DOWNSAMPLE_ESTIMATE = 0.15;

/**
 * Approximate bundle payload sizes for each publish shape. ZIP
 * compression isn't modeled (images don't compress, text does), so
 * present these with a "~" in the UI.
 */
export function estimatePublishSizes(profile) {
    const flat = profile.tip.total - profile.tip.cache;
    return {
        full: profile.total,
        flat,
        flatDownsampled: Math.round(
            flat - profile.tip.images * (1 - DOWNSAMPLE_ESTIMATE),
        ),
        flatStripped: flat - profile.tip.images,
    };
}

/**
 * Transform the image parts of one encoded event value.
 *
 * Returns `null` when the event needs no change (not decodable as an
 * event, or no image parts, or every transform declined) — callers
 * then copy the ORIGINAL bytes, so untouched events are byte-exact by
 * construction. Otherwise returns the re-encoded bytes and how many
 * parts changed.
 *
 * @param {Uint8Array} bytes — encoded event value
 * @param {'strip' | 'downsample'} mode
 * @param {(part: {format: string, data: string, altText?: string}) =>
 *   Promise<{format: string, data: string} | null>} [transformImage]
 *   — downsampler; null result keeps the original part (graceful
 *   fallback when canvas APIs are unavailable).
 */
export async function transformEventImages(bytes, mode, transformImage = null) {
    // The decoder returns whatever was encoded; events carrying image
    // parts are the only shape this function acts on, and the guard
    // below rejects anything else.
    /** @type {{ parts?: unknown } | null} */
    let event;
    try {
        event = /** @type {{ parts?: unknown } | null} */ (polymorphicDecoder(bytes));
    } catch {
        return null;
    }
    if (event === null || typeof event !== "object" || !Array.isArray(event.parts)) {
        return null;
    }
    if (!event.parts.some(_isImagePart)) return null;

    let count = 0;
    const parts = [];
    for (const part of event.parts) {
        if (!_isImagePart(part)) {
            parts.push(part);
            continue;
        }
        if (mode === "strip") {
            parts.push({
                type: "text",
                text: part.altText
                    ? `[image removed for publishing: ${part.altText}]`
                    : "[image removed for publishing]",
            });
            count++;
        } else {
            const replaced = transformImage ? await transformImage(part) : null;
            if (replaced === null) {
                parts.push(part);
                continue;
            }
            parts.push({ ...part, format: replaced.format, data: replaced.data });
            count++;
        }
    }
    if (count === 0) return null;
    return { bytes: polymorphicEncoder({ ...event, parts }), count };
}

/**
 * Copy `sourceBranch`'s tip into a single fresh commit on
 * `destBranch` (which must not already exist), applying image
 * treatment to event values and dropping `cache/` keys. The source
 * branch is never touched; the destination has no shared history, so
 * its hashes are honestly computed over the (possibly transformed)
 * content.
 *
 * @param {import('@agex-ts/kvgit').VersionedKV} versioned
 * @param {string} sourceBranch
 * @param {string} destBranch
 * @param {{ images?: 'full' | 'strip' | 'downsample',
 *           transformImage?: ((part: {format: string, data: string, altText?: string}) =>
 *             Promise<{format: string, data: string} | null>) | null }} [opts]
 * @returns {Promise<{ branch: string, keys: number, imagesTransformed: number }>}
 */
export async function snapshotBranch(versioned, sourceBranch, destBranch, opts = {}) {
    const { images = "full", transformImage = null } = opts;
    const store = versioned.store;
    if ((await store.get(BRANCH_HEAD(destBranch))) !== null) {
        throw new Error(`snapshot destination already exists: ${destBranch}`);
    }
    const { keyset } = await _tipKeyset(store, sourceBranch);
    const tipEntries = await keyset.materialize();

    const updates = new Map();
    let imagesTransformed = 0;
    for (const [key, entry] of tipEntries) {
        if (keyCategory(key) === "cache") continue;
        let bytes = await store.get(entry.blob);
        if (bytes === null) continue;
        if (images !== "full" && key.startsWith("evt/")) {
            const transformed = await transformEventImages(bytes, images, transformImage);
            if (transformed !== null) {
                bytes = transformed.bytes;
                imagesTransformed += transformed.count;
            }
        }
        updates.set(key, bytes);
    }

    // open() creates the missing branch at an initial empty commit;
    // the single commit below carries the entire snapshot.
    const vk = await VersionedKV.open(store, { branch: destBranch });
    await vk.commit({ updates });
    return { branch: destBranch, keys: updates.size, imagesTransformed };
}
