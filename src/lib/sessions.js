/**
 * Session management — branch-based chat sessions, kernel-agnostic.
 *
 * Each session maps to a kvgit branch; metadata (title, kernel,
 * etc.) lives as keys on the branch. Operations dispatch through
 * the `KernelAdapter` for whichever kernel owns the branch — Py
 * adapter wraps the studio's existing Pyodide-side runPython
 * heredocs; Ts adapter calls into agex-ts. Sessions.js itself owns
 * only shell-side concerns: in-memory `sessionStore`, the
 * `currentBranch` localStorage pointer, and the session-index
 * write-through cache.
 *
 * Why dispatch-through-adapter rather than per-function `if (kernel
 * === 'ts')` branches: the adapters already implement the
 * `KernelAdapter` typedef. Doing kernel-specific orchestration in
 * sessions.js would mean every cross-cutting function knows about
 * both kernels' implementations — exactly what the adapter
 * abstraction is supposed to prevent.
 */

import {
    size as appStorageSize,
    copy as appStorageCopy,
    remove as appStorageRemove,
} from "./app-storage.js";
import {
    replaceCache as replaceSessionCache,
    loadCache as loadSessionCache,
} from "./session-index.js";
import { kernelRegistry } from "./kernel-registry.js";
import { resolveAdapter } from "./active-adapter.js";
import { getSettings } from "./settings.js";
import { schedulePush, startSyncEngine } from "./sync-engine.js";
import {
    makeImportInfo,
    setImportInfo,
    removeImportInfo,
    checkGistUpdate,
    parseGistSource,
    getImportInfo,
    hasUpdate,
    isUnviewed,
    ignoreUpdate,
    markUpdatesSeen,
} from "./gist-update.js";
// ts-bundle is dynamic-imported below — pulls @agex-ts/kvgit which adds
// ~34KB to the cold-start bundle if statically reachable. The
// manifest-read function runs only on user-driven bundle import,
// so lazy loading is correct per the project's lazy-boot story.

// ---------------------------------------------------------------------------
// Constants + state
// ---------------------------------------------------------------------------

/** Branches starting with this prefix are recognized as user
 *  sessions on either kernel.  Both adapters' listBranches return
 *  values matching this convention. */
const CHAT_BRANCH_PREFIX = "chat-";

/** localStorage key for the active-session pointer. Exported so the
 *  purge flow can wipe it alongside the rest of the session state. */
export const CURRENT_BRANCH_KEY = "agex-current-branch";

/** localStorage key for the "I've seen the py-kernel experimental
 *  warning" dismiss flag. Set once the user acknowledges the modal
 *  on first Python-session creation; subsequent py creations skip
 *  the modal. Scoped per-browser, not per-user — for a personal-
 *  use studio that's the right granularity.
 *
 *  Versioned suffix: bumped when the modal copy changes materially
 *  (currently `-v2` after the CSP-loosening, when the modal added a
 *  sandbox-asymmetry paragraph to its previously resource-only
 *  framing). Anyone who dismissed the v1 modal sees v2 once. */
const PY_EXPERIMENTAL_SEEN_KEY = "agex-py-experimental-seen-v2";

/** localStorage key prefix mapping a local branch to the gist it
 *  most recently published to.  Used by the publish flow to decide
 *  between PATCH (update existing gist) and POST (create new). The
 *  value is JSON of shape `{ gistId, slug, lastPublishedAt, inherited? }`
 *  — `slug` is preserved across re-publishes so existing share URLs
 *  keep resolving even after the publisher renames the session.
 *  `inherited: true` marks a mapping copied to a fresh-chat fork: the
 *  fork *can* update that gist, but the publish modal defaults to a new
 *  gist so it won't silently overwrite the parent's share URL. Cleared
 *  once the branch actually publishes (the mapping is then "earned").
 *
 *  Why localStorage instead of branch meta:
 *    * Imports from a bundle land on a different branch name with no
 *      key, so they start clean.
 *    * Forks copy this key (`forkSession` / `forkSessionFreshChat`) so
 *      the fork can update the parent's gist — full-fork by default
 *      ("one share URL per app"), fresh-fork only if the user opts in
 *      at publish time (the `inherited` flag drives that default).
 *    * Bundle exports don't carry it (recipient shouldn't think
 *      they own the publisher's gist).
 *    * Kernel-agnostic — no per-kernel difference in publish
 *      identity, so storing here keeps that orthogonal.
 */
const SESSION_GIST_KEY_PREFIX = "agex-session-gist-";

function _sessionGistKey(branch) {
    return `${SESSION_GIST_KEY_PREFIX}${branch}`;
}

/** Read the published-gist info for `branch`, or `null` if this
 *  branch has never been published from this browser. Returns a
 *  plain object — don't mutate. */
export function getSessionGistInfo(branch) {
    if (typeof localStorage === "undefined" || !branch) return null;
    try {
        const raw = localStorage.getItem(_sessionGistKey(branch));
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.gistId === "string") return parsed;
        return null;
    } catch {
        return null;
    }
}

/** Persist published-gist info for `branch`. Call after a successful
 *  publish so subsequent publishes can PATCH the same gist. */
export function setSessionGistInfo(branch, info) {
    if (typeof localStorage === "undefined" || !branch || !info) return;
    try {
        localStorage.setItem(_sessionGistKey(branch), JSON.stringify(info));
    } catch {
        // Ignore quota / serialization errors — publish still
        // succeeded; we just lose the update-link affordance on
        // the next publish.
    }
}

/** Remove the published-gist mapping for `branch`. Called on session
 *  delete. */
export function clearSessionGistInfo(branch) {
    if (typeof localStorage === "undefined" || !branch) return;
    try {
        localStorage.removeItem(_sessionGistKey(branch));
    } catch {
        // Same as above.
    }
}

/** @returns {boolean} */
export function hasSeenPyExperimentalWarning() {
    return localStorage.getItem(PY_EXPERIMENTAL_SEEN_KEY) === "1";
}

export function markPyExperimentalWarningSeen() {
    localStorage.setItem(PY_EXPERIMENTAL_SEEN_KEY, "1");
}

/**
 * @typedef {Object} Session
 * @property {string} branch
 * @property {string} title
 * @property {string} updated - ISO 8601 timestamp
 * @property {'py' | 'ts'} kernel - which runtime kernel the session
 *     is bound to. Sessions are kernel-bound — once created, they
 *     don't migrate.
 * @property {boolean} [external] - true when the session was created
 *     by opening a published-artifact URL (`/run/?src=…`). External
 *     sessions are gated against host-capability features (Drive
 *     imports, etc.).
 */

/**
 * @typedef {Object} SessionState
 * @property {string} currentBranch
 * @property {Session[]} sessions
 * @property {boolean} currentSessionExternal - convenience derived
 *     field; equals the `external` flag on the session matching
 *     `currentBranch`.
 */

/** @type {SessionState} */
let state = _initialStateFromCache();

/** Build the in-memory session state from the localStorage cache so
 *  the drawer can render before any kernel boots. ChatShell's
 *  runStartup will overwrite this with live data once init resolves;
 *  the cache version is the cold-start UX win — drawer is interactive
 *  immediately, no "Loading sessions..." gap.
 *
 *  Reads `CURRENT_BRANCH_KEY` from localStorage as the active session
 *  pointer; falls back to the most-recently-updated cached session if
 *  the saved pointer doesn't match anything in cache (cache cleared,
 *  session deleted in another tab, etc.).
 */
function _initialStateFromCache() {
    /** @type {Session[]} */
    let sessions = [];
    let currentBranch = "";
    let currentSessionExternal = false;
    try {
        const cached = loadSessionCache();
        sessions = cached.map((r) => ({
            branch: r.branch,
            title: r.title || "New Chat",
            name: r.name || "",
            description: r.description || "",
            updated: r.updated || "",
            external: !!r.external,
            kernel: r.kernel,
            app_storage_bytes: appStorageSize(r.kernel, r.branch),
        }));
        sessions.sort((a, b) => (b.updated || "").localeCompare(a.updated || ""));
        const saved = localStorage.getItem(CURRENT_BRANCH_KEY) || "";
        if (saved && sessions.some((s) => s.branch === saved)) {
            currentBranch = saved;
        } else if (sessions.length > 0) {
            currentBranch = sessions[0].branch;
        }
        const cur = sessions.find((s) => s.branch === currentBranch);
        currentSessionExternal = !!(cur && cur.external);
    } catch {
        // Best-effort; bail to empty state on any cache read failure.
    }
    return { currentBranch, sessions, currentSessionExternal };
}

/** @type {((s: SessionState) => void)[]} */
let subscribers = [];

function notify() {
    for (const fn of subscribers) fn(state);
}

function update(/** @type {Partial<SessionState>} */ patch) {
    const merged = { ...state, ...patch };
    const cur = merged.sessions.find((s) => s.branch === merged.currentBranch);
    merged.currentSessionExternal = !!(cur && cur.external);
    state = merged;
    // Mirror to the session-index cache so cold-start drawer renders
    // see the latest list without booting the kernel. Single
    // chokepoint — every session-mutating operation flows through
    // update(), so the cache auto-syncs.
    _writeSessionsToCache(state.sessions);
    notify();
}

/** Project the in-memory session list into session-index cache
 *  records. Drops the JS-derived `app_storage_bytes` field
 *  (recomputed locally from localStorage on read). */
function _writeSessionsToCache(sessions) {
    const records = sessions
        .filter(
            (s) =>
                typeof s.branch === "string" && s.branch.startsWith(CHAT_BRANCH_PREFIX),
        )
        .map((s) => ({
            kernel: s.kernel || "py",
            branch: s.branch,
            title: s.title || "New Chat",
            name: s.name || "",
            description: s.description || "",
            updated: s.updated || "",
            external: !!s.external,
        }));
    replaceSessionCache(records);
}

export const sessionStore = {
    subscribe(fn) {
        subscribers.push(fn);
        fn(state);
        return () => {
            subscribers = subscribers.filter((s) => s !== fn);
        };
    },
};

// ---------------------------------------------------------------------------
// Adapter-resolution helpers
// ---------------------------------------------------------------------------

/** Look up the kernel for a branch from the in-memory session list.
 *  Defaults to "py" if the branch isn't known (defensive — covers
 *  the bootstrap window before initSessions has populated state). */
function _kernelFor(branch) {
    const s = state.sessions.find((x) => x.branch === branch);
    return /** @type {'py' | 'ts'} */ (s?.kernel || "py");
}

/** Get the adapter for a kernel iff it's already booted. Returns
 *  null otherwise. Use for query operations that should NOT trigger
 *  a boot — e.g., enumerating sessions during initSessions when
 *  ts isn't (and shouldn't be) booted yet. */
function _adapterIfBooted(kernel) {
    return kernelRegistry.get(kernel);
}

/** Convenience: resolve adapter for the current session's kernel.
 *  Boots it if not already (which is the typical case for
 *  user-initiated actions on the active session). */
function _adapterForCurrent() {
    return resolveAdapter(_kernelFor(state.currentBranch));
}

/** Random 8-char hex suffix for `chat-` branch names — uuid4-style
 *  collision odds. Mirrors py-side `uuid4().hex[:8]`. */
function _randomHex8() {
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    return [...bytes]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

// ---------------------------------------------------------------------------
// Session list
// ---------------------------------------------------------------------------

/** Decorate a session list with the JS-computed `app_storage_bytes`
 *  field. App-storage lives in the parent's localStorage; size is
 *  recomputed on each render. */
function _decorateAppStorage(sessions) {
    return sessions.map((s) => {
        // Fold in gist-import update status (cheap localStorage reads) so
        // the drawer's "update available" marker + button badge react
        // off the session store like everything else.
        const info = getImportInfo(s.branch);
        return {
            ...s,
            app_storage_bytes: appStorageSize(s.kernel || "py", s.branch),
            imported: !!info,
            updateAvailable: hasUpdate(info),
            updateUnviewed: isUnviewed(info),
        };
    });
}

/** Re-decorate the current session list (picks up changed import-update
 *  state) and push to the store. Lighter than `refreshSessionList` — no
 *  branch re-read. */
function refreshUpdateStatus() {
    update({ sessions: _decorateAppStorage(state.sessions) });
}

/** Read all known sessions across both kernels. For each kernel:
 *  live-query its adapter if booted (so writes through writeBranchMeta
 *  / persistSessionMeta show up immediately), otherwise fall back to
 *  the localStorage cache (preserves lazy-boot — opening a Py-only
 *  session shouldn't fire up the Ts kernel just to enumerate, and
 *  vice versa). */
async function _gatherAllSessions() {
    /** @type {Array<Session>} */
    const out = [];
    const cache = loadSessionCache();

    /** @param {'py' | 'ts'} kernel */
    const fromCache = (kernel) => {
        for (const r of cache.filter((r) => r.kernel === kernel)) {
            out.push({
                branch: r.branch,
                title: r.title || "New Chat",
                name: r.name || "",
                description: r.description || "",
                updated: r.updated || "",
                external: !!r.external,
                kernel,
            });
        }
    };

    for (const kernel of /** @type {const} */ (["py", "ts"])) {
        const adapter = _adapterIfBooted(kernel);
        if (adapter) {
            const live = await adapter.listBranchesWithMeta();
            for (const s of live) out.push({ ...s, kernel });
        } else {
            fromCache(kernel);
        }
    }

    out.sort((a, b) => (b.updated || "").localeCompare(a.updated || ""));
    return out;
}

/** Refresh the session list from kernels' live state. */
async function refreshSessionList(currentBranch) {
    const sessions = await _gatherAllSessions();
    update({
        currentBranch,
        sessions: _decorateAppStorage(sessions),
    });
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/** Initialize session system — call after agent init. Creates first
 *  session if none exist. Internal; public entry is
 *  `initSessionsFromUrl`. */
async function initSessions() {
    const saved = localStorage.getItem(CURRENT_BRANCH_KEY);
    let sessions = await _gatherAllSessions();

    let current;
    if (saved && sessions.find((s) => s.branch === saved)) {
        current = saved;
    } else if (sessions.length > 0) {
        current = sessions[0].branch;
    } else {
        // No sessions exist anywhere — create a default ts session.
        // ts is the lighter / faster cold-start kernel; py boots Pyodide
        // (~30 s, ~30 MB) on first use, which is too heavy a starting
        // experience for a fresh install or post-purge state.
        const adapter = await resolveAdapter("ts");
        const branch = `${CHAT_BRANCH_PREFIX}${_randomHex8()}`;
        await adapter.createBranch(branch);
        current = branch;
        sessions = [
            {
                branch,
                title: "New Chat",
                name: "",
                description: "",
                updated: new Date().toISOString(),
                external: false,
                kernel: "ts",
            },
        ];
    }

    localStorage.setItem(CURRENT_BRANCH_KEY, current);
    update({
        currentBranch: current,
        sessions: _decorateAppStorage(sessions),
    });

    // Occasionally check imported sessions for newer gist revisions
    // (lazy/TTL-gated) so the drawer-button badge can surface on load
    // without opening the drawer. Non-blocking — never gates startup.
    // Uses the configured PAT (if any) for the higher rate limit.
    void checkImportedUpdates(getSettings().githubPat);

    // Session sync engine (no-ops everywhere until settings connect a
    // sync repo). Deps keep ts-agent lazily imported — the engine must
    // not drag the ts kernel into cold start.
    startSyncEngine({
        getStore: async () => {
            const { getSharedVersioned } = await import("./ts-agent.js");
            return (await getSharedVersioned()).store;
        },
        listSyncableBranches: () =>
            state.sessions
                .filter((s) => s.kernel === "ts" && s.branch.startsWith(CHAT_BRANCH_PREFIX))
                .map((s) => s.branch),
        currentBranch: () => state.currentBranch,
        onBranchPulled: async (branch) => {
            // The branch's local ref moved: any pooled agent is stale
            // (its VersionedKV caches the old HEAD) — dispose so the
            // next interaction reopens at the pulled state, and
            // refresh the drawer so titles/timestamps update.
            const { disposeBranchAgent } = await import("./ts-agent.js");
            await disposeBranchAgent(branch);
            await refreshSessionList(state.currentBranch);
        },
    });
}

/** Create a new chat session and switch to it.
 *
 * @param {{ kernel?: 'py' | 'ts' }} [options]
 *   `kernel` selects the runtime the session will be bound to.
 *   Defaults to `"ts"` — lighter cold start than py (no Pyodide
 *   install). Once set, a session's kernel doesn't change.
 */
export async function createSession({ kernel = "ts" } = {}) {
    const safeKernel = kernel === "py" ? "py" : "ts";
    const adapter = await resolveAdapter(safeKernel);
    const branch = `${CHAT_BRANCH_PREFIX}${_randomHex8()}`;
    await adapter.createBranch(branch);

    const newSession = {
        branch,
        title: "New Chat",
        name: "",
        description: "",
        updated: new Date().toISOString(),
        external: false,
        kernel: safeKernel,
    };
    const sessions = _decorateAppStorage([newSession, ...state.sessions]);
    localStorage.setItem(CURRENT_BRANCH_KEY, branch);
    update({ currentBranch: branch, sessions });
}

/** Switch to an existing session. Pure shell-side: localStorage
 *  pointer + drawer refresh. Each kernel's adapter ensures its
 *  internal current-branch on the next op (`_ensureBranch` cache),
 *  so we don't need to fire a kernel call here. */
export async function switchSession(branch) {
    if (branch === state.currentBranch) return;
    localStorage.setItem(CURRENT_BRANCH_KEY, branch);
    await refreshSessionList(branch);
}

/** Delete a session. Switches to another only if deleting the
 *  current one. */
export async function deleteSession(branch) {
    const targetKernel = _kernelFor(branch);
    const adapter = await resolveAdapter(targetKernel);
    await adapter.deleteBranch(branch);
    appStorageRemove(targetKernel, branch);
    clearSessionGistInfo(branch);
    removeImportInfo(branch);

    // Pick a fallback active branch — most-recently-updated chat-*
    // branch on either kernel. If none remain, create a fresh py
    // session so the user lands on something usable.
    const remaining = state.sessions.filter(
        (s) =>
            s.branch !== branch && s.branch.startsWith(CHAT_BRANCH_PREFIX),
    );
    if (remaining.length === 0) {
        // Last session — create a fresh ts default (matches the
        // initSessions cold-start choice). Chains createSession's
        // update() so we don't need to also update the store here.
        await createSession({ kernel: "ts" });
        return;
    }

    let newCurrent = state.currentBranch;
    if (newCurrent === branch) {
        remaining.sort((a, b) =>
            (b.updated || "").localeCompare(a.updated || ""),
        );
        newCurrent = remaining[0].branch;
    }

    const sessions = _decorateAppStorage(
        state.sessions.filter((s) => s.branch !== branch),
    );
    localStorage.setItem(CURRENT_BRANCH_KEY, newCurrent);
    update({ currentBranch: newCurrent, sessions });
}

/** Fork the current session into a new branch from current HEAD.
 *  The fork inherits the parent's kernel — sessions are
 *  kernel-bound. */
export async function forkSession() {
    return _forkSession({ filesOnly: false });
}

/** Fork the current session, keeping the VFS workspace but
 *  dropping the agent's conversation context (event log, cache).
 *  The new branch starts blank — same files, no prior chat history.
 *
 *  Implementation: squash. Create an empty branch (from initial
 *  commit), then re-set each VFS file on the new branch. Because
 *  kvgit is content-addressed, identical bytes hash to the same
 *  blob — storage isn't duplicated, only a fresh commit object
 *  + tree pointing at the (shared) blobs. The new branch has a
 *  one-commit history, which makes exports of fresh forks small
 *  (the bundle walks the reachable commit chain — one commit
 *  here vs the source's full ancestry under a chain-inherit
 *  approach).
 *
 *  Trade-off: a few hundred ms read+re-set at fork time (one
 *  IndexedDB round-trip per file, parallelized) in exchange for
 *  tiny exports and a clean "(fresh) means fresh" mental model.
 *  Works across both kernels — uses only the public adapter
 *  surface (createBranch / listFiles / readFile / writeFiles). */
export async function forkSessionFreshChat() {
    return _forkSession({ filesOnly: true });
}

async function _forkSession({ filesOnly }) {
    const sourceBranch = state.currentBranch;
    const sourceKernel = _kernelFor(sourceBranch);
    const adapter = await resolveAdapter(sourceKernel);
    const sourceMeta = state.sessions.find((s) => s.branch === sourceBranch);
    const newBranch = `${CHAT_BRANCH_PREFIX}${_randomHex8()}`;
    if (filesOnly) {
        // Squash path. Read all VFS files from source up-front
        // (parallel — IndexedDB handles concurrent reads fine),
        // then create the new branch empty and atomic-write the
        // file map. Doing the reads BEFORE createBranch keeps the
        // source-branch context stable through the read phase; the
        // adapter would otherwise have to switch branches per read.
        const paths = await adapter.listFiles(sourceBranch);
        const fileEntries = await Promise.all(
            paths.map(async (p) => [p, await adapter.readFile(sourceBranch, p)]),
        );
        const fileMap = Object.fromEntries(fileEntries);
        await adapter.createBranch(newBranch);
        if (Object.keys(fileMap).length > 0) {
            await adapter.writeFiles(newBranch, fileMap);
        }
    } else {
        // Full fork: branch from source HEAD (shared blobs, full
        // commit chain inherited).
        await adapter.createBranch(newBranch, { from: sourceBranch });
    }
    const suffix = filesOnly ? "(fresh)" : "(fork)";
    const newTitle = `${sourceMeta?.title || "New Chat"} ${suffix}`;
    await adapter.writeBranchMeta(newBranch, { title: newTitle });
    appStorageCopy(sourceKernel, sourceBranch, newBranch);

    // Carry the source's publish identity to the fork so its next
    // publish *can* update the same gist. Full-fork inherits it outright
    // (its next publish updates the same gist — "one share URL per app").
    // Fresh-fork carries it too, but tagged `inherited` so the publish
    // modal defaults to a NEW gist instead of silently overwriting the
    // parent's share URL — the user can still pick "update existing"
    // there. See `SESSION_GIST_KEY_PREFIX` for the rationale.
    const sourceGistInfo = getSessionGistInfo(sourceBranch);
    if (sourceGistInfo) {
        setSessionGistInfo(
            newBranch,
            filesOnly ? { ...sourceGistInfo, inherited: true } : sourceGistInfo,
        );
    }

    const newSession = {
        branch: newBranch,
        title: newTitle,
        name: "",
        description: "",
        updated: new Date().toISOString(),
        external: false,
        kernel: sourceKernel,
    };
    const sessions = _decorateAppStorage([newSession, ...state.sessions]);
    localStorage.setItem(CURRENT_BRANCH_KEY, newBranch);
    update({ currentBranch: newBranch, sessions });
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/** Load chat history for `branch`'s events. Branch-explicit (defaults to
 *  the foreground) so a background/concurrent op — undo, redo,
 *  chaptering, or hydration of a session the user has since switched away
 *  from — loads the right session instead of whatever's foreground when
 *  the await resolves. */
export async function loadHistory(branch = state.currentBranch) {
    const adapter = await resolveAdapter(_kernelFor(branch));
    return adapter.loadHistory(branch);
}

const CHUNK_SIZE = 8;

/** Load history as a chunk manager for lazy rendering. Branch-explicit
 *  for the same reason as `loadHistory`. */
export async function loadHistoryChunked(branch = state.currentBranch) {
    const all = await loadHistory(branch);

    // Group into "units": a user message + everything that follows
    // it until the next user message. Closing units on first agent
    // message would split multi-report tasks; closing on user
    // messages keeps each turn together.
    const units = [];
    let current = null;
    for (const msg of all) {
        if (msg.role === "user") {
            if (current) units.push(current);
            current = [msg];
        } else if (current) {
            current.push(msg);
        } else {
            // Trailing or orphan agent message with no preceding user.
            units.push([msg]);
        }
    }
    if (current) units.push(current);

    let loadedIndex = Math.max(0, units.length - CHUNK_SIZE);

    function getVisible() {
        return units.slice(loadedIndex).flat();
    }

    return {
        /** Visible-slice snapshot at the current `loadedIndex`. Use at
         *  initial load to seed the displayed messages array; do NOT
         *  re-read after live events have been appended downstream
         *  (chat turns, uploads) — this getter doesn't know about
         *  those and re-reading would clobber them. After init,
         *  grow the displayed messages by *prepending* `loadOlder()`
         *  output instead. */
        get messages() {
            return getVisible();
        },
        get hasMore() {
            return loadedIndex > 0;
        },
        /** Decrement the snapshot window by one chunk and return just
         *  the newly-revealed older units (flattened). Empty array
         *  when there's nothing more to load. Caller should prepend
         *  the result to its displayed messages — replacing the
         *  whole `messages` array with this getter's output would
         *  drop any live-appended turns that landed since the chunk
         *  manager was constructed. */
        loadOlder() {
            const prev = loadedIndex;
            loadedIndex = Math.max(0, loadedIndex - CHUNK_SIZE);
            return units.slice(loadedIndex, prev).flat();
        },
    };
}

// ---------------------------------------------------------------------------
// State navigation
// ---------------------------------------------------------------------------

/** Get the current commit hash before a turn starts. */
export async function getCurrentCommit() {
    const adapter = await _adapterForCurrent();
    return adapter.getCurrentCommit(state.currentBranch);
}

/** Undo the last turn by resetting state to a prior commit. */
export async function undoToCommit(commitHash) {
    const adapter = await _adapterForCurrent();
    await adapter.undoToCommit(state.currentBranch, commitHash);
    await refreshSessionList(state.currentBranch);
}

// ---------------------------------------------------------------------------
// App-storage thin wrappers (here for backward import-compat;
// SessionDrawer / etc. import the real impls from app-storage.js
// directly post-Phase-4).
// ---------------------------------------------------------------------------

/** App-storage CRUD has moved off the kernel substrate entirely.
 *  Import directly from `./app-storage.js`:
 *    - `read(kernel, branch)` for what used to be `getAppStorage`
 *    - `write(kernel, branch, data)` for `flushAppStorage`
 *    - `remove(kernel, branch)` for `resetAppStorage`
 *    - `size(kernel, branch)` for `getAppStorageSize`
 */

// ---------------------------------------------------------------------------
// Bundle export / import
// ---------------------------------------------------------------------------

/** Cheap preview of what a bundle export would contain. */
export async function getBundleStats(branch) {
    const adapter = await resolveAdapter(_kernelFor(branch));
    const stats = await adapter.getBundleStats(branch);
    // Adapter's BundleStats already includes the metadata fields the
    // export modal renders (title/name/description). Pass through.
    return stats;
}

/** Export a session branch as a self-contained bundle (ZIP bytes).
 *  Adapter's `exportBundlePayload` returns kernel-specific kvgit
 *  bytes + manifest; the manifest carries the kernel discriminator
 *  so importers can dispatch correctly.
 *
 *  @param {string} branch
 *  @param {(p: { phase: string, done: number, total: number }) => void} [onProgress]
 *  @returns {Promise<{ bytes: Uint8Array, manifest: object }>}
 */
export async function exportBundle(branch, onProgress) {
    const adapter = await resolveAdapter(_kernelFor(branch));
    return adapter.exportBundlePayload(branch, { onProgress });
}

/** Import a bundle (ZIP bytes) as a new session. The manifest's
 *  `kernel` field selects which adapter receives the import.
 *
 *  Idempotency: if any existing same-kernel chat session already
 *  has the bundle's HEAD commit as its own HEAD, the import is
 *  skipped and we switch to that session instead. kvgit commit
 *  hashes are content-addressed — an exact match means the local
 *  branch is bit-for-bit equivalent to the bundle, so re-importing
 *  would just create a duplicate ref into the same DAG. Ancestor /
 *  descendant relationships (one is an older snapshot of the other,
 *  or vice versa) are NOT treated as a match — the user explicitly
 *  hit import and probably wants the alternate snapshot side-by-
 *  side with what they already have. Resolution returns
 *  `{ deduped: true, branch }` so callers can surface the switch
 *  to the user; non-deduped imports return the underlying adapter
 *  result with `deduped: false`.
 */
export async function importBundle(
    bytes,
    { external = false, gistSource = null } = {},
) {
    const manifest = await inspectBundleAsync(bytes);
    const kernel = manifest?.kernel === "ts" ? "ts" : "py";
    const adapter = await resolveAdapter(kernel);

    const bundleHead = manifest?.head;
    if (bundleHead) {
        // Same-kernel chat branches only. Per-branch `getCurrentCommit`
        // is one IDB read; sessions count is typically small enough
        // that walking them all is cheaper than a fresh import.
        for (const s of state.sessions) {
            if (s.kernel !== kernel) continue;
            if (!s.branch.startsWith(CHAT_BRANCH_PREFIX)) continue;
            try {
                const existingHead = await adapter.getCurrentCommit(s.branch);
                if (existingHead === bundleHead) {
                    await switchSession(s.branch);
                    return { branch: s.branch, head: bundleHead, deduped: true };
                }
            } catch {
                // Skip branches we can't read; not load-bearing for
                // dedup, fall through and let the normal import run.
            }
        }
    }

    const result = await adapter.importBundlePayload(bytes);
    const branch = result.branch;

    // Read back the imported branch's metadata to populate the
    // session-store entry. Use readBranchMeta so the imported title /
    // name / description carry through cleanly.
    const meta = await adapter.readBranchMeta(branch);
    if (external) {
        // Persist the external flag in branch metadata so it survives
        // reload — listBranchesWithMeta reads it back on the next boot.
        await adapter.writeBranchMeta(branch, { external: true });
    }

    const newSession = {
        branch,
        title: meta.title || "New Chat",
        name: meta.name || "",
        description: meta.description || "",
        updated: meta.updated || new Date().toISOString(),
        external: !!external,
        kernel,
    };
    const sessions = _decorateAppStorage([newSession, ...state.sessions]);
    localStorage.setItem(CURRENT_BRANCH_KEY, branch);
    update({ currentBranch: branch, sessions });

    // Record gist provenance so we can later check for newer revisions.
    // Only on a fresh import (the dedup path above returned early); the
    // bundle's head is the imported branch's HEAD, i.e. the pristine
    // baseline. Fire a non-blocking baseline check for HEAD-tracking
    // sources so the first revisit can detect post-import updates.
    if (gistSource) {
        setImportInfo(branch, makeImportInfo(gistSource, bundleHead ?? null));
        if (!gistSource.pinned) void checkGistUpdate(branch);
    }

    return { ...result, deduped: false };
}

/** Inspect a bundle's manifest. Pure JS read — works for either
 *  kernel's bundles since the manifest is kernel-agnostic JSON in
 *  the ZIP. Lazy-imports ts-bundle (which pulls @agex-ts/kvgit) so the
 *  cold-start bundle doesn't carry the 34KB of HAMT-walk code
 *  unless the user actually imports a bundle. */
async function inspectBundleAsync(bytes) {
    const { inspectBundle: read } = await import("./ts-bundle.js");
    return read(bytes);
}

/** @deprecated callers should `await inspectBundle(bytes)`. */
export async function inspectBundle(bytes) {
    return inspectBundleAsync(bytes);
}

/** Open a published artifact from its URL: fetch the bundle bytes,
 *  import them as a fresh local branch flagged `external: true`,
 *  and switch to it. */
/** Fetch + decode an artifact bundle from a URL (decodes the `.b64`
 *  text wrapper used for gist storage). Shared by the URL-open path and
 *  the gist-update re-import. */
async function _fetchBundleBytes(url) {
    const resp = await fetch(url);
    if (!resp.ok) {
        throw new Error(`Failed to fetch artifact bundle: HTTP ${resp.status}`);
    }
    const path = url.split("?")[0].split("#")[0];
    if (path.endsWith(".b64")) {
        const text = await resp.text();
        const cleaned = text.replace(/\s+/g, "");
        const binary = atob(cleaned);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }
    return new Uint8Array(await resp.arrayBuffer());
}

async function openExternalBundle(url, gistSource = null) {
    const bytes = await _fetchBundleBytes(url);
    return importBundle(bytes, { external: true, gistSource });
}

// ---------------------------------------------------------------------------
// Gist-update checks (imported sessions)
// ---------------------------------------------------------------------------

/** Poll every imported, HEAD-tracking session for a newer gist revision
 *  (each call is lazy/TTL-gated inside `checkGistUpdate`), then refresh
 *  the store so markers/badge reflect the results. Non-blocking-friendly:
 *  callers can `void` it. */
export async function checkImportedUpdates(pat = null, { force = false } = {}) {
    const targets = state.sessions
        .map((s) => ({ branch: s.branch, info: getImportInfo(s.branch) }))
        .filter(({ info }) => info && !info.pinned && !info.deleted);
    if (targets.length === 0) return { checked: 0, updates: 0 };
    // `checkGistUpdate` is built to be non-throwing (network / rate-limit
    // / deleted-gist all return the cached record), but the synchronous
    // localStorage write inside it can still throw (e.g. quota). Catch
    // per-call so one branch's failure can't abort the whole sweep —
    // keeps this independent of that internal contract.
    await Promise.all(
        targets.map(({ branch, info }) =>
            checkGistUpdate(branch, { pat, importInfo: info, force }).catch(
                (e) => console.error(`Gist update check failed for ${branch}:`, e),
            ),
        ),
    );
    refreshUpdateStatus();
    // Count available updates post-refresh so a manual check can report
    // "N available" / "up to date".
    const updates = state.sessions.filter((s) => s.updateAvailable).length;
    return { checked: targets.length, updates };
}

/** Mark all available updates as seen — clears the drawer-button badge
 *  (the per-card marker stays). Call when the drawer opens. */
export function markImportedUpdatesSeen() {
    markUpdatesSeen(state.sessions.map((s) => s.branch));
    refreshUpdateStatus();
}

/** Dismiss the current update for `branch` (card "ignore this version"). */
export function dismissImportedUpdate(branch) {
    ignoreUpdate(branch);
    refreshUpdateStatus();
}

/**
 * Apply the available gist update for `branch`.
 *
 * Pristine (no local commits since import) → in-place: re-import the
 * latest as a fresh branch, switch to it, delete the old one. Diverged
 * (the user has used the session) → open the latest as a new sibling
 * session, leave the original (and stop nagging it).
 *
 * @returns {Promise<{ pristine: boolean, branch: string } | undefined>}
 */
export async function updateImportedSession(branch) {
    const info = getImportInfo(branch);
    if (!info || info.pinned || info.deleted) return;
    const url = `https://gist.githubusercontent.com/${info.user}/${info.gistId}/raw/${info.slug}.agex.b64`;
    const bytes = await _fetchBundleBytes(url);
    const source = {
        user: info.user,
        id: info.gistId,
        slug: info.slug,
        pinned: false,
        sha: null,
    };

    // Pristine = current HEAD still equals the import baseline (no turns
    // / edits since). Determine before re-importing.
    let pristine = false;
    try {
        const adapter = await resolveAdapter(_kernelFor(branch));
        const head = await adapter.getCurrentCommit(branch);
        pristine = !!info.importedHead && head === info.importedHead;
    } catch {
        pristine = false; // can't confirm pristine → treat as diverged (safe)
    }

    const result = await importBundle(bytes, { external: true, gistSource: source });

    if (pristine && result.branch !== branch) {
        // Safe to drop the old pristine branch — no user data on it.
        // Covers the deduped case too (we switched to an existing copy),
        // so the stale pristine duplicate doesn't linger with a badge.
        await deleteSession(branch);
    } else if (!pristine) {
        // Opened a fresh copy; stop nagging the diverged original.
        dismissImportedUpdate(branch);
    }
    return { pristine, branch: result.branch };
}

/** Param names accepted by the `/run/` entry point. */
const SRC_PARAM = "src";
const GIST_PARAM = "gist";

function _isValidGistShorthand(value) {
    if (typeof value !== "string") return false;
    // Two accepted forms:
    //   3-part  USER/ID/SLUG          — HEAD-tracking, picks up edits
    //   4-part  USER/ID/SHA/SLUG      — pinned to a specific gist commit
    // The pinned form is what the gallery-submission flow uses so a
    // curated entry can't silently change after admission. Friend-
    // share URLs stay 3-part (publisher can iterate post-share).
    return (
        /^[\w.-]+\/[a-f0-9]+\/[a-z0-9-]{1,50}$/i.test(value) ||
        /^[\w.-]+\/[a-f0-9]+\/[a-f0-9]{40}\/[a-z0-9-]{1,50}$/i.test(value)
    );
}

function _expandGistShorthand(shorthand) {
    const parts = shorthand.split("/");
    if (parts.length === 4) {
        const [user, id, sha, slug] = parts;
        return `https://gist.githubusercontent.com/${user}/${id}/raw/${sha}/${slug}.agex.b64`;
    }
    const [user, id, slug] = parts;
    return `https://gist.githubusercontent.com/${user}/${id}/raw/${slug}.agex.b64`;
}

/** Initialize sessions, honoring published-artifact entry-point URLs. */
export async function initSessionsFromUrl() {
    if (typeof window === "undefined") {
        return await initSessions();
    }
    const isRunPath =
        window.location.pathname === "/run/" ||
        window.location.pathname === "/run";
    if (!isRunPath) {
        return await initSessions();
    }
    const params = new URLSearchParams(window.location.search);
    let bundleUrl = null;
    let gistSource = null;
    const gistShort = params.get(GIST_PARAM);
    if (gistShort && _isValidGistShorthand(gistShort)) {
        bundleUrl = _expandGistShorthand(gistShort);
        // Records where this import came from so we can later check the
        // gist for newer revisions. Null for `?src=` URLs (no revision
        // concept) — those just import with no update tracking.
        gistSource = parseGistSource(gistShort);
    } else {
        const src = params.get(SRC_PARAM);
        if (src) bundleUrl = src;
    }
    if (!bundleUrl) {
        return await initSessions();
    }
    await initSessions();
    await openExternalBundle(bundleUrl, gistSource);
    if (window.history && typeof window.history.replaceState === "function") {
        window.history.replaceState({}, "", "/");
    }
}

// ---------------------------------------------------------------------------
// Metadata writes
// ---------------------------------------------------------------------------

/** Update session title and timestamp after a turn. Call with the
 *  last action title. */
export async function persistSessionMeta(title, branch = state.currentBranch) {
    // `branch` is explicit so a turn that finishes after the user has
    // switched foreground (concurrent sessions) writes its title to the
    // session it ran on — not whatever's foreground now.
    const adapter = await resolveAdapter(_kernelFor(branch));
    /** @type {Record<string, string>} */
    const patch = {};
    if (title) patch.title = title;
    await adapter.writeBranchMeta(branch, patch);
    await refreshSessionList(state.currentBranch);
    // The turn's commits (and this meta write) are durable — let the
    // sync engine push them after its debounce.
    schedulePush(branch, { kernel: _kernelFor(branch) });
}

/** Set the user-curated name + description for a session branch. */
export async function setSessionMeta(branch, name, description) {
    const adapter = await resolveAdapter(_kernelFor(branch));
    await adapter.writeBranchMeta(branch, {
        name: name || "",
        description: description || "",
    });
    await refreshSessionList(state.currentBranch);
    schedulePush(branch, { kernel: _kernelFor(branch) });
}

// ---------------------------------------------------------------------------
// Debug
// ---------------------------------------------------------------------------

/** Get debug info for a session branch: commit count, keyset size,
 *  HEAD hash. */
export async function getSessionDebugInfo(branch) {
    const adapter = await resolveAdapter(_kernelFor(branch));
    return adapter.getSessionDebugInfo(branch);
}
