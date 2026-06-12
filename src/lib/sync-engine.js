/**
 * Session sync engine — the wiring between studio sessions and the
 * kvgit GitHub remote (configured in settings via sync-settings.js).
 *
 * Responsibilities:
 *   - one `GithubRemote` over the shared ts kvgit store, rebuilt when
 *     the settings credentials change
 *   - debounced push-after-turn (`schedulePush`, called from
 *     sessions.js when a turn or meta edit commits)
 *   - TTL'd pull/push sweeps on window focus (same cadence idea as
 *     gist-update.js), covering every sync-enabled ts chat session
 *   - per-branch status for the UI (`syncStatusStore`) and a
 *     per-branch enable flag (localStorage; default ON once connected)
 *   - cross-tab exclusivity via the Web Locks API (one tab syncs at a
 *     time; busy tabs reschedule instead of queueing)
 *
 * Scope and known v1 limits (deliberate):
 *   - ts-kernel sessions only — the engine operates on the shared
 *     kvgit-ts store; py sessions live in kvgit-py storage.
 *   - Sync is fast-forward only (kvgit's syncBranch): divergence is
 *     surfaced as a status, never auto-merged. Resolution UI is the
 *     next slice.
 *   - The foreground session is synced via the post-turn push (the
 *     turn just finished, so no writer is racing). Focus sweeps skip
 *     the current branch to avoid fast-forwarding state out from
 *     under an in-flight turn; a pulled background branch has its
 *     agent-pool entry disposed so the next interaction reopens at
 *     the new HEAD.
 *
 * Dependency injection (`startSyncEngine(deps)` / `configureSyncEngine`)
 * keeps this module import-light: sessions.js supplies the store
 * accessor (lazy ts-agent import — cold start stays lean), the branch
 * enumerator, and the pulled-branch callback. Tests inject a Memory
 * store + MemoryRemote and drive the engine end-to-end against real
 * kvgit machinery.
 */

import { VersionedKV, applyWire, syncBranch } from "@agex-ts/kvgit";
import { GithubClient, GithubRemote } from "@agex-ts/kvgit/github";
import { getSettings } from "./settings.js";

/** Debounce for push-after-turn: long enough to coalesce a turn's
 *  meta-write tail, short enough to feel immediate. */
const PUSH_DEBOUNCE_MS = 4000;

/** Focus sweeps are TTL-gated per engine (not per branch): a refocus
 *  within the window is a no-op. */
const SWEEP_TTL_MS = 5 * 60_000;

/** Retry delay when another tab holds the sync lock. */
const BUSY_RETRY_MS = 15_000;

const ENABLED_KEY = (branch) => `agex-sync-enabled-${branch}`;

// ---------------------------------------------------------------------------
// Status store (sessions.js store pattern)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} BranchSyncStatus
 * @property {"syncing" | "synced" | "diverged" | "remote-gone" | "error"} state
 * @property {string} detail — human hint for warn/error states
 * @property {number} at — epoch ms of the last transition
 */

/** @type {Record<string, BranchSyncStatus>} */
let statuses = {};
let subscribers = [];

export const syncStatusStore = {
    subscribe(fn) {
        subscribers.push(fn);
        fn(statuses);
        return () => {
            subscribers = subscribers.filter((s) => s !== fn);
        };
    },
};

function setStatus(branch, patch) {
    statuses = {
        ...statuses,
        // detail resets on every transition unless the new patch sets
        // one — a recovered branch must not keep its old error tooltip.
        [branch]: { ...statuses[branch], detail: "", ...patch, at: Date.now() },
    };
    for (const fn of subscribers) fn(statuses);
}

// ---------------------------------------------------------------------------
// Configuration / deps
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} SyncEngineDeps
 * @property {() => Promise<any>} getStore — the shared ts kvgit KVStore
 * @property {() => string[]} listSyncableBranches — ts chat branches
 * @property {(branch: string) => Promise<void>} [onBranchPulled] — a
 *     pull moved the branch's local ref; refresh lists / dispose pools
 * @property {() => string | null} [currentBranch] — foreground branch
 *     (sweeps skip it; its sync rides the post-turn push)
 * @property {(branch: string) => Promise<void>} [onBranchArchivedRemotely]
 *     — tombstone propagation: remove the local session (recoverable
 *     from the trash); must NOT re-archive remotely
 * @property {() => Promise<void>} [onSessionListChanged] — a roster op
 *     created/removed local branches; rebuild the session list
 * @property {(deps: { store: any }) => any} [makeRemote] — test seam
 */

/** @type {SyncEngineDeps | null} */
let deps = null;
let cachedRemote = null;
let cachedRemoteKey = "";
let pendingPushes = new Map();
let lastSweepAt = 0;
let listenersBound = false;
/** @type {BroadcastChannel | null} */
let channel = null;

export function configureSyncEngine(d) {
    deps = d;
    // Cross-tab pull notifications: the tab that performs a pull is
    // the only one whose syncBranch reports movement — sibling tabs
    // would otherwise keep stale pooled agents for the branch (their
    // own retry sees 'up-to-date'). kvgit's CAS makes that loud (a
    // stale commit throws), not corrupting, but loud is still worth
    // preventing: broadcast the branch so every tab disposes.
    if (channel === null && typeof BroadcastChannel !== "undefined") {
        channel = new BroadcastChannel("agex-session-sync");
        channel.onmessage = (e) => {
            const branch = e?.data?.branch;
            if (branch && deps?.onBranchPulled) void deps.onBranchPulled(branch);
        };
    }
}

/** Wire deps and bind the focus/visibility sweep triggers (idempotent). */
export function startSyncEngine(d) {
    configureSyncEngine(d);
    if (listenersBound || typeof window === "undefined") return;
    listenersBound = true;
    const onWake = () => {
        if (document.visibilityState === "visible") void sweep();
    };
    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onWake);
    // Initial sweep shortly after boot (let the session list settle).
    setTimeout(() => void sweep(), 2500);
}

/** Test seam: clear all module state. */
export function _resetSyncEngineForTesting() {
    deps = null;
    cachedRemote = null;
    cachedRemoteKey = "";
    for (const t of pendingPushes.values()) clearTimeout(t);
    pendingPushes = new Map();
    statuses = {};
    subscribers = [];
    lastSweepAt = 0;
    channel?.close();
    channel = null;
    roster = { remoteOnly: [], archived: [] };
    rosterSubscribers = [];
}

export function isSyncConnected() {
    const s = getSettings();
    return Boolean(s.syncRepo && s.syncPat);
}

export function isSyncEnabled(branch) {
    try {
        return localStorage.getItem(ENABLED_KEY(branch)) !== "0";
    } catch {
        return true;
    }
}

export function setSyncEnabled(branch, enabled) {
    try {
        localStorage.setItem(ENABLED_KEY(branch), enabled ? "1" : "0");
    } catch {}
    if (!enabled) {
        clearTimeout(pendingPushes.get(branch));
        pendingPushes.delete(branch);
    } else if (isSyncConnected()) {
        schedulePush(branch, { delayMs: 100 });
    }
}

async function getRemote() {
    const s = getSettings();
    const key = `${s.syncRepo}|${s.syncPat}`;
    if (cachedRemote !== null && cachedRemoteKey === key) return cachedRemote;
    const store = await deps.getStore();
    cachedRemote = deps.makeRemote
        ? deps.makeRemote({ store })
        : new GithubRemote(new GithubClient({ token: s.syncPat, repo: s.syncRepo }), store);
    cachedRemoteKey = key;
    return cachedRemote;
}

// ---------------------------------------------------------------------------
// Sync operations
// ---------------------------------------------------------------------------

/**
 * Debounced post-commit push for one branch. No-op when sync isn't
 * connected, the branch opted out, or the kernel isn't ts.
 */
export function schedulePush(branch, { kernel = "ts", delayMs = PUSH_DEBOUNCE_MS } = {}) {
    if (kernel !== "ts" || deps === null) return;
    if (!isSyncConnected() || !isSyncEnabled(branch)) return;
    clearTimeout(pendingPushes.get(branch));
    pendingPushes.set(
        branch,
        setTimeout(() => {
            pendingPushes.delete(branch);
            lastScheduledSync = syncNow(branch);
        }, delayMs),
    );
}

/** Test seam: the promise of the most recently fired scheduled sync
 *  (fake timers can fire the debounce but can't await the async work
 *  behind it — crypto digests need real event-loop turns). */
let lastScheduledSync = null;
export function _lastScheduledSyncForTesting() {
    return lastScheduledSync;
}

/** Cross-tab exclusivity: one sync at a time across tabs. A busy lock
 *  returns "busy" (callers reschedule) instead of queueing — a queued
 *  duplicate sync behind another tab's run is pure waste. */
async function withSyncLock(fn) {
    const locks = globalThis.navigator?.locks;
    if (!locks) return fn(); // tests / environments without Web Locks
    return locks.request("agex-studio-session-sync", { ifAvailable: true }, async (lock) =>
        lock === null ? "busy" : fn(),
    );
}

/**
 * Pull-then-push one branch now. Updates `syncStatusStore`; returns
 * the kvgit SyncOutcome, "busy", or null (skipped / failed).
 */
export async function syncNow(branch) {
    if (deps === null || !isSyncConnected() || !isSyncEnabled(branch)) return null;
    setStatus(branch, { state: "syncing" });
    try {
        const outcome = await withSyncLock(async () => {
            const store = await deps.getStore();
            const remote = await getRemote();
            return syncBranch(store, remote, branch);
        });
        if (outcome === "busy") {
            setStatus(branch, { state: "synced", detail: "another tab is syncing" });
            schedulePush(branch, { delayMs: BUSY_RETRY_MS });
            return "busy";
        }
        applyOutcome(branch, outcome);
        const pulled = outcome.pull.status;
        if (pulled === "fast-forwarded" || pulled === "created") {
            if (deps.onBranchPulled) await deps.onBranchPulled(branch);
            // Sibling tabs share the IndexedDB store but not this
            // outcome — tell them to drop stale pooled agents too.
            channel?.postMessage({ branch });
        }
        return outcome;
    } catch (err) {
        setStatus(branch, { state: "error", detail: err?.message ?? String(err) });
        return null;
    }
}

function applyOutcome(branch, outcome) {
    if (outcome.status === "diverged") {
        setStatus(branch, {
            state: "diverged",
            detail: "This session changed on another device too — resolution UI coming next slice.",
        });
    } else if (outcome.status === "remote-gone") {
        setStatus(branch, {
            state: "remote-gone",
            detail: "The session's branch vanished from the sync repo (archived or deleted elsewhere).",
        });
    } else {
        setStatus(branch, { state: "synced" });
    }
}

/**
 * TTL-gated sweep over every sync-enabled ts chat branch except the
 * foreground one (its sync rides the post-turn push — sweeping it
 * could fast-forward state under an in-flight turn). Serialized: one
 * branch at a time, mutations already throttled client-side.
 */
export async function sweep({ force = false } = {}) {
    if (deps === null || !isSyncConnected()) return;
    const now = Date.now();
    if (!force && now - lastSweepAt < SWEEP_TTL_MS) return;
    lastSweepAt = now;
    const current = deps.currentBranch?.() ?? null;
    for (const branch of deps.listSyncableBranches()) {
        if (branch === current || !isSyncEnabled(branch)) continue;
        await syncNow(branch);
    }
    await refreshRoster();
}

// ---------------------------------------------------------------------------
// Roster: remote-only sessions (cloud stubs) + trash (archived/*)
// ---------------------------------------------------------------------------

/** @type {{ remoteOnly: Array<{branch: string, head: string}>, archived: Array<{branch: string, head: string}> }} */
let roster = { remoteOnly: [], archived: [] };
let rosterSubscribers = [];

export const syncRosterStore = {
    subscribe(fn) {
        rosterSubscribers.push(fn);
        fn(roster);
        return () => {
            rosterSubscribers = rosterSubscribers.filter((s) => s !== fn);
        };
    },
};

function setRoster(next) {
    roster = next;
    for (const fn of rosterSubscribers) fn(roster);
}

/**
 * Refresh the remote roster: sessions that exist only on the remote
 * (cloud stubs, downloadable) and archived tombstones (the trash
 * view). Also propagates tombstones — a branch archived on another
 * device gets removed locally (it stays recoverable from the trash).
 * Best-effort: roster failures never break sync proper.
 */
export async function refreshRoster() {
    if (deps === null || !isSyncConnected()) {
        setRoster({ remoteOnly: [], archived: [] });
        return;
    }
    try {
        const remote = await getRemote();
        const refs = await remote.listRefs();
        const archived = await remote.listArchivedRefs();
        const local = new Set(deps.listSyncableBranches());
        setRoster({
            remoteOnly: refs.filter((r) => !local.has(r.branch)),
            archived,
        });
        for (const a of archived) {
            if (local.has(a.branch) && isSyncEnabled(a.branch) && deps.onBranchArchivedRemotely) {
                await deps.onBranchArchivedRemotely(a.branch);
            }
        }
    } catch {
        // Roster is a convenience view; sync status carries errors.
    }
}

/** Materialize a remote-only session locally (cloud-stub download). */
export async function downloadRemoteSession(branch) {
    const outcome = await syncNow(branch);
    await deps?.onSessionListChanged?.();
    await refreshRoster();
    return outcome;
}

/** Archive the remote branch (deletion = archive, recoverable from
 *  trash). Returns false when there was nothing live to archive. */
export async function archiveSessionRemotely(branch) {
    if (deps === null || !isSyncConnected()) return false;
    try {
        const remote = await getRemote();
        const ok = await remote.archiveBranch(branch);
        await refreshRoster();
        return ok;
    } catch (err) {
        setStatus(branch, { state: "error", detail: err?.message ?? String(err) });
        return false;
    }
}

/** Restore an archived session and materialize it locally. Returns
 *  the live branch name. */
export async function restoreRemoteSession(branch) {
    const remote = await getRemote();
    const live = await remote.restoreBranch(branch);
    await syncNow(live);
    await deps?.onSessionListChanged?.();
    await refreshRoster();
    return live;
}

/** Hard-delete one archived session ("Delete forever"). */
export async function deleteForeverRemote(branch) {
    const remote = await getRemote();
    const ok = await remote.deleteForever(branch);
    await refreshRoster();
    return ok;
}

/** Hard-delete every archived session ("Empty trash"). */
export async function emptyTrashRemote() {
    const remote = await getRemote();
    const removed = await remote.emptyTrash();
    await refreshRoster();
    return removed;
}

// ---------------------------------------------------------------------------
// Divergence resolution
// ---------------------------------------------------------------------------

/** Make sure the remote head's objects exist locally (a diverged pull
 *  already fetched them; this covers the cold path). */
async function ensureRemoteObjects(store, remote, branch, remoteHead) {
    const probe = await VersionedKV.open(store, { branch });
    if ((await probe.checkout(remoteHead)) !== null) return;
    await applyWire(store, remote.fetch(remoteHead, [probe.currentCommit]));
}

async function remoteHeadOf(remote, branch) {
    const refs = await remote.listRefs();
    const head = refs.find((r) => r.branch === branch)?.head;
    if (head === undefined) {
        throw new Error(`No remote session found for '${branch}'.`);
    }
    return head;
}

/**
 * "Keep both": fork the remote side of a diverged session into a new
 * local-only branch (sync disabled — pushing it would mint a duplicate
 * remote session). The original keeps its local turns and its
 * diverged status. Returns the fork's branch name.
 */
export async function forkDivergedSession(branch) {
    const store = await deps.getStore();
    const remote = await getRemote();
    const head = await remoteHeadOf(remote, branch);
    await ensureRemoteObjects(store, remote, branch, head);
    const suffix = [...crypto.getRandomValues(new Uint8Array(4))]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    const fork = `chat-${suffix}`;
    const vk = await VersionedKV.open(store, { branch });
    await vk.createBranch(fork, { at: head });
    setSyncEnabled(fork, false);
    await deps?.onSessionListChanged?.();
    return fork;
}

/**
 * "Take remote": discard this device's diverged turns and reset the
 * local branch to the remote head. Destructive on purpose — the UI
 * confirms first. The local commits stay in the store (unreferenced)
 * until kvgit GC; this is a ref move, not an erasure.
 */
export async function resetSessionToRemote(branch) {
    const store = await deps.getStore();
    const remote = await getRemote();
    const head = await remoteHeadOf(remote, branch);
    await ensureRemoteObjects(store, remote, branch, head);
    const vk = await VersionedKV.open(store, { branch });
    await vk.resetTo(head);
    if (deps.onBranchPulled) await deps.onBranchPulled(branch);
    channel?.postMessage({ branch });
    await syncNow(branch); // reconciles sync-head bookkeeping → synced
}
