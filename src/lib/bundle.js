/**
 * Bundles: a session as one file (`.agex`), to keep, share or open
 * elsewhere.
 *
 * A bundle is a line naming the format, a line of JSON saying what it
 * holds, and a kvgit pack (gzip CBOR, as sync pushes: see kvgit's
 * "Pack sync") of the session's commits from its root:
 *
 *     agex-bundle 1\n
 *     {"title": …, "head": …, "shape": "everything" | "current", …}\n
 *     <pack bytes>
 *
 * `everything` carries the whole history; `current` one commit holding
 * the session as it is now (see `snapshot`), a fraction of the size.
 * Opening one imports it as a new session (a fork of what it holds, so
 * its conversation is that session's own), or switches to the session
 * an earlier import of it made.
 */

import { applyWire, walkDelta } from "@agex-ts/kvgit";
import { decodePack, encodePack } from "@agex-ts/kvgit/github";

export const BUNDLE_MAGIC = "agex-bundle 1\n";

/**
 * What a bundle says it holds.
 *
 * @typedef {{ format: 1, title: string, head: string, shape: "everything" | "current", commits: number, exportedAt: number }} BundleHeader
 */

/**
 * The commits from the root to `head`, as a bundle.
 *
 * @param {import("@agex-ts/kvgit").KVStore} kv
 * @param {string} head
 * @param {{ title: string, shape: BundleHeader["shape"] }} about
 */
export async function encodeBundle(kv, head, about) {
    /** @type {import("@agex-ts/kvgit").WireCommit[]} */
    const commits = [];
    for await (const wc of walkDelta(kv, { want: head })) commits.push(wc);
    const pack = await encodePack(commits, { kernel: "ts", base: null });
    /** @type {BundleHeader} */
    const header = { format: 1, title: about.title, head, shape: about.shape, commits: commits.length, exportedAt: Date.now() };
    const top = new TextEncoder().encode(`${BUNDLE_MAGIC}${JSON.stringify(header)}\n`);
    const out = new Uint8Array(top.length + pack.length);
    out.set(top, 0);
    out.set(pack, top.length);
    return out;
}

/**
 * A bundle's header and where its pack starts; an error naming what is
 * wrong when the bytes aren't a bundle this studio reads.
 *
 * @param {Uint8Array} bytes
 * @returns {{ header: BundleHeader, packAt: number }}
 */
export function readBundleHeader(bytes) {
    const magic = new TextEncoder().encode(BUNDLE_MAGIC);
    if (bytes.length < magic.length || magic.some((b, i) => bytes[i] !== b)) {
        throw new Error("this isn't an agex studio bundle (.agex)");
    }
    const end = bytes.indexOf(0x0a, magic.length);
    if (end < 0) throw new Error("the bundle's header is cut short");
    /** @type {any} */
    let header;
    try {
        header = JSON.parse(new TextDecoder().decode(bytes.subarray(magic.length, end)));
    } catch {
        throw new Error("the bundle's header isn't JSON");
    }
    if (header?.format !== 1 || typeof header.head !== "string") {
        throw new Error(`the bundle is format ${JSON.stringify(header?.format)}, which this studio doesn't read`);
    }
    return { header: { ...header, title: typeof header.title === "string" ? header.title : "" }, packAt: end + 1 };
}

/**
 * Write a bundle's commits into `kv` as branch `branch` (which must not
 * exist); its header.
 *
 * @param {import("@agex-ts/kvgit").KVStore} kv
 * @param {Uint8Array} bytes
 * @param {string} branch
 */
export async function applyBundle(kv, bytes, branch) {
    const { header, packAt } = readBundleHeader(bytes);
    const pack = await decodePack(bytes.subarray(packAt));
    if (pack.tip !== header.head) throw new Error("the bundle's pack doesn't end at the head its header names");
    await applyWire(kv, pack.commits, { createBranch: branch });
    return header;
}

/** A file name for a bundle of a session titled `title`. @param {string} title */
export function bundleFileName(title) {
    const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 50);
    return `${slug || "session"}.agex`;
}
