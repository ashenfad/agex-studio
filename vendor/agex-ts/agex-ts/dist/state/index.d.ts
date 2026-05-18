import { V as VersionedStateBackend, S as StateBackend } from '../connect-DDn4Adrl.js';
export { a as StateResolver, c as connectState, i as isVersioned } from '../connect-DDn4Adrl.js';
import { Staged, CommitInfo, Versioned } from 'kvgit-ts';
import '../types-BdbZoJfu.js';
import '@standard-schema/spec';
import 'termish-ts';
import '../errors.js';

/**
 * `KvgitState` — `VersionedStateBackend` wrapping a kvgit-ts `Staged`.
 *
 * Reads / writes go straight through to the staging buffer; `commit()`
 * flushes them as one versioned commit (with three-way merge if HEAD
 * has moved). `currentCommit` reads the underlying Versioned's HEAD.
 *
 * Sessions get their own `Namespaced` view of the same root, so two
 * sessions writing under the same agent don't collide. That wiring
 * lives in the host-side persistence APIs, not here.
 */

declare class KvgitState implements VersionedStateBackend {
    #private;
    constructor(staged: Staged);
    /** Expose the underlying Staged so callers can reach kvgit-specific
     *  surface (branches, history walks, etc.). */
    get staged(): Staged;
    get currentCommit(): string | null;
    get hasChanges(): boolean;
    get<T = unknown>(key: string): Promise<T | undefined>;
    set<T = unknown>(key: string, value: T): void;
    delete(key: string): void;
    has(key: string): Promise<boolean>;
    keys(): AsyncIterable<string>;
    commit(opts?: {
        info?: Readonly<Record<string, unknown>>;
    }): Promise<string | null>;
    /** Pass through to the underlying VersionedKV. Returns commit
     *  metadata (info dict + parents) at `hash`, or current HEAD if
     *  omitted. Returns `null` if the hash doesn't exist. */
    commitInfo(hash?: string): Promise<CommitInfo | null>;
    /** Walk commit hashes from `hash` (or HEAD) backward through
     *  the history. Pass through to the underlying VersionedKV. */
    history(hash?: string, opts?: {
        allParents?: boolean;
    }): AsyncIterable<string>;
    /** Open a read-only view at a historical commit. Returns the
     *  underlying `Versioned`; callers wrap with their own `Staged`
     *  if they need write semantics. */
    checkoutAt(hash: string): Promise<Versioned | null>;
}

/**
 * `Live` — in-process state backend. A thin async wrapper around a
 * `Map<string, unknown>`.
 *
 * Use cases:
 * - **Tests** that don't want kvgit overhead.
 * - **Ephemeral agents** whose results don't need to survive a
 *   process restart.
 * - **Default fallback** when no `StateConfig` is provided.
 *
 * `Live` deliberately does NOT implement `VersionedStateBackend` —
 * it has no commits, no branches, no merges. The agent's persistence
 * APIs check at runtime via `isVersioned()` and degrade gracefully
 * (e.g. `state.checkout(hash)` returns `null` against `Live`).
 */

declare class Live implements StateBackend {
    #private;
    get<T = unknown>(key: string): Promise<T | undefined>;
    set<T = unknown>(key: string, value: T): void;
    delete(key: string): void;
    has(key: string): Promise<boolean>;
    keys(): AsyncIterable<string>;
    /** Test/inspection helper — returns the current size without
     *  iterating. Not part of `StateBackend`. */
    get size(): number;
}

export { KvgitState, Live, StateBackend, VersionedStateBackend };
