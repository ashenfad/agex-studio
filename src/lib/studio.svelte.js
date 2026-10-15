/**
 * The studio's sessions: the list of them, the ones this page has open,
 * and the one the person is looking at. Each is a branch of the store
 * (`store.js`), opened as a `ChatSession` (`session.svelte.js`).
 */

import { SvelteMap } from "svelte/reactivity";
import { copy as copyAppStorage, remove as removeAppStorage } from "./app-storage.js";
import { PROFILE } from "./profile.js";
import { ChatSession } from "./session.svelte.js";
import { snapshotBranch } from "./snapshot.js";
import { onScreen } from "./status.js";
import { PLANE, metaOf, newName, openStore, settleFork } from "./store.js";

/** @typedef {import("@agex-ts/world").Workspace} Workspace */
/** @typedef {import("./store.js").SessionInfo} SessionInfo */
/** @typedef {import("./store.js").SessionSource} SessionSource */

/** Where the session last looked at is remembered. */
const CURRENT_KEY = "agex-studio-current";

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

    /** Open the store, list the sessions, and open the one last looked
     *  at; with none, a new one, unless `empty` (a published session is
     *  about to open, and is the first). */
    async init({ empty = false } = {}) {
        await this.refresh();
        let last = null;
        try {
            last = localStorage.getItem(CURRENT_KEY);
        } catch {
            // no storage: start from the newest
        }
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
        const child = await this.withWorkspace(name, (ws) => ws.fork(newName(), { inherit: "full" }));
        const now = Date.now();
        await settleFork(child, { title, createdAt: now, updatedAt: now }, undefined, "studio.fork");
        copyAppStorage("ts", name, child.session);
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
        const ws = open ?? (await (await openStore()).open(name, { profile: PROFILE }));
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
        }
        this.current = session;
        if (onScreen()) session.seen();
        try {
            localStorage.setItem(CURRENT_KEY, name);
        } catch {
            // remembered for this page only
        }
    }

    /** A new, empty session, looked at. */
    async create() {
        const store = await openStore();
        const ws = await store.open(newName(), { profile: PROFILE });
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
     * @param {"full" | "fresh" | "compact"} inherit
     */
    async fork(inherit) {
        const from = this.current;
        if (from?.ws == null || from.busy) return;
        if (inherit === "compact") {
            const store = await openStore();
            if (from.ws.uncommitted) await from.ws.commit({ tool: "studio.fork" });
            const snap = `${from.name}.snapshot-${Math.random().toString(36).slice(2, 8)}`;
            await snapshotBranch(store, from.ws.head, snap, { session: from.name });
            const name = await this.adopt(snap, { title: `${from.title || "Untitled"} (compact)` });
            copyAppStorage("ts", from.name, name);
            await this.switchTo(name);
            return;
        }
        const child = await from.ws.fork(newName(), { inherit });
        const now = Date.now();
        const base = from.title || "Untitled";
        // a fork of an imported session isn't that import, nor what it published
        await settleFork(child, { title: inherit === "full" ? `${base} (fork)` : `${base} (files)`, createdAt: now, updatedAt: now }, undefined, "studio.fork");
        // the app's saved data goes with its files, on either kind of fork
        copyAppStorage("ts", from.name, child.session);
        const session = this.#watch(new ChatSession(child.session, this));
        await session.open(child);
        await this.refresh();
        await this.switchTo(session.name);
    }

    /**
     * A new session made from branch `branch` (a bundle's commits, or a
     * snapshot): a full fork of it, so the conversation is the new
     * session's own, with `meta` its record. `branch` goes. Its name.
     *
     * @param {string} branch @param {Record<string, unknown>} meta
     */
    async adopt(branch, meta) {
        const store = await openStore();
        const from = await store.open(branch, { profile: PROFILE });
        /** @type {Workspace} */
        let child;
        try {
            child = await from.fork(newName(), { inherit: "full" });
        } finally {
            await from.close();
            await store.repo.branches.delete(branch);
        }
        const now = Date.now();
        const { source, ...rest } = meta;
        // a snapshot or bundle carries the source session's own record
        await settleFork(child, { title: "", createdAt: now, updatedAt: now, ...rest }, /** @type {SessionSource | undefined} */ (source), "studio.adopt");
        const session = this.#watch(new ChatSession(child.session, this));
        await session.open(child);
        await this.refresh();
        return child.session;
    }

    /** Delete session `name` for good. @param {string} name */
    async remove(name) {
        const session = this.#open.get(name);
        if (session?.busy || session?.folding) throw new Error("a turn is running in that session; stop it first");
        await session?.close();
        this.#open.delete(name);
        const store = await openStore();
        await store.delete(name);
        removeAppStorage("ts", name);
        // its app data's branch (see app-data.js) goes with it
        const appData = `appdata/${name}`;
        if (await store.repo.branches.has(appData)) await store.repo.branches.delete(appData);
        await this.refresh();
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
