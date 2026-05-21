/**
 * Bundle export/import for @agex-ts/kvgit-backed agex sessions.
 *
 * TypeScript port of `public/bundle.py`. Same wire format — both
 * kernels produce identical-shaped ZIPs, with one critical difference:
 * the byte content of commits / nodes / blobs is **encoder-specific**.
 * A bundle exported from the Py kernel is not importable on the Ts
 * kernel and vice versa, because kvgit-py's encoder (Python pickle-
 * extended) and @agex-ts/kvgit's polymorphic encoder produce incompatible
 * byte sequences for the same logical content.  The manifest's
 * `kernel` field is the discriminator the studio uses to route
 * imports to the correct kernel adapter.
 *
 * Wire format (v1) — kernel-agnostic JSON in the manifest, kernel-
 * specific binary everywhere else:
 *
 *     manifest.json
 *     kvgit/commits/<commit_hash>.root    (COMMIT_ROOT bytes)
 *     kvgit/commits/<commit_hash>.parent  (PARENT_COMMIT bytes)
 *     kvgit/commits/<commit_hash>.time    (COMMIT_TIME bytes)
 *     kvgit/commits/<commit_hash>.info    (INFO_KEY bytes, optional)
 *     kvgit/nodes/<node_hash>             (HAMT node bytes)
 *     kvgit/blobs.json                    (ordered list of blob keys)
 *     kvgit/blobs/<i>                     (blob value bytes; index into blobs.json)
 *
 * Blob keys look like `<commit_hash>:<user_key>` and `<user_key>` can
 * contain arbitrary characters, so blobs are stored by integer index
 * and the original keys live in a side manifest rather than the
 * filename.
 */

import { Hamt, Keyset } from "@agex-ts/kvgit";
import { unzipSync, zipSync, strToU8 } from "fflate";

/**
 * @typedef {import('@agex-ts/kvgit').VersionedKV} VersionedKV
 * @typedef {import('@agex-ts/kvgit').KVStore} KVStore
 */

const FORMAT_VERSION = 1;
const RUNTIME_VERSION = "agex-studio-v1";
const KEYSET_PREFIX = Keyset.DEFAULT_PREFIX;

const BRANCH_HEAD = (branch) => `__branch_head__${branch}`;
const COMMIT_ROOT = (commit) => `__commit_root__${commit}`;
const PARENT_COMMIT = (commit) => `__parent_commit__${commit}`;
const COMMIT_TIME = (commit) => `__commit_time__${commit}`;
const INFO_KEY = (commit) => `__info__${commit}`;

const _textEncoder = new TextEncoder();
const _textDecoder = new TextDecoder();

function _noop() {}

// @agex-ts/kvgit encodes branch HEADs / commit roots etc. via a JSON-over-
// UTF-8 codec (`encoding.dumps` in @agex-ts/kvgit is `JSON.stringify` →
// UTF-8 encode). We replicate just the two shapes we need: read a
// stored string blob (the HEAD's commit-hash value) and write one
// (when minting a fresh BRANCH_HEAD on import).

/** Decode a JSON-over-UTF-8 blob; return null on parse failure. */
function _safeLoadsString(raw) {
    if (raw === null || raw === undefined) return null;
    try {
        const text = _textDecoder.decode(raw);
        const value = JSON.parse(text);
        return typeof value === "string" ? value : null;
    } catch {
        return null;
    }
}

/** Encode a string as JSON-over-UTF-8. */
function _dumpsString(value) {
    return _textEncoder.encode(JSON.stringify(value));
}

/**
 * Walk reachable commits / nodes / blobs from `head`. Streams progress
 * as `progress("walking", done, total)` after the commit list is known.
 *
 * @param {VersionedKV} versioned
 * @param {string} head
 * @param {(phase: string, done: number, total: number) => void} progress
 * @returns {Promise<{ commits: string[], nodes: string[], blobs: string[] }>}
 */
async function _walkReachable(versioned, head, progress) {
    const store = versioned.store;
    const allCommits = [];
    for await (const c of versioned.history(head, { allParents: true })) {
        allCommits.push(c);
    }
    const total = allCommits.length;
    const nodes = new Set();
    const blobs = new Set();

    progress("walking", 0, total);
    const emptyH = await Hamt.emptyHash();
    for (let i = 0; i < allCommits.length; i++) {
        const commit = allCommits[i];
        const rootBytes = await store.get(COMMIT_ROOT(commit));
        if (rootBytes !== null) {
            const root = _safeLoadsString(rootBytes);
            if (root && root !== emptyH) {
                // Pass the cumulative `nodes` set as `skipNodes` so
                // subtrees seen on a prior commit aren't re-fetched.
                // On long histories with heavy structural sharing
                // this collapses redundant subtree traversal — work
                // is proportional to unique HAMT nodes rather than
                // commits × subtree-size. The blob references under
                // skipped subtrees are already in `blobs` from the
                // earlier walk that visited them.
                const keyset = Keyset.fromRoot(store, root);
                const [entries, hamtNodes] = await keyset.walk(nodes);
                for (const entry of entries.values()) {
                    blobs.add(entry.blob);
                }
                for (const n of hamtNodes) nodes.add(n);
            }
        }
        progress("walking", i + 1, total);
    }

    return {
        commits: allCommits,
        nodes: [...nodes].sort(),
        blobs: [...blobs].sort(),
    };
}

/**
 * Cheap preview: just the commit count.  Skips the HAMT walk
 * `exportBundle` does — on a session with hundreds of commits, walking
 * every keyset to count unique blobs/nodes adds seconds of latency to
 * what should be an instant modal open.  Accurate full stats are
 * produced during the actual export and surfaced in the progress/done
 * UI.
 *
 * @param {VersionedKV} versioned
 * @param {string} branch
 * @returns {Promise<{ branch: string, head: string, commits: number }>}
 */
export async function bundleStats(versioned, branch) {
    const store = versioned.store;
    const headRaw = await store.get(BRANCH_HEAD(branch));
    if (headRaw === null) {
        throw new Error(`branch not found: ${branch}`);
    }
    const head = _safeLoadsString(headRaw);
    if (head === null) {
        throw new Error(`malformed branch head for ${branch}`);
    }

    let commits = 0;
    for await (const _c of versioned.history(head, { allParents: true })) {
        commits++;
    }
    return { branch, head, commits };
}

/**
 * Export `branch` as a self-contained bundle (returns ZIP bytes plus
 * the manifest the bytes wrap).  `progress(phase, done, total)` fires
 * at phase boundaries for callers that want to render a determinate
 * progress indicator.  Phases emitted: `walking`, `packing-commits`,
 * `packing-nodes`, `packing-blobs`, `finalizing`.
 *
 * `kernel` is the session's runtime discriminator (`"py"` or `"ts"`)
 * and lands in the manifest so `inspectBundle` callers can dispatch
 * on it (publish-target UX, future viewer-side routing) without
 * unpacking the kvgit data.  For TS sessions this is always `"ts"`;
 * exposed as a parameter for symmetry with the Py side and to keep
 * the call shape uniform.
 *
 * @param {VersionedKV} versioned
 * @param {string} branch
 * @param {{
 *   name?: string,
 *   description?: string,
 *   author?: string,
 *   kernel?: 'py' | 'ts',
 *   progress?: (phase: string, done: number, total: number) => void,
 * }} [opts]
 * @returns {Promise<{ bytes: Uint8Array, manifest: Object }>}
 */
export async function exportBundle(versioned, branch, opts = {}) {
    const {
        name = "",
        description = "",
        author = "",
        kernel = "ts",
        progress = _noop,
    } = opts;
    const store = versioned.store;

    const headRaw = await store.get(BRANCH_HEAD(branch));
    if (headRaw === null) {
        throw new Error(`branch not found: ${branch}`);
    }
    const head = _safeLoadsString(headRaw);
    if (head === null) {
        throw new Error(`malformed branch head for ${branch}`);
    }

    const { commits, nodes, blobs } = await _walkReachable(
        versioned,
        head,
        progress,
    );

    /** @type {Record<string, Uint8Array>} */
    const files = {};

    // Commits
    progress("packing-commits", 0, commits.length);
    for (let i = 0; i < commits.length; i++) {
        const commit = commits[i];
        const pairs = /** @type {const} */ ([
            ["root", COMMIT_ROOT(commit)],
            ["parent", PARENT_COMMIT(commit)],
            ["time", COMMIT_TIME(commit)],
            ["info", INFO_KEY(commit)],
        ]);
        for (const [suffix, key] of pairs) {
            const raw = await store.get(key);
            if (raw !== null) {
                files[`kvgit/commits/${commit}.${suffix}`] = raw;
            }
        }
        progress("packing-commits", i + 1, commits.length);
    }

    // Nodes
    progress("packing-nodes", 0, nodes.length);
    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        const raw = await store.get(KEYSET_PREFIX + node);
        if (raw !== null) {
            files[`kvgit/nodes/${node}`] = raw;
        }
        progress("packing-nodes", i + 1, nodes.length);
    }

    // Blobs — stored by integer index; key list lives in side manifest.
    progress("packing-blobs", 0, blobs.length);
    files["kvgit/blobs.json"] = strToU8(JSON.stringify(blobs));
    for (let i = 0; i < blobs.length; i++) {
        const raw = await store.get(blobs[i]);
        if (raw !== null) {
            files[`kvgit/blobs/${i}`] = raw;
        }
        progress("packing-blobs", i + 1, blobs.length);
    }

    progress("finalizing", 0, 1);

    const manifest = {
        format_version: FORMAT_VERSION,
        runtime_version: RUNTIME_VERSION,
        branch,
        head,
        name,
        description,
        author,
        kernel,
        created_at: Date.now() / 1000,
        stats: {
            commits: commits.length,
            nodes: nodes.length,
            blobs: blobs.length,
        },
    };
    files["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));

    // Synchronous zip — mirrors bundle.py's ZIP_DEFLATED layout. fflate's
    // zipSync handles bundles up to a few hundred MB comfortably; for
    // very large sessions consider switching to async `zip()` (no API
    // change at the call site, just await).
    const bytes = zipSync(files, { level: 6 });
    progress("finalizing", 1, 1);
    return { bytes, manifest };
}

/**
 * Read the manifest from a bundle without touching the store. Pure
 * data extraction — works for either kernel's bundles, since the
 * manifest is kernel-agnostic JSON.
 *
 * @param {Uint8Array} data
 * @returns {Object}
 */
export function inspectBundle(data) {
    const files = unzipSync(data, { filter: (f) => f.name === "manifest.json" });
    const manifestBytes = files["manifest.json"];
    if (!manifestBytes) {
        throw new Error("bundle missing manifest.json");
    }
    return JSON.parse(_textDecoder.decode(manifestBytes));
}

/**
 * Import a bundle, creating a new branch pointing at its HEAD.
 *
 * All commit / node / blob writes are content-addressed, so re-
 * importing the same bundle is a no-op at the store layer except for
 * the fresh branch pointer.  Returns `{ branch, manifest }`.
 *
 * @param {VersionedKV} versioned
 * @param {Uint8Array} data
 * @param {{ branchName?: string }} [opts]
 * @returns {Promise<{ branch: string, manifest: Object }>}
 */
export async function importBundle(versioned, data, opts = {}) {
    const files = unzipSync(data);
    const manifestBytes = files["manifest.json"];
    if (!manifestBytes) {
        throw new Error("bundle missing manifest.json");
    }
    const manifest = JSON.parse(_textDecoder.decode(manifestBytes));
    if (manifest.format_version !== FORMAT_VERSION) {
        throw new Error(
            `unsupported bundle format_version: ${manifest.format_version}`,
        );
    }
    const head = manifest.head;
    if (typeof head !== "string") {
        throw new Error("bundle manifest missing head");
    }

    /** @type {Array<readonly [string, Uint8Array]>} */
    const writes = [];

    for (const [name, raw] of Object.entries(files)) {
        if (name.startsWith("kvgit/commits/")) {
            const rest = name.slice("kvgit/commits/".length);
            const dotIdx = rest.lastIndexOf(".");
            if (dotIdx <= 0) continue;
            const commit = rest.slice(0, dotIdx);
            const suffix = rest.slice(dotIdx + 1);
            switch (suffix) {
                case "root":
                    writes.push([COMMIT_ROOT(commit), raw]);
                    break;
                case "parent":
                    writes.push([PARENT_COMMIT(commit), raw]);
                    break;
                case "time":
                    writes.push([COMMIT_TIME(commit), raw]);
                    break;
                case "info":
                    writes.push([INFO_KEY(commit), raw]);
                    break;
            }
        } else if (name.startsWith("kvgit/nodes/")) {
            const node = name.slice("kvgit/nodes/".length);
            if (node) writes.push([KEYSET_PREFIX + node, raw]);
        }
    }

    const blobsListBytes = files["kvgit/blobs.json"];
    if (!blobsListBytes) {
        throw new Error("bundle missing kvgit/blobs.json");
    }
    const blobList = JSON.parse(_textDecoder.decode(blobsListBytes));
    if (!Array.isArray(blobList)) {
        throw new Error("kvgit/blobs.json malformed");
    }
    for (let i = 0; i < blobList.length; i++) {
        const blobRaw = files[`kvgit/blobs/${i}`];
        if (blobRaw !== undefined) {
            writes.push([blobList[i], blobRaw]);
        }
    }

    const branchName =
        opts.branchName ?? `chat-${_randomHex8()}`;
    writes.push([BRANCH_HEAD(branchName), _dumpsString(head)]);

    await versioned.store.setMany(writes);
    return { branch: branchName, manifest };
}

/** Generate an 8-char hex suffix for chat- branch names.  Mirrors
 *  agex-py's `uuid4().hex[:8]` — random uniqueness is the only
 *  requirement (collision odds against a typical session list are
 *  negligible).  `crypto.getRandomValues` is universal across modern
 *  browsers and Node 19+. */
function _randomHex8() {
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
