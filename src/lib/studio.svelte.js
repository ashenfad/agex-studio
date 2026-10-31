/**
 * The studio's sessions: the list of them, the ones this page has open,
 * and the one the person is looking at. Each is a branch of the store
 * (`store.js`), opened as a `ChatSession` (`session.svelte.js`).
 */

import { SvelteMap } from "svelte/reactivity";
import { appDbs } from "./app-db-clients.js";
import { appAgent } from "./app-tasks.svelte.js";
import { copy as copyAppStorage, remove as removeAppStorage } from "./app-storage.js";
import { readLocal, writeLocal } from "./local.js";
import { PROFILE, profileFor } from "./profile.js";
import { ChatSession } from "./session.svelte.js";
import { snapshotBranch } from "./snapshot.js";
import { onScreen } from "./status.js";
import { PLANE, metaOf, newName, openStore, settleFork } from "./store.js";
import { forgetLiveVariables } from "./variables.js";
import { appKeyOf, vault } from "./vault.svelte.js";
import { browserExtension } from "./browser-extension.svelte.js";
import { watchSites } from "./site-sync.js";
import { browser } from "./browser.js";
import { SharedTabs } from "./shared-tabs.svelte.js";

/** @typedef {import("@agex-ts/world").Workspace} Workspace */
/** @typedef {import("./store.js").SessionInfo} SessionInfo */
/** @typedef {import("./store.js").SessionSource} SessionSource */

/** Where the session last looked at is remembered. */
const CURRENT_KEY = "agex-studio-current";

/**
 * A fork of session `from`, made by `make` under a new name, sharing
 * `from`'s app database, or with `ownDb`, taking a copy of it of its
 * own (see `app-db-clients.js`). The fork names it before it exists, so
 * no tab can open the fork's app first and name a database of its own.
 * A fork not made (`make` gives null) drops the entry again, and the
 * copy made for it; one that failed partway may exist, so keeps both.
 *
 * @template T
 * @param {string} from @param {(name: string) => Promise<T | null>} make
 * @param {{ ownDb?: boolean }} [options]
 * @returns {Promise<T | null>}
 */
async function forkSharing(from, make, { ownDb = false } = {}) {
    const name = newName();
    let copied = false;
    // with nothing to copy, the fork names a database of its own on first use
    if (ownDb) copied = await appDbs.copyTo(from, name);
    else await appDbs.share(from, name);
    const made = await make(name);
    if (made === null) await appDbs.forget(name, { drop: copied });
    return made;
}

/** The sessions, and the one being looked at. */
export class Studio {
    /** @type {SessionInfo[]} */
    sessions = $state([]);
    /** @type {ChatSession | null} */
    current = $state(null);
    /** Sessions opened in this page, each kept open once opened, so a
     *  turn goes on while another session is looked at. Reactive, so
     *  what reads every open session's status follows new ones. */
    /** @type {SvelteMap<string, ChatSession>} */
    #open = new SvelteMap();
    /** The agents' sites, kept given to the browser extension.
     *  @type {ReturnType<typeof watchSites> | null} */
    #sites = null;
    /** Tabs the person shares from the extension's toolbar, waiting for a
     *  session: one given to a session opens it, and its agent is told. */
    shares = new SharedTabs({
        browser,
        tell: async (name) => {
            await this.#sites?.tell(name);
        },
        given: async (name) => {
            await this.switchTo(name);
            const session = this.#open.get(name);
            if (session !== undefined) await this.shares.remind(name, session.inbox);
        },
    });
    /** @type {(() => void) | null} */
    #watchingShares = null;

    /** Open the store, list the sessions, and open the one last looked
     *  at; with none, a new one, unless `empty` (a published session is
     *  about to open, and is the first). */
    async init({ empty = false } = {}) {
        await this.refresh();
        // the agents' sites, kept given to the browser extension
        this.#sites ??= watchSites({ vault, extension: browserExtension, titleOf: (name) => this.sessions.find((s) => s.name === name)?.title || "Your agent" });
        // and the tabs the person shares from its toolbar, taken as they come
        this.#watchingShares ??= this.#watchShares();
        const last = readLocal(CURRENT_KEY);
        const target = this.sessions.find((s) => s.name === last) ?? this.sessions[0];
        if (target) await this.switchTo(target.name);
        else if (!empty) await this.create();
    }

    /** The sessions the person made, newest first: a delegate's or a
     *  task's branch (a dotted name) isn't one. */
    async refresh() {
        const store = await openStore();
        const names = (await store.sessions()).filter((n) => !n.includes("."));
        const infos = await Promise.all(
            names.map(async (name) => {
                const view = await store.resolve(name);
                try {
                    return await metaOf(view);
                } finally {
                    await view.close();
                }
            }),
        );
        this.sessions = infos.sort((a, b) => b.updatedAt - a.updatedAt);
        // a renamed session's tab group follows
        this.#sites?.sync();
    }

    /** Shares from the toolbar taken as they come, and the open sessions
     *  reminded of the tabs shared with them each time the extension's
     *  port opens. Returns the stopping. */
    #watchShares() {
        const stopWatch = this.shares.watch(browserExtension);
        const stopRemind = browserExtension.onOpen(() => {
            for (const s of this.openSessions()) void this.shares.remind(s.name, s.inbox);
        });
        return () => {
            stopWatch();
            stopRemind();
        };
    }

    /** Called with a session's name when its content changed here (a
     *  turn, an undo, a rename, files added): sync pushes it. */
    /** @type {(name: string) => void} */
    onChanged = () => {};

    /** @param {ChatSession} session */
    #watch(session) {
        session.onMeta = () => {
            void this.refresh();
            this.onChanged(session.name);
        };
        // a share's note that reached the model is told; one that didn't is put again when it opens
        session.onNotes = (notes) => this.shares.delivered(session.name, notes);
        this.#open.set(session.name, session);
        return session;
    }

    /** Whether work would be lost by leaving the page: a turn running,
     *  or a delegate (both run in the page). */
    working() {
        for (const s of this.#open.values()) {
            if (s.busy || s.folding || s.jobs.some((j) => j.status === "running")) return true;
        }
        return false;
    }

    /** Who session `name`'s app is to the vault's grants (see
     *  `appKeyOf`), as the list knows it. @param {string} name */
    appKey(name) {
        return appKeyOf(this.sessions.find((s) => s.name === name) ?? { name });
    }

    /** A fork's app starts as its parent's (its saved data, and its
     *  grants to the vault's keys), and its agent with its parent's
     *  agent's grants. @param {string} from @param {string} to */
    #copyApp(from, to) {
        copyAppStorage(from, to);
        vault.copyGrants(this.appKey(from), appKeyOf({ name: to }));
        vault.copyAgentGrants(from, to);
    }

    /** The session `name`, if this page has it open. @param {string} name */
    opened(name) {
        return this.#open.get(name);
    }

    /** The person's sessions open in this page (not delegates'). */
    openSessions() {
        return [...this.#open.values()].filter((s) => !s.readonly);
    }

    /** The page came back on screen: the session shown is seen. */
    backOnScreen() {
        if (onScreen()) this.current?.seen();
    }

    /**
     * Point session `name` at `commit`, which needn't descend from where
     * it is (a sync's resolution): its workspace, if open, is closed and
     * opened again there.
     *
     * @param {string} name @param {string} commit
     */
    async moveTo(name, commit) {
        const session = this.#open.get(name);
        if (session?.busy || session?.folding) throw new Error("a turn is running in that session; stop it first");
        await session?.close();
        const repo = (await openStore()).repo;
        await repo.branches.delete(name);
        await repo.branches.create(name, commit);
        if (session !== undefined) {
            session.redoHead = null;
            await session.open();
        }
        await this.refresh();
    }

    /**
     * A full fork of session `name`, open or not, titled `title`; its
     * name. Not looked at.
     *
     * @param {string} name @param {string} title
     */
    async forkAs(name, title) {
        const child = /** @type {Workspace} */ (await forkSharing(name, (as) => this.withWorkspace(name, (ws) => ws.fork(as, { inherit: "full" }))));
        const now = Date.now();
        await settleFork(child, { title, createdAt: now, updatedAt: now }, undefined, "studio.fork");
        this.#copyApp(name, child.session);
        await child.close();
        await this.refresh();
        return child.session;
    }

    /**
     * `fn` on session `name`'s workspace: the one open here, else one
     * opened for it and closed after.
     *
     * @template T
     * @param {string} name @param {(ws: Workspace) => Promise<T>} fn
     */
    async withWorkspace(name, fn) {
        const open = this.#open.get(name)?.ws ?? null;
        const ws = open ?? (await (await openStore()).open(name, { profile: profileFor(name) }));
        try {
            return await fn(ws);
        } finally {
            if (open === null) await ws.close();
        }
    }

    /** @param {string} name */
    async switchTo(name) {
        let session = this.#open.get(name);
        if (session === undefined) {
            session = this.#watch(new ChatSession(name, this));
            await session.open();
            if (!session.readonly) void this.shares.remind(name, session.inbox);
        }
        this.current = session;
        if (onScreen()) session.seen();
        writeLocal(CURRENT_KEY, name);
    }

    /** A new, empty session, looked at. */
    async create() {
        const store = await openStore();
        const name = newName();
        const ws = await store.open(name, { profile: profileFor(name) });
        const now = Date.now();
        ws.plane(PLANE).set("meta", { title: "", createdAt: now, updatedAt: now });
        await ws.autoCommit({ tool: "studio.create" });
        const session = this.#watch(new ChatSession(ws.session, this));
        await session.open(ws);
        await this.refresh();
        await this.switchTo(session.name);
    }

    /**
     * Fork the session being looked at: `full` carries its conversation,
     * `fresh` only its files, `compact` everything as it is now without
     * the history behind it (much smaller; its earlier turns can't be
     * undone). The fork is looked at next.
     *
     * With `ownDb`, the fork takes a copy of the app's database of its
     * own, rather than sharing it.
     *
     * @param {"full" | "fresh" | "compact"} inherit
     * @param {{ ownDb?: boolean }} [options]
     */
    async fork(inherit, { ownDb = false } = {}) {
        const from = this.current;
        if (from === null) return;
        if (inherit === "compact") {
            const store = await openStore();
            const snap = `${from.name}.snapshot-${Math.random().toString(36).slice(2, 8)}`;
            const name = await forkSharing(from.name, async (as) => {
                const made = await from.edit(async (ws) => {
                    if (ws.uncommitted) await ws.commit({ tool: "studio.fork" });
                    await snapshotBranch(store, ws.head, snap, { session: from.name });
                    return true;
                });
                return made === null ? null : this.adopt(snap, { title: `${from.title || "Untitled"} (compact)` }, as);
            }, { ownDb });
            if (name === null) return;
            this.#copyApp(from.name, name);
            await this.switchTo(name);
            return;
        }
        const child = await forkSharing(from.name, (as) => from.edit((ws) => ws.fork(as, { inherit })), { ownDb });
        if (child === null) return;
        const now = Date.now();
        const base = from.title || "Untitled";
        // a fork of an imported session isn't that import, nor what it published
        await settleFork(child, { title: inherit === "full" ? `${base} (fork)` : `${base} (files)`, createdAt: now, updatedAt: now }, undefined, "studio.fork");
        // the app's saved data and grants go with its files, on either kind of fork
        this.#copyApp(from.name, child.session);
        // opened again with its own profile: a fork opens with its parent's
        await child.close();
        const session = this.#watch(new ChatSession(child.session, this));
        await session.open();
        await this.refresh();
        await this.switchTo(session.name);
    }

    /**
     * A new session made from branch `branch` (a bundle's commits, or a
     * snapshot): a full fork of it, so the conversation is the new
     * session's own, with `meta` its record, named `name`. `branch` goes.
     * Its name.
     *
     * @param {string} branch @param {Record<string, unknown>} meta
     * @param {string} [name]
     */
    async adopt(branch, meta, name = newName()) {
        const store = await openStore();
        const from = await store.open(branch, { profile: PROFILE });
        /** @type {Workspace} */
        let child;
        try {
            child = await from.fork(name, { inherit: "full" });
        } finally {
            await from.close();
            await store.repo.branches.delete(branch);
        }
        const now = Date.now();
        const { source, ...rest } = meta;
        // a snapshot or bundle carries the source session's own record
        await settleFork(child, { title: "", createdAt: now, updatedAt: now, ...rest }, /** @type {SessionSource | undefined} */ (source), "studio.adopt");
        // opened again with its own profile: a fork opens with its parent's
        await child.close();
        const session = this.#watch(new ChatSession(child.session, this));
        await session.open();
        await this.refresh();
        return child.session;
    }

    /** Delete session `name` for good. @param {string} name */
    /**
     * @param {string} name
     * @param {{ keepDb?: boolean }} [options] `keepDb`: the session stays
     *   in the sync repo (on other devices, or in its trash), so its
     *   database's registry entry stays, for it to come back to
     */
    async remove(name, { keepDb = false } = {}) {
        const session = this.#open.get(name);
        if (session?.busy || session?.folding) throw new Error("a turn is running in that session; stop it first");
        await session?.close();
        this.#open.delete(name);
        const appKey = this.appKey(name);
        const store = await openStore();
        await store.delete(name);
        removeAppStorage(name);
        appAgent.forget(name);
        // its app data's branch (see app-data.js) goes with it
        const appData = `appdata/${name}`;
        if (await store.repo.branches.has(appData)) await store.repo.branches.delete(appData);
        // its app database's entry goes, unless the session lives on
        // elsewhere; the database stays while another session names it,
        // and for a sweep after
        if (keepDb) await appDbs.release(name);
        else await appDbs.forget(name);
        await this.refresh();
        // its grants go, unless another session is the same app (another
        // copy of one gist, say); its agent's go with it
        if (!this.sessions.some((s) => appKeyOf(s) === appKey)) vault.forgetApp(appKey);
        vault.forgetAgent(name);
        forgetLiveVariables(name);
        if (this.current?.name === name) {
            this.current = null;
            const next = this.sessions[0];
            if (next) await this.switchTo(next.name);
            else await this.create();
        }
    }
}

/** The studio this page runs. */
export const studio = new Studio();
