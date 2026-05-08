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
// ts-bundle is dynamic-imported below — pulls kvgit-ts which adds
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
    return sessions.map((s) => ({
        ...s,
        app_storage_bytes: appStorageSize(s.kernel || "py", s.branch),
    }));
}

/** Read all known sessions across both kernels. Live-queries py
 *  (already booted by the time this runs); cache-queries ts to
 *  preserve lazy-boot. */
async function _gatherAllSessions() {
    /** @type {Array<Session>} */
    const out = [];

    const pyAdapter = _adapterIfBooted("py");
    if (pyAdapter) {
        const live = await pyAdapter.listBranchesWithMeta();
        for (const s of live) out.push({ ...s, kernel: "py" });
    } else {
        // py not booted (rare cold-start race) — fall back to cache.
        for (const r of loadSessionCache().filter((r) => r.kernel === "py")) {
            out.push({
                branch: r.branch,
                title: r.title || "New Chat",
                name: r.name || "",
                description: r.description || "",
                updated: r.updated || "",
                external: !!r.external,
                kernel: "py",
            });
        }
    }

    // ts: cache-only by design — booting ts just to enumerate would
    // defeat lazy boot for users who haven't engaged with ts.
    for (const r of loadSessionCache().filter((r) => r.kernel === "ts")) {
        out.push({
            branch: r.branch,
            title: r.title || "New Chat",
            name: r.name || "",
            description: r.description || "",
            updated: r.updated || "",
            external: !!r.external,
            kernel: "ts",
        });
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
        // No sessions exist anywhere — create a default py session.
        // py is the default kernel (same as pre-unification studio).
        const adapter = await resolveAdapter("py");
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
                kernel: "py",
            },
        ];
    }

    localStorage.setItem(CURRENT_BRANCH_KEY, current);
    update({
        currentBranch: current,
        sessions: _decorateAppStorage(sessions),
    });
}

/** Create a new chat session and switch to it.
 *
 * @param {{ kernel?: 'py' | 'ts' }} [options]
 *   `kernel` selects the runtime the session will be bound to.
 *   Defaults to `"py"`. Once set, a session's kernel doesn't change.
 */
export async function createSession({ kernel = "py" } = {}) {
    const safeKernel = kernel === "ts" ? "ts" : "py";
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

    // Pick a fallback active branch — most-recently-updated chat-*
    // branch on either kernel. If none remain, create a fresh py
    // session so the user lands on something usable.
    const remaining = state.sessions.filter(
        (s) =>
            s.branch !== branch && s.branch.startsWith(CHAT_BRANCH_PREFIX),
    );
    if (remaining.length === 0) {
        // Last session — create a fresh py default. This
        // effectively chains createSession's update() so we don't
        // need to also update the store here.
        await createSession({ kernel: "py" });
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
    const sourceBranch = state.currentBranch;
    const sourceKernel = _kernelFor(sourceBranch);
    const adapter = await resolveAdapter(sourceKernel);
    const sourceMeta = state.sessions.find((s) => s.branch === sourceBranch);
    const newBranch = `${CHAT_BRANCH_PREFIX}${_randomHex8()}`;
    await adapter.createBranch(newBranch, { from: sourceBranch });
    const newTitle = `${sourceMeta?.title || "New Chat"} (fork)`;
    await adapter.writeBranchMeta(newBranch, { title: newTitle });
    appStorageCopy(sourceKernel, sourceBranch, newBranch);

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

/** Load chat history from the current session's events. */
export async function loadHistory() {
    const adapter = await _adapterForCurrent();
    return adapter.loadHistory(state.currentBranch);
}

const CHUNK_SIZE = 8;

/** Load history as a chunk manager for lazy rendering. */
export async function loadHistoryChunked() {
    const all = await loadHistory();

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
        get messages() {
            return getVisible();
        },
        get hasMore() {
            return loadedIndex > 0;
        },
        loadMore() {
            const prev = loadedIndex;
            loadedIndex = Math.max(0, loadedIndex - CHUNK_SIZE);
            return loadedIndex < prev;
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
 *  `kernel` field selects which adapter receives the import. */
export async function importBundle(bytes, { external = false } = {}) {
    const manifest = await inspectBundleAsync(bytes);
    const kernel = manifest?.kernel === "ts" ? "ts" : "py";
    const adapter = await resolveAdapter(kernel);
    const result = await adapter.importBundlePayload(bytes);
    const branch = result.branch;

    // Read back the imported branch's metadata to populate the
    // session-store entry. Use readBranchMeta so the imported title /
    // name / description carry through cleanly.
    const meta = await adapter.readBranchMeta(branch);
    if (external) {
        await adapter.writeBranchMeta(branch, {});  // bump updated
        // Mark the branch as external so the shell knows to gate
        // capability features. The flag lives in branch metadata —
        // adapter.writeBranchMeta doesn't currently expose that
        // field on its own; for now we set it post-import via a
        // direct meta write. Accept that py-side external flag
        // tracking lives in the session-store entry only until
        // both adapters formalize the external bit in writeMeta.
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
    return result;
}

/** Inspect a bundle's manifest. Pure JS read — works for either
 *  kernel's bundles since the manifest is kernel-agnostic JSON in
 *  the ZIP. Lazy-imports ts-bundle (which pulls kvgit-ts) so the
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
async function openExternalBundle(url) {
    const resp = await fetch(url);
    if (!resp.ok) {
        throw new Error(`Failed to fetch artifact bundle: HTTP ${resp.status}`);
    }
    const path = url.split("?")[0].split("#")[0];
    const isBase64 = path.endsWith(".b64");
    let bytes;
    if (isBase64) {
        const text = await resp.text();
        const cleaned = text.replace(/\s+/g, "");
        const binary = atob(cleaned);
        bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    } else {
        bytes = new Uint8Array(await resp.arrayBuffer());
    }
    return importBundle(bytes, { external: true });
}

/** Param names accepted by the `/run/` entry point. */
const SRC_PARAM = "src";
const GIST_PARAM = "gist";

function _isValidGistShorthand(value) {
    return (
        typeof value === "string" &&
        /^[\w.-]+\/[a-f0-9]+\/[a-z0-9-]{1,50}$/i.test(value)
    );
}

function _expandGistShorthand(shorthand) {
    const [user, id, slug] = shorthand.split("/");
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
    const gistShort = params.get(GIST_PARAM);
    if (gistShort && _isValidGistShorthand(gistShort)) {
        bundleUrl = _expandGistShorthand(gistShort);
    } else {
        const src = params.get(SRC_PARAM);
        if (src) bundleUrl = src;
    }
    if (!bundleUrl) {
        return await initSessions();
    }
    await initSessions();
    await openExternalBundle(bundleUrl);
    if (window.history && typeof window.history.replaceState === "function") {
        window.history.replaceState({}, "", "/");
    }
}

// ---------------------------------------------------------------------------
// Metadata writes
// ---------------------------------------------------------------------------

/** Update session title and timestamp after a turn. Call with the
 *  last action title. */
export async function persistSessionMeta(title) {
    const adapter = await _adapterForCurrent();
    /** @type {Record<string, string>} */
    const patch = {};
    if (title) patch.title = title;
    await adapter.writeBranchMeta(state.currentBranch, patch);
    await refreshSessionList(state.currentBranch);
}

/** Set the user-curated name + description for a session branch. */
export async function setSessionMeta(branch, name, description) {
    const adapter = await resolveAdapter(_kernelFor(branch));
    await adapter.writeBranchMeta(branch, {
        name: name || "",
        description: description || "",
    });
    await refreshSessionList(state.currentBranch);
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
