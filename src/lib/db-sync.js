/**
 * Syncing apps' databases (`app-db.js`) through the session sync repo:
 * the registry naming them, and each database's log, an epoch at a
 * time.
 *
 * - **The registry** (`dbs/registry`) syncs like any branch, and when
 *   two devices both changed it, the two merge key by key: one names a
 *   session's database the other didn't, and a key both set (two forks
 *   that each took a copy) keeps this device's, so the push after is a
 *   fast-forward.
 * - **A database's log** is its current epoch's branch, `db/<id>/<n>`.
 *   Before pushing, the database flushes and takes in what the repo has:
 *   - a newer epoch another device started: the database moves onto it,
 *     its own changes since it last synced (`synced`) rebased there;
 *   - entries on its epoch it doesn't have: the database rebases its own
 *     after them.
 *
 *   Then it pushes (a fast-forward), and an older epoch the repo still
 *   holds goes once what was pushed to it is in the current one: the
 *   database takes in what it holds past where the current epoch's
 *   snapshot was taken (`adopt`, which does nothing if there's nothing,
 *   or it was taken already), then deletes it at that tip. A device
 *   that can't tell where the snapshot was taken (it never had that
 *   commit) leaves it for one that can.
 * - **Older epochs here** stay while the repo may hold them (kvsql
 *   keeps an epoch that synced, and those after it): taking in what
 *   was pushed to one goes through them. Once the repo has none from
 *   one on, the sync deletes them here.
 * - **A conflict** stops the database where it is, with nothing changed
 *   (`state: "conflict"`): the person picks a side (`keep`), the other
 *   kept as a checkpoint.
 * - **The cap:** a database whose file is over {@link SYNC_CAP_BYTES}
 *   isn't pushed as a new epoch (each epoch uploads its whole snapshot)
 *   unless the person allows it; what the repo has still comes in.
 */

import {
    MergeChoice,
    UnknownBranchError,
    UnknownCommitError,
    cborCodec,
    clearSyncHead,
    deleteRemoteBranch,
    getSyncHead,
    pullBranch,
    pushBranch,
    syncBranch,
} from "@agex-ts/kvgit";
import { DB_BRANCHES, REGISTRY } from "./app-db.js";

/**
 * Past this size a database's file isn't uploaded as a new epoch unless
 * allowed: its gzipped snapshot is a quarter to a half of it, and GitHub
 * advises repos under a few GB.
 */
export const SYNC_CAP_BYTES = 1 << 30;

/**
 * What the sync needs of a database: its client (`DatabaseClient`), or
 * anything with the same calls.
 * @typedef {{
 *   flush(): Promise<unknown>,
 *   info(): Promise<{ branch: string }>,
 *   rebase(onto?: string, options?: { keep?: "mine" | "theirs", synced?: string | null }): Promise<RebaseResult>,
 *   adopt(tip: string, options?: { keep?: "mine" }): Promise<RebaseResult>,
 *   query(sql: string): Promise<{ rows: Record<string, unknown>[] }>,
 * }} SyncedDb
 */

/** @typedef {import("@agex-ts/kvsql/client").RebaseResult} RebaseResult */
/** @typedef {import("@agex-ts/kvgit").KVStore} KVStore */
/** @typedef {import("@agex-ts/kvgit").Remote} Remote */

/**
 * Where a database's sync stands.
 *
 * - `synced`: level with the repo.
 * - `conflict`: its changes and another device's can't both stand as
 *   they are; nothing changed. `conflict` says which step stopped
 *   (`rebase`, within an epoch or onto a newer one; `adopt`, taking in
 *   entries pushed to an older one) and what it met.
 * - `too-large`: over the cap, so not pushed; what the repo has came in.
 * - `waiting`: something moved meanwhile, or an epoch's upload isn't
 *   finished in the repo; the next sync takes it up.
 *
 * `moved` says whether the database changed under its apps here (they
 * reload). `pruned` names the older epochs deleted here: what they
 * alone held stays in the store until a sweep.
 *
 * @typedef {{
 *   state: "synced" | "conflict" | "too-large" | "waiting",
 *   detail: string,
 *   moved: boolean,
 *   pruned?: string[],
 *   conflict?: { step: "rebase" | "adopt", result: RebaseResult },
 * }} DbSyncState
 */

/** Database `id`'s log name: its epochs are `<log>/<n>`. @param {string} id */
export const dbLog = (id) => `${DB_BRANCHES}${id}`;

/** The epoch number of `branch` of log `log`, or null if it isn't one. @param {string} log @param {string} branch */
function epochOf(log, branch) {
    const m = /^(0|[1-9][0-9]*)$/.exec(branch.startsWith(`${log}/`) ? branch.slice(log.length + 1) : "");
    return m === null ? null : Number(m[1]);
}

/**
 * Whether the epoch whose tip is `commit` finished uploading its
 * snapshot: an epoch's snapshot commits say `snapshot.last` false until
 * the last.
 * @param {import("@agex-ts/kvgit").Repo<unknown>} repo @param {string} commit
 */
async function finished(repo, commit) {
    const info = /** @type {{ snapshot?: { last?: unknown } } | null} */ ((await repo.getCommit(commit)).info);
    return info?.snapshot?.last !== false;
}

/**
 * Where the snapshot of the epoch whose tip is `commit` was taken in
 * the epoch before, if this repository has that commit: what the epoch
 * holds of the one before.
 * @param {import("@agex-ts/kvgit").Repo<unknown>} repo @param {string} commit
 * @returns {Promise<{ branch: string, base: string } | null>}
 */
async function takenAt(repo, commit) {
    const snapshot = await repo.snapshot({ commit });
    const bytes = await snapshot.raw.get("epoch");
    if (bytes === undefined) return null;
    const previous = /** @type {{ previous?: { branch?: unknown, base?: unknown } | null }} */ (cborCodec.decode(bytes))?.previous;
    if (typeof previous?.branch !== "string" || typeof previous.base !== "string") return null;
    try {
        await repo.getCommit(previous.base);
    } catch (e) {
        if (e instanceof UnknownCommitError) return null;
        throw e;
    }
    return { branch: previous.branch, base: previous.base };
}

/**
 * Sync the registry: pulled and pushed, two devices' changes merged key
 * by key, this device's kept where both set one.
 *
 * @param {{ repo: import("@agex-ts/kvgit").Repo<unknown>, remote: Remote }} deps
 */
export async function syncRegistry({ repo, remote }) {
    const kv = repo.store;
    const here = await repo.branches.has(REGISTRY);
    if (!here) {
        await pullBranch(kv, remote, REGISTRY);
        return;
    }
    let out = await syncBranch(kv, remote, REGISTRY);
    if (out.status === "remote-gone") {
        await clearSyncHead(kv, REGISTRY, remote);
        out = await syncBranch(kv, remote, REGISTRY);
    }
    if (out.status === "diverged" && out.pull.remoteHead !== null) {
        const wt = await repo.worktree(REGISTRY);
        await wt.merge({ commit: out.pull.remoteHead }, {
            defaultMerge: MergeChoice.OURS,
            fastForward: false,
            info: { tool: "studio.dbs", merged: "sync" },
        });
        await pushBranch(kv, remote, REGISTRY);
    }
}

/**
 * Sync database `id`.
 *
 * @param {{
 *   kv: KVStore,
 *   repo: import("@agex-ts/kvgit").Repo<unknown>,
 *   remote: Remote,
 *   id: string,
 *   heads: Map<string, string>,
 *   db: () => Promise<SyncedDb>,
 *   large?: boolean,
 *   cap?: number,
 *   keep?: "mine" | "theirs",
 * }} deps
 *   the store and repository the log is in; the remote; the database's
 *   id; the repo's branches and heads as a roster just read them; its
 *   client; whether it may be pushed over the cap, and the cap; and the side to keep
 *   at a conflict (`"theirs"` isn't offered when taking in entries
 *   pushed to an older epoch)
 * @returns {Promise<DbSyncState>}
 */
export async function syncDb({ kv, repo, remote, id, heads, db: open, large = false, cap = SYNC_CAP_BYTES, keep }) {
    const log = dbLog(id);
    /** The repo's epochs of the log, newest first. */
    const theirs = [...heads.keys()]
        .map((branch) => ({ branch, n: epochOf(log, branch) }))
        .filter((e) => e.n !== null)
        .sort((a, b) => /** @type {number} */ (b.n) - /** @type {number} */ (a.n));
    const db = await open();
    await db.flush();
    let moved = false;
    /** @param {RebaseResult} result */
    const took = (result) => {
        if (result.status !== "up-to-date") moved = true;
    };
    /** @param {"rebase" | "adopt"} step @param {RebaseResult} result @returns {DbSyncState} */
    const stopped = (step, result) => ({
        state: "conflict",
        detail:
            step === "adopt"
                ? "Changes another device synced to an older copy of it don't fit with this device's."
                : result.schemaChange === "mine"
                  ? "Its tables changed here, and its data on another device."
                  : result.schemaChange === "theirs"
                    ? "Its tables changed on another device, and its data here."
                    : "It changed here and on another device in ways that don't fit together.",
        moved,
        conflict: { step, result },
    });

    let current = (await db.info()).branch;
    const n = epochOf(log, current) ?? 0;

    // a newer epoch another device started, if one finished uploading
    for (const epoch of theirs) {
        if (/** @type {number} */ (epoch.n) <= n) break;
        await pullBranch(kv, remote, epoch.branch);
        const tip = await repo.branches.get(epoch.branch);
        if (!(await finished(repo, tip))) continue;
        // what the newer epoch holds of this one: up to where its snapshot
        // was taken, if that commit is here (the database works it out);
        // else up to where this device last synced, whose later pushes the
        // device that started the epoch takes in before the old one goes,
        // or none of it if it never synced this epoch
        const taken = await takenAt(repo, tip);
        const synced = taken?.branch === current ? undefined : await getSyncHead(kv, current, remote);
        const result = await db.rebase(undefined, {
            ...(synced !== undefined && { synced }),
            ...(keep !== undefined && { keep }),
        });
        if (result.status === "conflict") return stopped("rebase", result);
        took(result);
        current = (await db.info()).branch;
        keep = undefined;
        break;
    }

    // entries on its epoch it doesn't have
    if (heads.has(current)) {
        const pulled = await pullBranch(kv, remote, current);
        if (pulled.status === "remote-gone") {
            return { state: "waiting", detail: "Its copy in the sync repo was replaced.", moved };
        }
        if (pulled.status !== "up-to-date") {
            const onto = pulled.status === "diverged" ? /** @type {string} */ (pulled.remoteHead) : undefined;
            const result = await db.rebase(onto, keep === undefined ? {} : { keep });
            if (result.status === "conflict") return stopped("rebase", result);
            took(result);
            keep = undefined;
        }
    } else if (!large) {
        // a new epoch to upload: whole, so not past the cap
        const size = await db.query("SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()");
        const bytes = Number(size.rows[0]?.bytes ?? 0);
        if (bytes > cap) {
            return { state: "too-large", detail: `Its ${Math.round(bytes / 2 ** 20)} MB stay on this device until its sync is allowed.`, moved };
        }
    }

    const pushed = await pushBranch(kv, remote, current);
    if (pushed.status === "diverged" || pushed.status === "remote-gone") {
        return { state: "waiting", detail: "It changed in the sync repo meanwhile.", moved };
    }

    // older epochs the repo still holds: what was pushed to them comes in
    // first, then they go at the tip that was taken in. Each is pulled
    // before any is taken in, so the snapshots linking an older one to
    // this are here.
    const now = epochOf(log, current) ?? 0;
    const older = [...theirs].reverse().filter((e) => /** @type {number} */ (e.n) < now);
    /** @type {Map<string, string | null>} */
    const tips = new Map();
    for (const epoch of older) tips.set(epoch.branch, (await pullBranch(kv, remote, epoch.branch)).remoteHead);
    /** The oldest epoch the repo still has, past this sync. */
    let left = Number.POSITIVE_INFINITY;
    for (const epoch of older) {
        const tip = tips.get(epoch.branch) ?? null;
        if (tip === null) continue;
        let result;
        try {
            result = await db.adopt(tip, keep === "mine" ? { keep: "mine" } : {});
        } catch (e) {
            // where the snapshot was taken isn't known here: left for a
            // device that knows
            if (e instanceof Error && /isn't known here/.test(e.message)) {
                left = Math.min(left, /** @type {number} */ (epoch.n));
                continue;
            }
            throw e;
        }
        if (result.status === "conflict") return stopped("adopt", result);
        took(result);
        if (result.status === "rebased" && (await pushBranch(kv, remote, current)).status !== "pushed") {
            return { state: "waiting", detail: "It changed in the sync repo meanwhile.", moved };
        }
        const deleted = await deleteRemoteBranch(kv, remote, epoch.branch, { expected: tip });
        if (deleted.status === "moved") {
            return { state: "waiting", detail: "An older copy of it changed in the sync repo meanwhile.", moved };
        }
    }

    // older epochs here the repo no longer has go, with their sync heads:
    // what was pushed to them is in. The oldest it still has stays, and
    // those after it, which taking it in later goes through.
    const pruned = [];
    for (const branch of await repo.branches.list()) {
        const k = epochOf(log, branch);
        if (k === null || k >= Math.min(now, left)) continue;
        try {
            await repo.branches.delete(branch);
        } catch (e) {
            // the database deleted it meanwhile
            if (!(e instanceof UnknownBranchError)) throw e;
        }
        await clearSyncHead(kv, branch);
        pruned.push(branch);
    }
    return { state: "synced", detail: "", moved, ...(pruned.length > 0 && { pruned }) };
}
