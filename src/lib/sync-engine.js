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

import { syncBranch } from "@agex-ts/kvgit";
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
}
