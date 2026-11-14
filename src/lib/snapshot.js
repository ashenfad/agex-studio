/**
 * A session as it is now, without its history: a short run of commits
 * from the root whose last holds what a commit holds, less what only
 * makes sense with the history behind it.
 *
 * Left out: the cache (it rebuilds), the agent's own git (its commits
 * are in the history that goes), and the studio's record of where each
 * turn started (what undo checks out, also in that history). The files,
 * the conversation, its folds, and the rest stay.
 *
 * A sync pushes a session in packs of whole commits, one request each,
 * and a request has to reach GitHub within a few seconds
 * (`sync-limits.js`), so a commit much larger than `PACK_BYTES` may
 * never sync. A long session's files and conversation together are far
 * more, so a snapshot is written in parts of at most `PART_BYTES`, each
 * a commit adding to the one before (`snapshotBranch`).
 *
 * The conversation's images are made small on the way
 * (`compactConversation`): in a long session with screenshots nearly
 * all of its bytes are those screenshots, and a snapshot travels
 * wherever the session does (its sync, its bundles, its gists).
 */

import { CACHE_PREFIX, CONVERSATION_INDEX_KEY, CONVERSATION_RUN_PREFIX, FILE_PREFIX, FOLD_PREFIX, GIT_KEY, META_PREFIX, PLANE_PREFIX, inForce } from "@agex-ts/world";
import { compactImage, thumbnailImage } from "./image-compact.js";
import { PACK_BYTES } from "./sync-limits.js";

/** The studio's per-turn undo points, on its plane. */
const TURNS_PREFIX = `${PLANE_PREFIX}studio/turns/`;

/**
 * The most stored bytes one commit of a snapshot holds (less, when its
 * values don't divide evenly): what a sync gathers into one pack, so
 * each part is a pack of its own or shares one. A single value larger
 * than this still gets a commit of its own, which syncs only if it
 * reaches GitHub in time.
 */
export const PART_BYTES = PACK_BYTES;

/** Whether a snapshot keeps `key`. @param {string} key */
export function kept(key) {
    return !key.startsWith(CACHE_PREFIX) && key !== GIT_KEY && !key.startsWith(TURNS_PREFIX);
}

/** @typedef {import("./image-compact.js").Img} Img */
/** @typedef {{ compact?: (image: Img) => Promise<Img>, thumbnail?: (image: Img) => Promise<Img> }} ImageOptions */

/**
 * Branch `branch` (new) at a snapshot of commit `at`; its head.
 *
 * The snapshot is one commit when it fits in `partBytes`, else one
 * commit per part (`snapshotParts`), each recording `part` ("2/5") in
 * its info beside the rest. Only the last holds the whole session.
 *
 * @param {import("@agex-ts/world").Store} store
 * @param {string} at
 * @param {string} branch
 * @param {Record<string, unknown>} [info]
 * @param {ImageOptions & { partBytes?: number }} [opts] how its images
 *   are made small (`compactConversation`), and the most one commit holds
 */
export async function snapshotBranch(store, at, branch, info = {}, { partBytes = PART_BYTES, ...images } = {}) {
    const repo = store.repo;
    const source = await repo.snapshot({ commit: at });
    const keys = (await source.keys()).filter(kept);
    const values = await compactConversation(await source.getMany(keys), images);
    const parts = snapshotParts(values, (value) => repo.codec.encode(value).byteLength, partBytes);
    await repo.branches.create(branch);
    const wt = await repo.worktree(branch);
    let head = null;
    for (const [i, part] of parts.entries()) {
        for (const key of part) wt.set(key, values.get(key));
        const result = await wt.commit({
            info: { tool: "studio.snapshot", from: at, ...info, ...(parts.length > 1 && { part: `${i + 1}/${parts.length}` }) },
        });
        head = result.commit;
    }
    return /** @type {string} */ (head);
}

/**
 * The keys of `values` in the parts a snapshot commits them in: in
 * order, each part as many keys as fit in `limit` bytes (`sizeOf` a
 * value), a value larger than `limit` a part of its own. Always at least
 * one part.
 *
 * A sync that stops partway (a push lands pack by pack) leaves the
 * session at the end of some part, so they go in the order that leaves
 * the most sense behind: the files, then the conversation's runs, then
 * the rest (the conversation's index and folds, the studio's records),
 * so a run is there before the index names it.
 *
 * @param {Map<string, unknown>} values
 * @param {(value: unknown) => number} sizeOf
 * @param {number} limit
 * @returns {string[][]}
 */
export function snapshotParts(values, sizeOf, limit) {
    /** @param {string} key */
    const rank = (key) => (key.startsWith(`${FILE_PREFIX}/`) || key.startsWith(`${META_PREFIX}/`) ? 0 : key.startsWith(CONVERSATION_RUN_PREFIX) ? 1 : 2);
    const keys = [...values.keys()].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
    /** @type {string[][]} */
    const parts = [];
    /** @type {string[]} */
    let part = [];
    let size = 0;
    for (const key of keys) {
        const n = sizeOf(values.get(key));
        if (part.length > 0 && size + n > limit) {
            parts.push(part);
            part = [];
            size = 0;
        }
        part.push(key);
        size += n;
    }
    parts.push(part);
    return parts;
}

/**
 * `values` (a commit's keys and values) with the conversation's images
 * made small. An image in a message the fold in force covers is one the
 * model is no longer sent, which only the transcript shows: it becomes
 * a thumbnail. Every other image is compacted, as a tool's new image
 * is. A run whose images all stay as they were keeps its body as it
 * was, and every other value is as it was.
 *
 * The runs are agex's run records: a run body's `messages`, each with
 * `parts`, a tool result's images in its `images`, as
 * `{ kind: "image", data, mediaType }`. A value of any other shape is
 * left alone.
 *
 * @param {Map<string, unknown>} values
 * @param {ImageOptions} [opts]
 * @returns {Promise<Map<string, unknown>>}
 */
export async function compactConversation(values, { compact = compactImage, thumbnail = thumbnailImage } = {}) {
    const index = /** @type {{ runs?: unknown } | undefined} */ (values.get(CONVERSATION_INDEX_KEY));
    const ids = Array.isArray(index?.runs) ? index.runs.filter((id) => typeof id === "string") : [];
    /** @type {[string, { messages: any[] }][]} */
    const runs = [];
    for (const id of ids) {
        const body = /** @type {any} */ (values.get(`${CONVERSATION_RUN_PREFIX}${id}`));
        if (Array.isArray(body?.messages)) runs.push([id, body]);
    }
    if (runs.length === 0) return values;

    // the messages in the conversation's order: what the fold in force covers
    /** @type {string[]} */
    const order = runs.flatMap(([, body]) => body.messages.map((m) => (typeof m?.id === "string" ? m.id : "")));
    const folds = [...values]
        .filter(([key, value]) => key.startsWith(FOLD_PREFIX) && typeof (/** @type {any} */ (value)?.through) === "string")
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, value]) => /** @type {import("@agex-ts/world").Fold} */ (value));
    const fold = inForce(folds, order.filter((id) => id !== ""));
    /** @type {Set<string>} */
    const folded = new Set();
    if (fold !== null) {
        // from its first message (the start, for a fold with none) through its anchor;
        // a fold whose first message isn't here covers nothing that can be told
        const start = typeof fold.first === "string" ? order.indexOf(fold.first) : 0;
        const end = order.indexOf(fold.through);
        if (start !== -1) for (const id of order.slice(start, end + 1)) if (id !== "") folded.add(id);
    }

    const out = new Map(values);
    for (const [id, body] of runs) {
        let changed = false;
        const messages = [];
        for (const message of body.messages) {
            const small = folded.has(message?.id) ? thumbnail : compact;
            let parts = message?.parts;
            if (Array.isArray(parts)) {
                const next = [];
                for (const part of parts) next.push(await smallerPart(part, small));
                if (next.some((part, i) => part !== parts[i])) parts = next;
            }
            if (parts === message?.parts) messages.push(message);
            else {
                messages.push({ ...message, parts });
                changed = true;
            }
        }
        if (changed) out.set(`${CONVERSATION_RUN_PREFIX}${id}`, { ...body, messages });
    }
    return out;
}

/** `part` with its images made small by `small`: the same part when
 *  it has none, or none changed.
 *  @param {any} part @param {(image: Img) => Promise<Img>} small */
async function smallerPart(part, small) {
    if (part?.kind !== "tool_result" || !Array.isArray(part.images)) return part;
    // one at a time: each holds a decoded bitmap and a canvas while it's re-encoded
    const images = [];
    for (const image of part.images) {
        if (typeof image?.data !== "string" || typeof image?.mediaType !== "string") {
            images.push(image);
            continue;
        }
        const out = await small({ data: image.data, mediaType: image.mediaType });
        images.push(out.data === image.data ? image : { ...image, data: out.data, mediaType: out.mediaType });
    }
    return images.some((image, i) => image !== part.images[i]) ? { ...part, images } : part;
}
