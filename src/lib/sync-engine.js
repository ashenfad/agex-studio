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

import { VersionedKV, applyWire, clearSyncHead, getSyncHead, syncBranch } from "@agex-ts/kvgit";
import { GithubClient, GithubRemote, base64ToBytes, bytesToBase64 } from "@agex-ts/kvgit/github";
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
 * @property {"pending" | "syncing" | "synced" | "diverged" | "remote-gone" | "error"} state
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

function clearStatus(branch) {
    if (!(branch in statuses)) return;
    const { [branch]: _gone, ...rest } = statuses;
    statuses = rest;
    for (const fn of subscribers) fn(statuses);
}

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
 * @property {(remote: any, branch: string) => Promise<string | null>} [fetchStubTitle]
 *     — display title for a remote-only session (reads branch meta at
 *     the tip); failures tolerated, null = fall back to generic copy
 * @property {(branch: string) => Record<string, string>} [readAppState]
 *     — the session's app-storage bag (localStorage shim contents)
 * @property {(branch: string, entries: Record<string, string>) => void} [applyAppState]
 *     — replace the local bag with synced entries
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

/**
 * Run once right after sync connects: nothing else pushes
 * pre-existing sessions (schedulePush is turn-driven and the boot
 * sweep predates the connection), so force an immediate sweep for the
 * background sessions and queue the foreground one through the normal
 * debounced path.
 */
export async function kickoffSync() {
    if (deps === null || !isSyncConnected()) return;
    const current = deps.currentBranch?.() ?? null;
    if (current) schedulePush(current, { delayMs: 1000 });
    lastSweepAt = 0;
    await sweep({ force: true });
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
    for (const t of appStateTimers.values()) clearTimeout(t);
    appStateTimers = new Map();
    lastPushedAppJson = new Map();
    lastLocalAppWriteAt = new Map();
    lastAppliedAppAt = new Map();
    appStateIndex = null;
    appStatePushCount = 0;
    appStateSizeWarned = new Set();
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
        clearStatus(branch);
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
    // Honest indicator: between the turn ending and the debounce
    // firing, the session is queued, not synced.
    setStatus(branch, { state: "pending" });
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

/** Count an (a)sync iterable's items as they flow through. */
async function* counted(iter, onCount) {
    let n = 0;
    for await (const item of iter) {
        n++;
        onCount(n);
        yield item;
    }
}

/**
 * Per-sync progress instrumentation: a delegating wrapper (class
 * privates forbid spreading) that live-counts wire commits in both
 * directions. Commits ≈ turns, a unit users understand; totals would
 * need a kvgit API addition, so counts are indeterminate for now.
 */
function instrumentedRemote(remote, branch, pushTotal = null) {
    const suffix = pushTotal !== null ? ` of ${pushTotal}` : "";
    return {
        listRefs: () => remote.listRefs(),
        fetch: (want, have) =>
            counted(remote.fetch(want, have), (n) =>
                setStatus(branch, {
                    state: "syncing",
                    detail: `downloading · turn ${n}`,
                }),
            ),
        push: (b, expectedOld, newHead, commits) =>
            remote.push(
                b,
                expectedOld,
                newHead,
                counted(commits, (n) =>
                    setStatus(branch, {
                        state: "syncing",
                        detail: `uploading · turn ${n}${suffix}`,
                    }),
                ),
            ),
    };
}

/** Storage-v1 read-only probe — avoids VersionedKV.open, which would
 *  CREATE the branch (poison for the download path). */
async function localBranchExists(store, branch) {
    return (await store.get(`__branch_head__${branch}`)) !== null;
}

/** Full local history count: the determinate total for a first-ever
 *  push (no sync head ⇒ the delta IS the whole branch). Local reads
 *  only — cheap even for long sessions. */
async function countLocalCommits(store, branch) {
    const vk = await VersionedKV.open(store, { branch });
    let n = 0;
    for await (const _ of vk.history(vk.currentCommit, { allParents: true })) n++;
    return n;
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
            // First-ever push of an existing local branch: the delta
            // is the full history, countable locally — determinate
            // progress for exactly the sync that takes minutes (each
            // mutation is deliberately throttled ~750ms).
            let pushTotal = null;
            if (
                (await getSyncHead(store, branch)) === null &&
                (await localBranchExists(store, branch))
            ) {
                pushTotal = await countLocalCommits(store, branch);
            }
            return syncBranch(store, instrumentedRemote(remote, branch, pushTotal), branch);
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
            // The session (and its app) reloads after a pull — fetch
            // the app's save data alongside.
            await pullAppState(branch);
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
        // App save data can change remotely without any session turns
        // (the app was used, not the chat) — check it independently.
        await pullAppState(branch);
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
        const remoteOnly = refs.filter((r) => !local.has(r.branch));
        if (deps.fetchStubTitle) {
            // Independent GETs, small bounded N — parallel, with
            // per-item tolerance (a title is a nicety, not a gate).
            await Promise.all(
                remoteOnly.map((r) =>
                    deps
                        .fetchStubTitle(remote, r.branch)
                        .then((title) => {
                            r.title = title;
                        })
                        .catch(() => {}),
                ),
            );
        }
        setRoster({ remoteOnly, archived });
        const current = deps.currentBranch?.() ?? null;
        for (const a of archived) {
            // Never delete the foreground session out from under the
            // user (mid-turn writes to a deleted branch); consistent
            // with the sweep's foreground-skip. The tombstone applies
            // on a later refresh once they've switched away.
            if (a.branch === current) continue;
            if (local.has(a.branch) && isSyncEnabled(a.branch) && deps.onBranchArchivedRemotely) {
                try {
                    await deps.onBranchArchivedRemotely(a.branch);
                } catch (err) {
                    // One branch's local-removal failure must not
                    // block the rest of the batch.
                    console.error(`Tombstone propagation failed for ${a.branch}:`, err);
                }
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
    await deleteAppStateFile(branch);
    await refreshRoster();
    return ok;
}

/** Hard-delete every archived session ("Empty trash"). */
export async function emptyTrashRemote() {
    const remote = await getRemote();
    const archived = await remote.listArchivedRefs();
    const removed = await remote.emptyTrash();
    for (const a of archived) await deleteAppStateFile(a.branch);
    await refreshRoster();
    return removed;
}

// ---------------------------------------------------------------------------
// App-state sidecar
//
// Apps' save data (the localStorage shim bag) is runtime state, not
// history — deliberately NOT in kvgit (see app-storage.js's history
// note), so it syncs as a sidecar: one JSON file per session at
// `app-state/<branch>.json` on a dedicated `app-state` branch in the
// sync repo (keeps main's history clean of save-noise). Last-writer-
// wins by `updatedAt`, with the contents API's sha requirement as the
// optimistic CAS. Pulls happen where the app reloads anyway (stub
// download, branch pulled, sweep), so a running app is never mutated
// underneath — at worst a pull is skipped because local writes are
// newer, and the next push reconciles.
// ---------------------------------------------------------------------------

const APP_STATE_BRANCH = "app-state";
const APP_STATE_DEBOUNCE_MS = 20_000;
/** Squash app-state history to a parentless commit every N pushes —
 *  snapshots need no history (LWW reads the tip only), and without
 *  this, every save stays reachable forever. */
const APP_STATE_SQUASH_EVERY = 25;
/** Bags above this don't ride the background loop (also near the
 *  5MB localStorage quota, where something else is wrong). */
const APP_STATE_MAX_BYTES = 2_000_000;

function appStateSyncEnabled() {
    return getSettings().syncAppState !== false;
}
const appStatePath = (branch) => `app-state/${branch}.json`;

const _enc = new TextEncoder();
const _dec = new TextDecoder();

let appStateTimers = new Map();
let lastPushedAppJson = new Map();
let lastLocalAppWriteAt = new Map();
let lastAppliedAppAt = new Map();
/** Which branches have remote app-state, from one directory listing —
 *  avoids a 404-logging GET per app-less session on every sweep. */
let appStateIndex = null;
let appStatePushCount = 0;
let appStateSizeWarned = new Set();

async function getAppStateIndex(client, { maxAgeMs = 60_000 } = {}) {
    if (appStateIndex !== null && Date.now() - appStateIndex.at < maxAgeMs) {
        return appStateIndex.set;
    }
    let set = new Set();
    try {
        const listing = await client.request(
            "GET",
            `contents/app-state?ref=${APP_STATE_BRANCH}`,
        );
        if (Array.isArray(listing)) {
            set = new Set(
                listing
                    .filter((f) => String(f.name).endsWith(".json"))
                    .map((f) => String(f.name).replace(/\.json$/, "")),
            );
        }
    } catch (err) {
        if (err?.kind !== "not-found") throw err;
        // First contact: the directory doesn't exist yet, and browsers
        // log the 404 once per sweep no matter how gracefully we
        // handle it. Seed the branch + a .keep file so every future
        // listing — on every device — is a clean 200. One-time,
        // cosmetic-failure-tolerant.
        try {
            await ensureAppStateBranch(client);
            await client.request("PUT", "contents/app-state/.keep", {
                message: "app-state: seed directory",
                content: "",
                branch: APP_STATE_BRANCH,
            });
        } catch {
            // Seeding is cosmetic; the next sweep retries.
        }
    }
    appStateIndex = { at: Date.now(), set };
    return set;
}

/** Debounced push of a session's app-storage bag (called from the
 *  app-preview write funnel). Long debounce: apps can save per
 *  interaction; the bag is tiny and LWW makes missed intermediate
 *  states harmless. */
export function scheduleAppStateSync(branch) {
    if (deps === null || !isSyncConnected() || !isSyncEnabled(branch)) return;
    if (!deps.readAppState || !appStateSyncEnabled()) return;
    lastLocalAppWriteAt.set(branch, Date.now());
    clearTimeout(appStateTimers.get(branch));
    appStateTimers.set(
        branch,
        setTimeout(() => {
            appStateTimers.delete(branch);
            void pushAppState(branch);
        }, APP_STATE_DEBOUNCE_MS),
    );
}

async function ensureAppStateBranch(client) {
    if ((await client.getRef(APP_STATE_BRANCH)) !== null) return;
    const main = await client.getRef("main");
    if (main === null) throw new Error("sync repo has no main branch");
    await client.createRef(APP_STATE_BRANCH, main);
}

/** Read the remote app-state file: { payload, sha } or null. */
async function readRemoteAppState(client, branch) {
    try {
        const data = await client.request(
            "GET",
            `contents/${appStatePath(branch)}?ref=${APP_STATE_BRANCH}`,
        );
        const payload = JSON.parse(_dec.decode(base64ToBytes(data.content)));
        return { payload, sha: data.sha };
    } catch (err) {
        if (err?.kind === "not-found") return null;
        throw err;
    }
}

export async function pushAppState(branch) {
    if (deps === null || !isSyncConnected() || !isSyncEnabled(branch)) return;
    if (!deps.readAppState || !appStateSyncEnabled()) return;
    try {
        const entries = deps.readAppState(branch) ?? {};
        const json = JSON.stringify(entries);
        if (json === lastPushedAppJson.get(branch)) return; // unchanged
        if (json.length > APP_STATE_MAX_BYTES) {
            if (!appStateSizeWarned.has(branch)) {
                appStateSizeWarned.add(branch);
                console.warn(
                    `app-state for ${branch} is ${json.length} bytes — too large for background sync; skipping`,
                );
            }
            return;
        }
        const remote = await getRemote();
        const client = remote.client;
        await ensureAppStateBranch(client);

        for (let attempt = 0; attempt < 2; attempt++) {
            const existing = await readRemoteAppState(client, branch);
            const localAt = lastLocalAppWriteAt.get(branch) ?? Date.now();
            if (existing !== null && existing.payload.updatedAt > localAt) {
                // Another device saved more recently — inbound wins.
                applyRemoteAppState(branch, existing.payload);
                return;
            }
            const payload = { format: 1, kernel: "ts", updatedAt: localAt, entries };
            try {
                await client.request("PUT", `contents/${appStatePath(branch)}`, {
                    message: `app-state: ${branch}`,
                    content: bytesToBase64(_enc.encode(JSON.stringify(payload))),
                    branch: APP_STATE_BRANCH,
                    ...(existing !== null && { sha: existing.sha }),
                });
                lastPushedAppJson.set(branch, json);
                // What we pushed is what's applied — without this the
                // next pull re-applies our own bag.
                lastAppliedAppAt.set(branch, localAt);
                appStateIndex?.set.add(branch);
                if (++appStatePushCount >= APP_STATE_SQUASH_EVERY) {
                    appStatePushCount = 0;
                    await squashAppStateHistory(client);
                }
                return;
            } catch (err) {
                // sha race (another tab/device wrote) — re-read once.
                if (err?.kind !== "validation" || attempt === 1) throw err;
            }
        }
    } catch (err) {
        console.warn(`app-state push failed for ${branch}:`, err);
    }
}

function applyRemoteAppState(branch, payload) {
    deps.applyAppState?.(branch, payload.entries ?? {});
    lastAppliedAppAt.set(branch, payload.updatedAt);
    // Don't bounce the applied state straight back as a push.
    lastPushedAppJson.set(branch, JSON.stringify(payload.entries ?? {}));
}

export async function pullAppState(branch) {
    if (deps === null || !isSyncConnected() || !isSyncEnabled(branch)) return;
    if (!deps.applyAppState || !appStateSyncEnabled()) return;
    try {
        const remote = await getRemote();
        // One listing request answers "which sessions have app state"
        // for the whole sweep — no per-branch 404 probes.
        const index = await getAppStateIndex(remote.client);
        if (!index.has(branch)) return;
        const existing = await readRemoteAppState(remote.client, branch);
        if (existing === null) return;
        const { payload } = existing;
        if (payload.updatedAt <= (lastAppliedAppAt.get(branch) ?? 0)) return;
        if ((lastLocalAppWriteAt.get(branch) ?? 0) > payload.updatedAt) return; // local pending wins
        applyRemoteAppState(branch, payload);
    } catch (err) {
        console.warn(`app-state pull failed for ${branch}:`, err);
    }
}

/**
 * Drop the app-state branch's history: a parentless commit carrying
 * the CURRENT tree, force-moved into place. Identical content, zero
 * ancestry — everything older becomes unreachable for GitHub's GC.
 * Small race: a concurrent push from another device between our read
 * and the force-move gets orphaned — one lost LWW snapshot that the
 * next save re-writes; acceptable for save data, so no locking.
 */
async function squashAppStateHistory(client) {
    try {
        const tip = await client.getRef(APP_STATE_BRANCH);
        if (tip === null) return;
        const { tree } = await client.getCommit(tip);
        const person = {
            name: "agex-studio",
            email: "sync@agex.studio",
            date: new Date().toISOString(),
        };
        const orphan = await client.createCommit({
            message: "app-state: squash history",
            tree,
            parents: [],
            author: person,
            committer: person,
        });
        await client.updateRef(APP_STATE_BRANCH, orphan, { force: true });
    } catch (err) {
        console.warn("app-state squash failed (history kept; will retry):", err);
    }
}

/** Best-effort removal of a session's app-state file (delete-forever
 *  and empty-trash paths). */
async function deleteAppStateFile(branch) {
    try {
        const remote = await getRemote();
        // One listing request answers "which sessions have app state"
        // for the whole sweep — no per-branch 404 probes.
        const index = await getAppStateIndex(remote.client);
        if (!index.has(branch)) return;
        const existing = await readRemoteAppState(remote.client, branch);
        if (existing === null) return;
        await remote.client.request("DELETE", `contents/${appStatePath(branch)}`, {
            message: `app-state: remove ${branch}`,
            sha: existing.sha,
            branch: APP_STATE_BRANCH,
        });
        appStateIndex?.set.delete(branch);
    } catch {
        // Orphaned app-state files are invisible junk, not corruption.
    }
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
 * Recovery for `remote-gone`: forget the remote-tracking bookkeeping
 * and sync again — the branch re-creates on the remote as a fresh
 * push (the prior remote lineage stays recoverable from the trash).
 */
export async function repushSession(branch) {
    const store = await deps.getStore();
    await clearSyncHead(store, branch);
    return syncNow(branch);
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
