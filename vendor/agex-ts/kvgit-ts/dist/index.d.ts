import { K as KVStore, H as HamtDiff, a as KeysetEntry, b as KeysetDiff, D as DiffResult, B as BytesMergeFn, V as Versioned, M as MergeResult, c as VersionedCommitOptions, C as CommitInfo, d as MetaEntry, E as Encoder, e as Decoder, f as MergeFn, g as ConflictDisposition } from './types-CSsD35si.js';
export { h as ConcurrencyError, i as MergeConflict } from './types-CSsD35si.js';

/**
 * Content-addressable Hash Array Mapped Trie.
 *
 * A persistent `string -> Uint8Array` map laid out in a `KVStore` so that
 * unchanged subtrees are shared across versions by hash equality. Each
 * node is JSON-serialized (sorted keys, no whitespace, base64-encoded
 * values inline in leaves) and stored under its SHA-256 hash. A HAMT is
 * identified by its root node hash; mutations produce a new root and a
 * set of pending node bytes that the caller persists (atomically, if
 * desired) by writing them through the underlying store.
 *
 * Layering: this module knows nothing about kvgit's commit semantics —
 * it is a generic content-addressable map. The `Keyset` wrapper (TBD)
 * adds blob-pointer + meta-entry semantics on top.
 */

interface HamtOptions {
    /** Storage-key prefix. Two HAMTs sharing a backing store should use
     * different prefixes to avoid node collisions. */
    prefix?: string;
    /** Max entries in a leaf before it splits into a branch. */
    bucketMax?: number;
    /** Initial pending node bytes (for reconstructing in-progress state). */
    pending?: Map<string, Uint8Array>;
}
interface UpdatedOptions {
    updates?: Iterable<readonly [string, Uint8Array]>;
    removals?: Iterable<string>;
}
/**
 * Immutable, content-addressable HAMT view over a `KVStore`.
 *
 * Mutating methods (`updated`, `persist`) return a new `Hamt`. The
 * returned view's `pending` map contains any new node bytes not yet
 * flushed to the store. Reads on the new view resolve through `pending`
 * first, falling back to the store. Use `flush()` to persist all
 * pending nodes, or merge `pending` into a larger write batch.
 *
 * Two HAMTs with the same logical contents and the same `bucketMax`
 * have the same root hash, regardless of how they were constructed —
 * this invariant is what enables structural sharing across versions.
 *
 * `bucketMax` controls how many entries fit in a leaf before it splits
 * into a branch. Larger buckets mean fewer nodes but larger leaves;
 * smaller buckets mean more nodes with finer-grained sharing. A HAMT
 * built with one `bucketMax` will hash differently from the same
 * logical contents built with another.
 */
declare class Hamt {
    readonly store: KVStore;
    readonly root: string;
    readonly prefix: string;
    readonly bucketMax: number;
    readonly pending: Map<string, Uint8Array>;
    constructor(store: KVStore, root: string, opts?: HamtOptions);
    /** Construct a fresh, empty HAMT. */
    static empty(store: KVStore, opts?: HamtOptions): Promise<Hamt>;
    /** The hash of the canonical empty leaf. Useful for tests. */
    static emptyHash(): Promise<string>;
    /**
     * Load a node by hash. Checks the supplied transient pending dict
     * first (used during in-progress batch updates), then `this.pending`,
     * then the store. Returns null if not found.
     */
    private load;
    private storeLeaf;
    private storeBranch;
    /** Look up a key. Returns null if absent. */
    get(key: string): Promise<Uint8Array | null>;
    has(key: string): Promise<boolean>;
    /**
     * Iterate over all `(key, value)` pairs lazily. One store read per
     * visited node. Use `materialize()` if you want the whole map and the
     * underlying store has non-trivial per-call latency.
     */
    items(): AsyncIterable<readonly [string, Uint8Array]>;
    private itemsFrom;
    keys(): AsyncIterable<string>;
    values(): AsyncIterable<Uint8Array>;
    /** Walk the entire HAMT and return its contents as a Map. */
    materialize(): Promise<Map<string, Uint8Array>>;
    /**
     * Walk the entire HAMT, returning `[items, nodeHashes]`.
     *
     * Single batched BFS that collects both the key→value entries and
     * the set of every visited node hash. Used by GC mark phases that
     * want both, like `cleanOrphans`.
     *
     * `skipNodes` is an optional set of node hashes to treat as
     * already-visited. Skipped subtrees are not fetched, not recursed
     * into, and not included in the returned `nodes` set. Items beneath
     * skipped subtrees are also omitted. Pass a cumulative seen-set
     * across multiple `walk()` calls (e.g. across the commits of a
     * branch's history) to share work where the underlying HAMTs share
     * structure.
     */
    walk(skipNodes?: ReadonlySet<string>): Promise<[Map<string, Uint8Array>, Set<string>]>;
    /** Total entry count. O(N) — walks the tree. */
    size(): Promise<number>;
    /**
     * Apply updates and removals. Returns a new `Hamt` whose `pending`
     * map contains any new node bytes not yet flushed.
     */
    updated(opts?: UpdatedOptions): Promise<Hamt>;
    /**
     * Apply updates and write any new nodes to the store immediately.
     * Returns a fresh `Hamt` with empty pending.
     */
    persist(opts?: UpdatedOptions): Promise<Hamt>;
    /** Persist any pending node writes. Returns a fresh `Hamt`. */
    flush(): Promise<Hamt>;
    private insert;
    private insertAt;
    /** Convert an overflowing leaf at `depth` into a branch. */
    private splitLeaf;
    private delete;
    /** Returns the new node hash, or null if the subtree is now empty. */
    private deleteAt;
    /**
     * If every child is a leaf and the union of their entries fits in
     * `bucketMax`, return the merged leaf hash. Otherwise null.
     */
    private tryCollapse;
    /**
     * Walk from `root`, returning only pending entries actually reachable.
     * Drops orphans created by superseded inserts.
     */
    private filterPending;
    /**
     * Yield every node hash reachable from this root. Used by GC layers
     * to mark live nodes. Includes pending nodes — works on a Hamt that
     * hasn't been flushed.
     */
    reachableNodes(): AsyncIterable<string>;
    /**
     * Structural diff against `other`. Cost is O(changes + log N), not
     * O(N), because identical subtrees (same hash) are skipped wholesale.
     * The primary payoff of structural sharing.
     */
    diff(other: Hamt): Promise<HamtDiff>;
    private diffWalk;
}

/**
 * kvgit-specific wrapper around the generic HAMT.
 *
 * A `Keyset` is a content-addressable map from user keys to
 * `KeysetEntry` values, where each entry holds a versioned blob
 * pointer and per-key metadata. This is what `VersionedKV` (TBD)
 * uses to represent the state of a single commit.
 *
 * The wrapper is thin: encode/decode entries and delegate everything
 * else to `Hamt`. The HAMT does the structural-sharing work; the
 * `Keyset` just gives the API a kvgit-friendly shape.
 */

/**
 * Encode a `KeysetEntry` to bytes.
 *
 * Format: `[blob, {createdAt, size}]` as JSON, no whitespace.
 * Object-key order is alphabetical (`createdAt` then `size`) to keep
 * encodings byte-deterministic — same logical entry → same bytes →
 * same HAMT leaf hash.
 */
declare function encodeEntry(entry: KeysetEntry): Uint8Array;
declare function decodeEntry(raw: Uint8Array): KeysetEntry;
interface KeysetOptions {
    prefix?: string;
    bucketMax?: number;
    pending?: Map<string, Uint8Array>;
}
interface KeysetUpdatedOptions {
    updates?: Iterable<readonly [string, KeysetEntry]>;
    removals?: Iterable<string>;
}
/**
 * Immutable view of a kvgit keyset, backed by a HAMT.
 *
 * Mutations return a new `Keyset` whose `pending` map carries any new
 * HAMT node bytes not yet flushed to the store. Use `flush()` to
 * persist, or merge `pending` into a larger write batch.
 */
declare class Keyset {
    #private;
    /** Default storage-key prefix for HAMT nodes belonging to a Keyset.
     *  Used by the GC layer to identify keyset nodes via prefix scan. */
    static readonly DEFAULT_PREFIX = "kvgit:keyset:";
    private constructor();
    /** Construct a fresh, empty Keyset. */
    static empty(store: KVStore, opts?: KeysetOptions): Promise<Keyset>;
    /** Construct a Keyset from a known root hash. */
    static fromRoot(store: KVStore, root: string, opts?: KeysetOptions): Keyset;
    get store(): KVStore;
    get root(): string;
    get prefix(): string;
    get bucketMax(): number;
    get pending(): Map<string, Uint8Array>;
    get(key: string): Promise<KeysetEntry | null>;
    /** Shortcut: just the blob pointer, skipping a meta decode. */
    getBlob(key: string): Promise<string | null>;
    has(key: string): Promise<boolean>;
    /**
     * Iterate over all `(key, entry)` pairs lazily. One store read per
     * visited HAMT node. See `materialize()` for a batched alternative.
     */
    items(): AsyncIterable<readonly [string, KeysetEntry]>;
    /** Walk the entire keyset using batched store reads. */
    materialize(): Promise<Map<string, KeysetEntry>>;
    /**
     * Single batched walk returning `[entries, hamtNodeHashes]`.
     *
     * Equivalent to `materialize()` plus collecting every visited HAMT
     * node hash, in one tree traversal. Used by GC mark phases. See
     * `Hamt.walk` for `skipNodes` cumulative seen-set semantics.
     */
    walk(skipNodes?: ReadonlySet<string>): Promise<[Map<string, KeysetEntry>, Set<string>]>;
    keys(): AsyncIterable<string>;
    values(): AsyncIterable<KeysetEntry>;
    /** Total entry count. O(N) — walks the tree. */
    size(): Promise<number>;
    updated(opts?: KeysetUpdatedOptions): Promise<Keyset>;
    persist(opts?: KeysetUpdatedOptions): Promise<Keyset>;
    flush(): Promise<Keyset>;
    /** Yield every HAMT node hash reachable from this root. */
    reachableNodes(): AsyncIterable<string>;
    /**
     * Structural diff against `other`. Skips identical subtrees by hash
     * equality, so cost is proportional to the number of changed entries.
     */
    diff(other: Keyset): Promise<KeysetDiff>;
}

/**
 * Pure three-way merge resolution.
 *
 * `resolveMerge` takes a fully-decoded snapshot of the merge state
 * (LCA / ours / theirs keysets, the diffs from LCA to each, a blob
 * reader, the merge fns) and returns a `MergeResolution` ready to be
 * persisted as a merge commit.
 *
 * The function is pure with respect to storage — the only IO is the
 * injected `blobReader`. `VersionedBase` calls it inside the merge
 * orchestration; users implementing custom backends call it the same
 * way.
 */

/** Read a blob's bytes by its content identifier (versioned key). */
type BlobReader = (id: string) => Promise<Uint8Array | null>;
/**
 * Result of a successful merge resolution.
 *
 * `mergedKeyset` is the new commit's flat keyset (key → blob pointer).
 * Existing pointers are reused for keys that didn't move; merged-value
 * keys still hold a placeholder pointer (the caller resolves these to
 * `<merge_hash>:<key>` when materializing the merge commit).
 *
 * `mergedValues` holds the bytes for keys that the merge fns produced
 * — these get written as fresh blobs at commit time.
 *
 * `autoMergedKeys` lists the keys a merge fn resolved (for reporting).
 */
interface MergeResolution {
    readonly mergedKeyset: Map<string, string>;
    readonly mergedValues: Map<string, Uint8Array>;
    readonly autoMergedKeys: readonly string[];
}
interface ResolveMergeOptions {
    lcaKeyset: ReadonlyMap<string, string>;
    ourKeyset: ReadonlyMap<string, string>;
    theirKeyset: ReadonlyMap<string, string>;
    ourDiff: DiffResult;
    theirDiff: DiffResult;
    blobReader: BlobReader;
    mergeFns: ReadonlyMap<string, BytesMergeFn>;
    defaultMerge: BytesMergeFn | null;
}
/**
 * Resolve a three-way merge between two diverged keysets.
 *
 * Does NOT create commits or advance HEAD — the caller handles
 * persistence. Throws `MergeConflict` if any contested key is
 * unresolvable (no merge fn, or the fn threw).
 */
declare function resolveMerge(opts: ResolveMergeOptions): Promise<MergeResolution>;

/**
 * Shared commit / merge orchestration for versioned stores.
 *
 * `VersionedBase` provides:
 * - The `commit()` flow: fast-forward + CAS, three-way merge fallback
 *   on HEAD divergence, snapshot/restore on failed CAS.
 * - History walking, key-level diff, parent lookup, merge fn registry.
 *
 * Subclasses provide storage-specific operations (CAS, commit creation,
 * blob reading, LCA finding). Anything that touches storage layout is
 * abstract; everything that orchestrates the protocol is concrete.
 */

/**
 * Abstract base for versioned KV stores.
 *
 * Manages the in-memory snapshot of the current commit's flat keyset
 * and orchestrates `commit()`. Subclasses fill in the abstract methods
 * to bind the orchestration to specific storage.
 */
declare abstract class VersionedBase implements Versioned {
    protected branch: string;
    protected currentCommitHash: string;
    protected baseCommitHash: string;
    protected commitKeys: Map<string, string>;
    protected mergeFns: Map<string, BytesMergeFn>;
    protected defaultMergeFn: BytesMergeFn | null;
    lastMergeResult: MergeResult | null;
    /** Cached on first access; the root commit walking back from HEAD. */
    private cachedInitialCommit;
    protected constructor(opts: {
        branch: string;
        commitHash: string;
    });
    get currentCommit(): string;
    get baseCommit(): string;
    get currentBranch(): string;
    get initialCommit(): string;
    /** Resolve the root commit by walking the parent chain. Caches the result. */
    initial(): Promise<string>;
    get(key: string): Promise<Uint8Array | null>;
    getMany(keys: Iterable<string>): Promise<Map<string, Uint8Array>>;
    has(key: string): Promise<boolean>;
    keys(): AsyncIterable<string>;
    setMergeFn(key: string, fn: BytesMergeFn): void;
    setDefaultMerge(fn: BytesMergeFn): void;
    diff(commitA: string, commitB: string): Promise<DiffResult>;
    history(commitHash?: string, opts?: {
        allParents?: boolean;
    }): AsyncIterable<string>;
    parents(commitHash?: string): Promise<readonly string[]>;
    commit(opts?: VersionedCommitOptions): Promise<MergeResult>;
    private threeWayMerge;
    abstract latestHead(): Promise<string | null>;
    abstract peek(key: string, opts: {
        branch: string;
    }): Promise<Uint8Array | null>;
    abstract refresh(): Promise<void>;
    abstract checkout(commitHash: string, opts?: {
        branch?: string;
    }): Promise<Versioned | null>;
    abstract createBranch(name: string, opts?: {
        at?: string;
    }): Promise<Versioned>;
    abstract deleteBranch(name: string): Promise<void>;
    abstract switchBranch(name: string): Promise<void>;
    abstract resetTo(commitHash: string): Promise<boolean>;
    abstract listBranches(): Promise<string[]>;
    abstract commitInfo(commitHash?: string): Promise<CommitInfo | null>;
    protected abstract snapshotState(): unknown;
    protected abstract restoreState(saved: unknown): void;
    protected abstract createCommit(opts: {
        updates?: Map<string, Uint8Array>;
        removals?: Set<string>;
        info?: CommitInfo;
    }): Promise<string>;
    protected abstract createMergeCommit(resolution: MergeResolution, parents: readonly string[], info: CommitInfo | null): Promise<string>;
    protected abstract casHead(expected: string, newHead: string): Promise<boolean>;
    protected abstract loadKeyset(commitHash: string): Promise<Map<string, string>>;
    protected abstract loadParents(commitHash: string): Promise<readonly string[]>;
    protected abstract findLca(commitA: string, commitB: string): Promise<string | null>;
    protected abstract readBlob(blobId: string): Promise<Uint8Array | null>;
}

/**
 * KVStore-backed versioned state.
 *
 * Storage layout:
 *
 *   `__kvgit_version__`              — storage version sentinel (1 in v1)
 *   `__branch_head__<branch>`        — current HEAD commit hash
 *   `__branch_head_prev__<branch>`   — previous HEAD (recovery backup)
 *   `__commit_root__<commit>`        — keyset HAMT root hash
 *   `__parent_commit__<commit>`      — JSON list of parent commit hashes
 *   `__commit_time__<commit>`        — wall time epoch ms
 *   `__info__<commit>`               — optional caller-supplied info dict
 *   `kvgit:keyset:<node_hash>`       — HAMT node bytes (via Keyset)
 *   `<commit_hash>:<user_key>`       — blob value bytes
 *
 * The keyset is a content-addressable HAMT (`Keyset` over `Hamt`) so
 * unchanged subtrees are shared across commits by hash equality. A
 * single-key change writes O(log N) new HAMT nodes instead of
 * rewriting a full snapshot per commit.
 */

/**
 * Optional second-tier corrupt-HEAD recovery.
 *
 * Slot for the deferred kvgit-py `_resolve_head` commit-scan fallback.
 * v1 ships without an implementation; users with a corruption surface
 * can wire one in (the function gets the store + branch and returns a
 * recovered commit hash, or null if unrecoverable).
 *
 * If unset, corrupt-HEAD recovery stops at the prev-HEAD tier.
 */
type CorruptHeadRecoverer = (store: KVStore, branch: string) => Promise<string | null>;
interface VersionedKVOptions {
    branch?: string;
    /** Pin to a specific commit instead of resolving the branch HEAD. */
    commitHash?: string;
    /** Slot for second-tier corrupt-HEAD recovery (see `CorruptHeadRecoverer`). */
    recoverFromCorruptHead?: CorruptHeadRecoverer;
}
interface SnapshotState {
    currentCommit: string;
    commitKeys: Map<string, string>;
    meta: Map<string, MetaEntry>;
}
/**
 * A commit log over a `KVStore`.
 *
 * Construct via the async `VersionedKV.open(store, opts?)` factory —
 * the constructor itself is private because initialization needs to
 * resolve HEAD (and possibly create an initial empty commit), both of
 * which are async.
 */
declare class VersionedKV extends VersionedBase {
    readonly store: KVStore;
    private meta;
    private readonly recoverFromCorruptHead;
    private constructor();
    /**
     * Open or create a versioned store on `store`.
     *
     * Resolves the branch HEAD with prev-HEAD recovery; creates an
     * initial empty commit if the branch doesn't exist yet. Validates
     * the storage version (rejects formats from other versions).
     */
    static open(store: KVStore, opts?: VersionedKVOptions): Promise<VersionedKV>;
    latestHead(): Promise<string | null>;
    protected snapshotState(): SnapshotState;
    protected restoreState(saved: unknown): void;
    protected createCommit(opts: {
        updates?: Map<string, Uint8Array>;
        removals?: Set<string>;
        info?: CommitInfo;
    }): Promise<string>;
    protected createMergeCommit(resolution: MergeResolution, parents: readonly string[], info: CommitInfo | null): Promise<string>;
    protected casHead(expected: string, newHead: string): Promise<boolean>;
    protected loadKeyset(commitHash: string): Promise<Map<string, string>>;
    protected loadParents(commitHash: string): Promise<readonly string[]>;
    protected findLca(commitA: string, commitB: string): Promise<string | null>;
    protected readBlob(blobId: string): Promise<Uint8Array | null>;
    refresh(): Promise<void>;
    checkout(commitHash: string, opts?: {
        branch?: string;
    }): Promise<Versioned | null>;
    createBranch(name: string, opts?: {
        at?: string;
    }): Promise<Versioned>;
    deleteBranch(name: string): Promise<void>;
    switchBranch(name: string): Promise<void>;
    peek(key: string, opts: {
        branch: string;
    }): Promise<Uint8Array | null>;
    resetTo(commitHash: string): Promise<boolean>;
    listBranches(): Promise<string[]>;
    commitInfo(commitHash?: string): Promise<CommitInfo | null>;
    /**
     * Remove orphaned commits (and their unreachable blobs + HAMT nodes)
     * not reachable from any live branch HEAD.
     *
     * Mark phase walks every branch's full ancestry, accumulating
     * reachable commits / blobs / HAMT node hashes. `Keyset.walk(skipNodes)`
     * is given the cumulative seen-set so subtrees shared via structural
     * sharing across commits are visited exactly once.
     *
     * The `minAge` guard (default 1 hour) protects recently-created
     * commits from being swept. Within that window, an orphan commit's
     * blobs are marked reachable too — they may belong to an in-flight
     * writer whose CAS hasn't landed yet.
     *
     * @param opts.minAge Milliseconds. Commits younger than this are
     *   protected from sweep, even if currently unreachable. Default: 1 hour.
     * @returns Number of orphaned commits removed.
     */
    cleanOrphans(opts?: {
        minAge?: number;
    }): Promise<number>;
    private loadCommitInto;
}

/**
 * Pure helpers shared by the versioned layer.
 *
 * `diffKeysets` is a set-based diff between two flat `key → blob_pointer`
 * maps. `walkHistory` yields commits along the parent chain via an
 * injected loader, supporting either linear (first-parent) or
 * BFS-across-all-parents traversal.
 */

/**
 * Compute key-level differences between two keysets.
 *
 * Each keyset maps user keys to opaque content identifiers (versioned
 * blob pointers in `VersionedKV`). Two keys are "modified" when both
 * sides have the key but mapped to different identifiers.
 */
declare function diffKeysets(keysetA: ReadonlyMap<string, string>, keysetB: ReadonlyMap<string, string>): DiffResult;
type ParentLoader = (commitHash: string) => Promise<readonly string[]>;
/**
 * Yield commit hashes from `start` along the parent chain, newest to
 * oldest.
 *
 * - `allParents = false` (default): linear walk via the first parent.
 * - `allParents = true`: BFS across all parents (visit every ancestor
 *   exactly once).
 */
declare function walkHistory(start: string, parentLoader: ParentLoader, opts?: {
    allParents?: boolean;
}): AsyncIterable<string>;

/**
 * Staged: a buffered, Map-shaped layer over a `Versioned`.
 *
 * Writes (`set` / `delete`) accumulate in memory; nothing reaches the
 * underlying store until `commit()` flushes them as a single atomic
 * commit (with optional three-way merge if HEAD has moved).
 *
 * Reads check the staging buffer first, then a per-instance read cache,
 * then the underlying store. Decoded values are cached so repeat reads
 * don't re-decode.
 *
 * The encoder/decoder convert user values to/from bytes for storage.
 * The default is JSON over UTF-8; pass custom codecs for richer types
 * (cbor for Map/Set/Date/typed arrays, msgpack for compactness, etc.).
 */

/** Default encoder: JSON via UTF-8. JSON-serializable values only. */
declare const jsonEncoder: Encoder;
/** Default decoder: JSON via UTF-8. Mirrors `jsonEncoder`. */
declare const jsonDecoder: Decoder;
interface StagedOptions {
    encoder?: Encoder;
    decoder?: Decoder;
}
interface StagedCommitOptions {
    /** If provided, only these keys are flushed; others remain staged. */
    keys?: Set<string>;
    onConflict?: ConflictDisposition;
    /** Per-key merge fns added on top of the registered ones for this commit. */
    mergeFns?: Map<string, MergeFn>;
    defaultMerge?: MergeFn;
    info?: CommitInfo;
}
/**
 * Buffered writes over a `Versioned`. Implements a Map-shaped surface;
 * staged changes flush atomically via `commit()`.
 *
 * Per-call generics on `get` / `set` give the call site typed access
 * (`staged.get<Model>('model')`); without a generic the value type is
 * `unknown` and the caller narrows.
 */
declare class Staged {
    readonly versioned: Versioned;
    private readonly encoder;
    private readonly decoder;
    private updates;
    private removals;
    private cache;
    private userMergeFns;
    private userDefaultMerge;
    constructor(versioned: Versioned, opts?: StagedOptions);
    get currentCommit(): string;
    get baseCommit(): string;
    get currentBranch(): string;
    get initialCommit(): string;
    get lastMergeResult(): MergeResult | null;
    get<T = unknown>(key: string): Promise<T | undefined>;
    has(key: string): Promise<boolean>;
    keys(): AsyncIterable<string>;
    set<T = unknown>(key: string, value: T): void;
    delete(key: string): void;
    /** Whether there are any staged changes. */
    get hasChanges(): boolean;
    /** Whether a specific key has a pending update or removal. */
    isStaged(key: string): boolean;
    /** Discard all staged changes and the read cache. */
    reset(): void;
    /**
     * Switch to a different branch in-place. **Discards staged changes**
     * — `updates`, `removals`, and the read cache are all cleared.
     *
     * Carrying uncommitted writes across a branch switch is a three-way-
     * merge problem in disguise; the kvgit contract is to drop them
     * rather than silently fold them into the new branch.
     */
    switchBranch(name: string): Promise<void>;
    /**
     * Reset HEAD to `commitHash` and discard staged changes.
     *
     * Returns `true` if the commit exists and the reset landed; `false`
     * leaves staged state untouched. Mirrors kvgit-py's `reset_to` —
     * cleanup only fires on success so a failed reset (unknown hash)
     * doesn't silently throw away the caller's work.
     */
    resetTo(commitHash: string): Promise<boolean>;
    /**
     * Reload from HEAD (picks up writes from other producers on the
     * same branch). **Discards staged changes** — same reasoning as
     * `switchBranch`: a refresh that landed concurrent commits can
     * leave staged work unable to merge cleanly.
     */
    refresh(): Promise<void>;
    /**
     * Fork a new branch off `at` (defaults to current HEAD). Returns a
     * fresh `Staged` wrapping the new branch's `Versioned`, with the
     * same encoder/decoder as this one. User merge fns are NOT
     * propagated — register them on the returned instance if needed.
     */
    createBranch(name: string, opts?: {
        at?: string;
    }): Promise<Staged>;
    /**
     * Open a `Staged` view at a specific commit (read-only timeline
     * navigation). Returns `null` if the commit doesn't exist. Optional
     * `branch` follows the underlying `Versioned.checkout` semantics.
     */
    checkout(commitHash: string, opts?: {
        branch?: string;
    }): Promise<Staged | null>;
    /** List all branch names in the underlying store. */
    listBranches(): Promise<string[]>;
    /**
     * Delete a branch by name. Cannot delete the current branch — the
     * underlying `Versioned` enforces this and throws.
     */
    deleteBranch(name: string): Promise<void>;
    /**
     * Read a key from another branch's HEAD without switching to it.
     * Returns the decoded value, or `undefined` if the key is absent.
     *
     * Doesn't touch the read cache (the cache is keyed by *this* branch).
     */
    peek<T = unknown>(key: string, opts: {
        branch: string;
    }): Promise<T | undefined>;
    /**
     * Walk the commit chain from `commitHash` (or current HEAD) backward
     * through history. With `allParents: true`, also walks merge
     * second-parents. Pure pass-through to the underlying `Versioned`.
     */
    history(commitHash?: string, opts?: {
        allParents?: boolean;
    }): AsyncIterable<string>;
    setMergeFn<T = unknown>(key: string, fn: MergeFn<T>): void;
    setDefaultMerge<T = unknown>(fn: MergeFn<T>): void;
    commit(opts?: StagedCommitOptions): Promise<MergeResult>;
    /**
     * Wrap a user-level merge fn (decoded values) into a bytes-level fn
     * the `Versioned` layer can call. Encodes the merge result with the
     * configured encoder.
     */
    private wrapMergeFn;
}

/**
 * Namespaced: a key-prefix view over a `Staged`-shaped store.
 *
 * Wraps any store that exposes async reads + sync buffered writes
 * (notably `Staged`, but also another `Namespaced`). All operations
 * route through a `<namespace>/<key>` prefix, so an enclosing
 * application can carve out independent sub-namespaces over a single
 * shared store.
 *
 * Nesting flattens: `new Namespaced(new Namespaced(staged, 'a'), 'b')`
 * reads/writes keys under `a/b/` rather than building a deeper
 * prefix-of-prefix chain.
 */
/**
 * The minimal shape `Namespaced` needs from its underlying store.
 *
 * Both `Staged` and `Namespaced` itself implement this naturally;
 * other stores can opt in by providing the same surface.
 */
interface NamespaceableStore {
    get<T = unknown>(key: string): Promise<T | undefined>;
    has(key: string): Promise<boolean>;
    set<T = unknown>(key: string, value: T): void;
    delete(key: string): void;
    keys(): AsyncIterable<string>;
}
declare class Namespaced implements NamespaceableStore {
    /** The full prefix this view is namespaced under (without trailing slash). */
    readonly namespace: string;
    private readonly store;
    constructor(store: NamespaceableStore, namespace: string);
    private prefixed;
    get<T = unknown>(key: string): Promise<T | undefined>;
    has(key: string): Promise<boolean>;
    /** Direct child keys in this namespace (excluding nested sub-namespaces). */
    keys(): AsyncIterable<string>;
    /** All keys under this namespace, including those in nested sub-namespaces. */
    descendantKeys(): AsyncIterable<string>;
    set<T = unknown>(key: string, value: T): void;
    delete(key: string): void;
}

export { type BlobReader, BytesMergeFn, CommitInfo, ConflictDisposition, type CorruptHeadRecoverer, Decoder, DiffResult, Encoder, Hamt, HamtDiff, type HamtOptions, KVStore, Keyset, KeysetDiff, KeysetEntry, type KeysetOptions, type KeysetUpdatedOptions, MergeFn, type MergeResolution, MergeResult, MetaEntry, type NamespaceableStore, Namespaced, type ParentLoader, type ResolveMergeOptions, Staged, type StagedCommitOptions, type StagedOptions, type UpdatedOptions, Versioned, VersionedBase, VersionedCommitOptions, VersionedKV, type VersionedKVOptions, decodeEntry, diffKeysets, encodeEntry, jsonDecoder, jsonEncoder, resolveMerge, walkHistory };
