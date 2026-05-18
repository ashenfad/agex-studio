import { S as StateConfig } from './types-BdbZoJfu.js';

/**
 * `StateBackend` — the minimal Map-shaped surface every state store
 * exposes. Both `Live` (in-process) and a kvgit-ts `Staged` wrapper
 * satisfy it, so agex-ts core can read/write state without caring
 * which one is underneath.
 *
 * Why `set`/`delete` are sync: kvgit's `Staged` writes go to an
 * in-memory buffer immediately and only flush on `commit()`. `Live`
 * has no buffer/flush distinction at all. Either way, the write
 * itself never awaits storage IO.
 *
 * `keys()` returns `AsyncIterable<string>` to match kvgit's surface,
 * which streams keys lazily for stores too large to materialize at
 * once. Live yields synchronously but uses the same protocol.
 */
interface StateBackend {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set<T = unknown>(key: string, value: T): void;
    delete(key: string): void;
    has(key: string): Promise<boolean>;
    keys(): AsyncIterable<string>;
}
/** State backends with version history (kvgit-backed). `commit()`
 *  flushes pending writes as a single atomic commit; `currentCommit`
 *  reads the current HEAD. `Live` returns `null` for both — it has
 *  no versioning. */
interface VersionedStateBackend extends StateBackend {
    /** Current HEAD commit hash, or `null` if the backend isn't
     *  versioned (i.e. `Live`). */
    readonly currentCommit: string | null;
    /** Flush staged writes as one commit. Returns the resulting commit
     *  hash, or `null` if nothing changed. Throws if the backend isn't
     *  versioned. */
    commit(opts?: {
        info?: Readonly<Record<string, unknown>>;
    }): Promise<string | null>;
    /** True if there are uncommitted writes since the last commit. */
    readonly hasChanges: boolean;
}
/** Type guard distinguishing versioned backends from plain `Live`. */
declare function isVersioned(backend: StateBackend): backend is VersionedStateBackend;

/**
 * `connectState(config)` — factory that turns a `StateConfig` into a
 * `StateResolver`: the resolver owns the per-session state lookup and
 * caches a fresh `StateBackend` per session id on first request.
 *
 * Each framework session gets its own KV-store namespace so its
 * commit chain is independent of every other session's. Mirrors
 * agex-py's `host/local.py` model: separate Disk dirs per session,
 * separate ModalDicts per session, etc. Storage backends embed the
 * session differently — Memory: a fresh `Memory()` per session;
 * IndexedDB: a session-suffixed db name; SQLite: a per-session file.
 *
 * The earlier "one VersionedKV per agent + key-prefix sessions"
 * shape conflated the substrate boundary with the namespace boundary.
 * Splitting them lets cache / event log / VFS share one substrate
 * within a session (atomic commits across all three) and lets sessions
 * roll back independently of each other.
 *
 * Storage-specific backends are loaded via dynamic `import()` so a
 * browser bundle doesn't pull `node:sqlite` and a Node bundle doesn't
 * pull `idb`. Tree-shaking handles the unused branches per environment.
 */

/** Lazy per-session resolver. `resolve(session)` returns the
 *  `StateBackend` for that session, constructing it on first access
 *  and caching for the rest of the resolver's lifetime. The
 *  `versioned` flag tells callers (notably `VfsManager`) whether the
 *  produced backends are kvgit-backed without forcing a resolution. */
interface StateResolver {
    resolve(session: string): Promise<StateBackend>;
    readonly versioned: boolean;
}
declare function connectState(config?: StateConfig): Promise<StateResolver>;

export { type StateBackend as S, type VersionedStateBackend as V, type StateResolver as a, connectState as c, isVersioned as i };
