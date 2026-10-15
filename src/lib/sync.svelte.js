/**
 * Session sync: each session a branch of a GitHub repo of the person's
 * own, one pack per push (kvgit's `PackRemote`).
 *
 * - **When:** a session is pushed a few seconds after it changes here
 *   (a turn, an undo, a rename, files added), and every session is
 *   compared with the repo on arrival and when the page comes back into
 *   view (at most every few minutes): one query for all of them, then a
 *   sync of each that differs.
 * - **Fast-forward only.** A sync pulls, then pushes. When both sides
 *   moved, the session is marked diverged and nothing moves until the
 *   person picks a side: the synced version (this device's is kept as a
 *   session of its own), or this device's (written on top of the synced
 *   one, so the other device's work stays in its history).
 * - **The repo's other sessions** show as cloud sessions to download,
 *   and its archived ones as the trash, restorable until emptied.
 *   Deleting a synced session asks whether to remove it here only or
 *   everywhere (into the trash).
 * - **What syncs:** sessions with a title (a new, untouched session
 *   stays local until its first turn), not a delegate's or a task's
 *   branch; and with each, its app's saved data, on a branch of its own
 *   (`app-data.js`: never in the session's history, so never in what it
 *   bundles or publishes), the later of two devices' writes winning.
 */

import { MergeChoice, clearSyncHead, getSyncHead, pullBranch, syncBranch } from "@agex-ts/kvgit";
import { GithubClient, PackRemote } from "@agex-ts/kvgit/github";
import { readLocal, writeLocal } from "./local.js";
import { getSettings, settingsStore } from "./settings.js";
import { openStore } from "./store.js";
import { studio } from "./studio.svelte.js";
import { describe } from "./sync-connect.js";
import { SessionBusy } from "./gate.js";
import { APP_DATA, appBranch, commitAppData, moveAppData, readAppData } from "./app-data.js";
import { read as readAppStorage, write as writeAppStorage } from "./app-storage.js";
import { adoptRepo, localNote, nextState } from "./sync-state.js";

/** How long after a change a session is pushed. */
const PUSH_DELAY = 4000;
/** How long after an app writes its data it is pushed. */
const APP_DATA_DELAY = 10_000;

/** When session `name`'s app last wrote its data here. @param {string} name */
function appWrittenAt(name) {
    return Number(readLocal(`agex-app-at:${name}`) ?? 0);
}

/** @param {string} name @param {number} at */
function setAppWrittenAt(name, at) {
    writeLocal(`agex-app-at:${name}`, String(at));
}

/** Where the repo this device's sync heads were recorded against is
 *  noted. */
const notedRepo = localNote("agex-sync-repo");

/** How often, at most, the page compares every session with the repo. */
const SWEEP_EVERY = 5 * 60 * 1000;

/**
 * @typedef {import("./sync-state.js").SyncState} SyncState
 * @typedef {{ name: string, title: string, updatedAt: number }} RemoteSession
 */

/** Whether the settings connect sync. */
function syncConnected(s = getSettings()) {
    return s.syncRepo.trim() !== "" && s.syncToken.trim() !== "";
}

/** One sync at a time per browser, across tabs where the browser can. @param {() => Promise<void>} fn */
async function exclusively(fn) {
    if (typeof navigator !== "undefined" && navigator.locks) {
        await navigator.locks.request("agex-studio-sync", fn);
    } else {
        await fn();
    }
}

export class Sync {
    /** @type {Record<string, SyncState>} */
    status = $state({});
    /** Sessions in the repo and not here. @type {RemoteSession[]} */
    cloud = $state([]);
    /** Sessions archived in the repo. @type {RemoteSession[]} */
    trash = $state([]);
    /** What went wrong with sync as a whole (the repo or the token). */
    /** @type {string | null} */
    problem = $state(null);

    /** @type {Map<string, ReturnType<typeof setTimeout>>} */
    #timers = new Map();
    #lastSweep = 0;
    /** @type {Promise<PackRemote> | null} */
    #remote = null;
    #remoteKey = "";

    /** Whether the settings connect sync: following them, so connecting
     *  sweeps at once and disconnecting forgets this device's state. */
    connected = $state(false);

    /** @param {import("./studio.svelte.js").Studio} studio */
    constructor(studio) {
        this.studio = studio;
        settingsStore.subscribe((s) => {
            const was = this.connected;
            this.connected = syncConnected(s);
            if (this.connected && !was && studio.sessions.length > 0) void this.sweep({ force: true });
            if (was && !this.connected) this.disconnect();
        });
    }

    /** The remote for the settings now, made once for them. */
    #remoteNow() {
        const s = getSettings();
        const key = `${s.syncRepo}|${s.syncToken}`;
        if (this.#remote === null || key !== this.#remoteKey) {
            const remote = this.#connect(s.syncRepo.trim(), s.syncToken.trim());
            // one that failed to open is tried afresh next time
            remote.catch(() => {
                if (this.#remote === remote) this.#remote = null;
            });
            this.#remote = remote;
            this.#remoteKey = key;
        }
        return this.#remote;
    }

    /** A remote on `repo`: the sync heads recorded against another repo
     *  go first. @param {string} repo @param {string} token */
    async #connect(repo, token) {
        const store = await openStore();
        await adoptRepo(store.repo, repo, notedRepo);
        const client = new GithubClient({ token, repo, writeIntervalMs: 0 });
        return new PackRemote(client, store.repo.store, { meta: (branch) => this.#meta(branch) });
    }

    /** What the repo's roster shows of a session. @param {string} name */
    #meta(name) {
        const info = this.studio.sessions.find((s) => s.name === name);
        return { title: info?.title ?? "", updatedAt: info?.updatedAt ?? Date.now() };
    }

    /** @param {string} name @param {SyncState["state"]} state @param {string} [detail] */
    #mark(name, state, detail = "") {
        this.status[name] = nextState(this.status[name], state, detail);
    }

    /** Whether session `name` syncs: it has been used (it has a title),
     *  and it is the person's (no dot). @param {string} name */
    #syncs(name) {
        if (name.includes(".")) return false;
        return (this.studio.sessions.find((s) => s.name === name)?.title ?? "") !== "";
    }

    /** Session `name`'s app wrote its data here: noted, and pushed a
     *  little later. @param {string} name */
    appChanged(name) {
        setAppWrittenAt(name, Date.now());
        if (!this.connected || !this.#syncs(name)) return;
        clearTimeout(this.#appTimers.get(name));
        this.#appTimers.set(
            name,
            setTimeout(() => {
                this.#appTimers.delete(name);
                void exclusively(() => this.#syncApp(name).catch(() => undefined));
            }, APP_DATA_DELAY),
        );
    }

    /** @type {Map<string, ReturnType<typeof setTimeout>>} */
    #appTimers = new Map();

    /**
     * Sync session `name`'s app data: what the app wrote here is
     * committed, then pulled and pushed; pulled data replaces what is
     * here, and two devices' writes settle on the later. An app showing
     * is told, not reloaded under the person.
     *
     * @param {string} name
     */
    async #syncApp(name) {
        const store = await openStore();
        const kv = store.repo.store;
        const remote = await this.#remoteNow();
        const branch = appBranch(name);
        await commitAppData(store, name, { bag: readAppStorage("ts", name), at: appWrittenAt(name) });
        const here = await store.repo.branches.has(branch);
        if (!here) {
            // nothing written here: take what another device wrote, if any
            const pulled = await pullBranch(kv, remote, branch);
            if (pulled.status === "created") await this.#takeAppData(name, { branch });
            return;
        }
        let out = await syncBranch(kv, remote, branch);
        if (out.pull.status === "fast-forwarded" || out.pull.status === "created") await this.#takeAppData(name, { branch });
        if (out.status === "diverged" && out.pull.remoteHead !== null) {
            // both wrote: the later wins, on top of the other's, so the push is a fast-forward
            const theirs = await readAppData(store, { commit: out.pull.remoteHead });
            const mine = await readAppData(store, { branch });
            await moveAppData(store, name, out.pull.remoteHead);
            if (theirs !== null && (mine === null || theirs.at >= mine.at)) await this.#takeAppData(name, { branch });
            else if (mine !== null) await commitAppData(store, name, mine);
            out = await syncBranch(kv, remote, branch);
        }
    }

    /**
     * Whether session `name`'s app data here holds what the repo doesn't:
     * a write not committed yet, or a commit not pushed.
     *
     * @param {string} name
     */
    async #appDataUnpushed(name) {
        const store = await openStore();
        const branch = appBranch(name);
        const held = await readAppData(store, { branch });
        const bag = readAppStorage("ts", name);
        const written = held === null ? Object.keys(bag).length > 0 : JSON.stringify(held.bag) !== JSON.stringify(bag);
        if (written) return true;
        if (held === null) return false;
        return (await getSyncHead(store.repo.store, branch)) !== (await store.repo.branches.get(branch));
    }

    /** Put the app data `ref` holds into the app's storage here, and tell
     *  a preview showing it. @param {string} name @param {{ branch: string }} ref */
    async #takeAppData(name, ref) {
        const data = await readAppData(await openStore(), ref);
        if (data === null) return;
        writeAppStorage("ts", name, data.bag);
        setAppWrittenAt(name, data.at);
        const open = this.studio.opened(name);
        if (open !== undefined) open.appDataStamp += 1;
    }

    /** Push session `name` once it has been still for a moment.
     *  @param {string} name @param {number} [delay] */
    schedule(name, delay = PUSH_DELAY) {
        if (!this.connected || !this.#syncs(name)) return;
        clearTimeout(this.#timers.get(name));
        this.#mark(name, "pending");
        this.#timers.set(
            name,
            setTimeout(() => {
                this.#timers.delete(name);
                void this.syncNow(name);
            }, delay),
        );
    }

    /**
     * Pull session `name`, then push it. A session with a turn running
     * waits for the turn to end; one open here takes in what was pulled.
     *
     * @param {string} name
     */
    async syncNow(name) {
        if (!this.connected) return;
        let moved = false;
        await exclusively(async () => {
            const session = this.studio.opened(name);
            if (session?.busy || session?.folding) {
                // its turn's (or fold's) end schedules it again
                this.#mark(name, "pending", "after the turn");
                return;
            }
            this.#mark(name, "syncing");
            try {
                const remote = await this.#remoteNow();
                const kv = (await openStore()).repo.store;
                const run = async () => {
                    const out = await syncBranch(kv, remote, name);
                    if (out.pull.status === "fast-forwarded" || out.pull.status === "created") {
                        moved = true;
                        await session?.adoptPulled();
                    }
                    return out;
                };
                let out;
                try {
                    out = session === undefined ? await run() : await session.hold(run);
                } catch (e) {
                    if (!(e instanceof SessionBusy)) throw e;
                    // a turn started while the remote was reached
                    this.#mark(name, "pending", "after the turn");
                    return;
                }
                // its app's data beside it (a failure there isn't the session's)
                await this.#syncApp(name).catch(() => undefined);
                if (out.status === "diverged") this.#mark(name, "diverged", "It changed on another device too.");
                else if (out.status === "remote-gone") this.#mark(name, "remote-gone", "It was removed from the sync repo elsewhere.");
                else this.#mark(name, "synced");
                this.problem = null;
            } catch (e) {
                this.#mark(name, "error", describe(e));
            }
        });
        if (moved) await this.studio.refresh();
    }

    /**
     * Compare every session with the repo: one query, then a sync of
     * each that differs. Also lists the repo's other sessions and its
     * trash, and takes away here a session archived elsewhere that
     * hasn't changed here since it last synced.
     *
     * @param {{ force?: boolean }} [opts]
     */
    async sweep({ force = false } = {}) {
        if (!this.connected) return;
        if (!force && Date.now() - this.#lastSweep < SWEEP_EVERY) return;
        this.#lastSweep = Date.now();
        try {
            const remote = await this.#remoteNow();
            const roster = await remote.roster();
            this.problem = null;
            await this.studio.refresh();
            const store = await openStore();
            const kv = store.repo.store;
            /** @type {Map<string, import("@agex-ts/kvgit/github").RosterEntry>} */
            const live = new Map();
            /** @type {Map<string, import("@agex-ts/kvgit/github").RosterEntry>} */
            const archived = new Map();
            /** App-data heads in the repo, by session. @type {Map<string, string>} */
            const appHeads = new Map();
            for (const r of roster) {
                if (r.branch.startsWith(APP_DATA)) {
                    if (!r.archived) appHeads.set(r.branch.slice(APP_DATA.length), r.head);
                    continue;
                }
                if (r.branch.includes(".")) continue;
                (r.archived ? archived : live).set(r.branch, r);
            }
            const here = new Set(this.studio.sessions.map((s) => s.name));
            /** @param {import("@agex-ts/kvgit/github").RosterEntry} r */
            const shown = (r) => {
                const meta = /** @type {{ title?: string, updatedAt?: number } | null} */ (r.meta);
                return { name: r.branch, title: meta?.title ?? "", updatedAt: meta?.updatedAt ?? 0 };
            };
            this.cloud = [...live.values()].filter((r) => !here.has(r.branch)).map(shown).sort((a, b) => b.updatedAt - a.updatedAt);
            this.trash = [...archived.values()].filter((r) => !live.has(r.branch)).map(shown);

            for (const info of [...this.studio.sessions]) {
                const name = info.name;
                const head = await store.repo.branches.get(name);
                const r = live.get(name);
                if (r?.head === head) {
                    this.#mark(name, "synced");
                    // the session is level; its app's data may not be
                    const appHead = (await store.repo.branches.has(appBranch(name))) ? await store.repo.branches.get(appBranch(name)) : null;
                    const written = appWrittenAt(name) > (appHead === null ? 0 : ((await readAppData(store, { commit: appHead }))?.at ?? 0));
                    if (this.#syncs(name) && ((appHeads.get(name) ?? null) !== appHead || written)) {
                        await exclusively(() => this.#syncApp(name).catch(() => undefined));
                    }
                    continue;
                }
                if (r === undefined && archived.has(name)) {
                    const synced = await getSyncHead(kv, name);
                    if (synced !== null) {
                        // archived elsewhere: unchanged here since, it goes
                        // (it's in the trash); changed here, the person decides
                        // ...and its app data unchanged too: a write not yet pushed keeps it here
                        if (synced === head && this.studio.current?.name !== name && !(await this.#appDataUnpushed(name))) await this.studio.remove(name);
                        else this.#mark(name, "remote-gone", "It was moved to the trash on another device.");
                        continue;
                    }
                }
                if (this.#syncs(name)) await this.syncNow(name);
            }
        } catch (e) {
            this.problem = describe(e);
        }
    }

    /** Bring a cloud session here; it leaves the cloud list once it is
     *  here, and stays there to retry when it isn't. @param {string} name */
    async download(name) {
        await this.syncNow(name);
        await this.studio.refresh();
        if (!this.studio.sessions.some((s) => s.name === name)) {
            throw new Error(this.status[name]?.detail || "the download didn't finish; try again");
        }
        this.cloud = this.cloud.filter((c) => c.name !== name);
    }

    /**
     * Settle a diverged session on the synced version: this device's is
     * kept as a session of its own ("… (this device)"), and the session
     * moves to the synced head.
     *
     * @param {string} name
     */
    async useSynced(name) {
        const remoteHead = await this.#remoteHead(name);
        const session = this.studio.opened(name);
        const settle = async () => {
            const title = this.studio.sessions.find((s) => s.name === name)?.title || "Untitled";
            await this.studio.forkAs(name, `${title} (this device)`);
            await this.studio.moveTo(name, remoteHead);
        };
        // held, it's refused (SessionBusy) before the fork while a turn
        // runs, so a refusal leaves no copy behind, and no turn starts
        // until it has moved
        await (session === undefined ? settle() : session.hold(settle));
        await this.syncNow(name);
    }

    /**
     * Settle a diverged session on this device's version: the synced
     * head is merged in, this side taking every key either changed, and
     * this device's commit is checked out on top, exactly. The session
     * then descends from the synced head, so the push is a fast-forward
     * and the other device's work stays in the history.
     *
     * @param {string} name
     */
    async keepMine(name) {
        const remoteHead = await this.#remoteHead(name);
        const store = await openStore();
        const session = this.studio.opened(name);
        const settle = async () => {
            // read once held: a turn's commits since are this device's too
            const mine = await store.repo.branches.get(name);
            const ws = session?.ws ?? (await store.open(name));
            try {
                await ws.exclusive(async () => {
                    const wt = await store.repo.worktree(name);
                    await wt.merge({ commit: remoteHead }, {
                        defaultMerge: MergeChoice.OURS,
                        fastForward: false,
                        info: { tool: "studio.sync", kept: "this device" },
                    });
                });
                await ws.refresh();
                await ws.checkout(mine);
            } finally {
                if (session === undefined) await ws.close();
            }
            await session?.reload();
        };
        // held, so no turn runs beside the merge and the checkout
        await (session === undefined ? settle() : session.hold(settle));
        await this.syncNow(name);
    }

    /** Push a session the repo lost (archived or deleted elsewhere) as a
     *  new one. @param {string} name */
    async syncAgain(name) {
        const kv = (await openStore()).repo.store;
        await clearSyncHead(kv, name);
        // its app data is pushed again with it
        await clearSyncHead(kv, appBranch(name));
        await this.syncNow(name);
    }

    /** Move a session to the repo's trash, and remove it here.
     *  @param {string} name */
    async deleteEverywhere(name) {
        const remote = await this.#remoteNow();
        const roster = await remote.roster();
        const app = appBranch(name);
        const has = roster.some((r) => r.branch === name && !r.archived);
        const hasApp = roster.some((r) => r.branch === app && !r.archived);
        // the trash holds one of each name: an earlier copy there blocks this one
        if ((has && roster.some((r) => r.branch === name && r.archived)) || (hasApp && roster.some((r) => r.branch === app && r.archived))) {
            throw new Error("an earlier copy of this session is in the sync repo's trash: empty the trash, then delete again");
        }
        // its app data first, so a failure changes nothing; then the session,
        // whose failure puts the app data back. A session the repo no longer
        // holds (gone elsewhere since) is only removed here.
        if (hasApp && !(await remote.archiveBranch(app))) {
            throw new Error("the session's app data changed in the sync repo meanwhile; sync, then delete again");
        }
        if (has && !(await remote.archiveBranch(name))) {
            if (hasApp) await remote.restoreBranch(app).catch(() => false);
            throw new Error("the session changed in the sync repo meanwhile; sync, then delete again");
        }
        await this.studio.remove(name);
        await this.sweep({ force: true });
    }

    /** Bring a session back from the trash, here and in the repo.
     *  @param {string} name */
    async restore(name) {
        const remote = await this.#remoteNow();
        if (!(await remote.restoreBranch(name))) throw new Error("it couldn't be restored: is a session of that name back already?");
        await remote.restoreBranch(appBranch(name)).catch(() => false);
        await clearSyncHead((await openStore()).repo.store, name);
        await clearSyncHead((await openStore()).repo.store, appBranch(name));
        // out of the trash now, whatever the download does: a failed one
        // leaves it among the cloud sessions, to retry
        const shown = this.trash.find((t) => t.name === name) ?? { name, title: "", updatedAt: Date.now() };
        this.trash = this.trash.filter((t) => t.name !== name);
        if (!this.cloud.some((c) => c.name === name)) this.cloud = [shown, ...this.cloud];
        await this.download(name);
    }

    /** Delete every session in the repo's trash for good. */
    async emptyTrash() {
        const remote = await this.#remoteNow();
        await remote.emptyTrash();
        this.trash = [];
    }

    /** Whether the repo holds session `name`, as last seen (what
     *  "delete" asks about). @param {string} name */
    synced(name) {
        return this.connected && this.status[name]?.held === true;
    }

    /** @param {string} name */
    async #remoteHead(name) {
        const remote = await this.#remoteNow();
        const ref = (await remote.listRefs()).find((r) => r.branch === name);
        if (ref === undefined) throw new Error("the session isn't in the sync repo any more");
        return ref.head;
    }

    /** Forget this device's link to the repo (the repo is untouched). */
    disconnect() {
        for (const t of this.#timers.values()) clearTimeout(t);
        this.#timers.clear();
        for (const t of this.#appTimers.values()) clearTimeout(t);
        this.#appTimers.clear();
        this.status = {};
        this.cloud = [];
        this.trash = [];
        this.problem = null;
        this.#remote = null;
    }
}

/** This page's sync: a session that changed here is pushed. */
export const sync = new Sync(studio);
studio.onChanged = (name) => sync.schedule(name);
