/**
 * The studio's runtime: the world's store on IndexedDB, its sessions,
 * and the session the person is looking at, each turn an agex-ts turn
 * over its workspace.
 *
 * A session is a branch of the store. What the studio keeps of its own
 * goes on the session's `studio` plane, so it rewinds with a checkout
 * and comes along on a fork: `meta` (title, when it was made and last
 * used) and `turns/<runId>` (the head a turn started from, which is
 * what undoing that turn checks out).
 *
 * The chat renders the stored runs (agex-ts's record) and, while a turn
 * runs, the `TurnEvent`s it streams; when the turn ends the record is
 * read again and the live view dropped.
 */

import { IndexedDB } from "@agex-ts/kvgit/backends/idb";
import { Inbox, Policy, Store, commandFactory } from "@agex-ts/world";
import workerUrl from "@agex-ts/world/worker?worker&url";
import { Agent, ScriptedProvider } from "agex-ts";
import { runEsbuildCommand } from "./esbuild-terminal.js";
import { buildModel, thinkingOf } from "./model.js";
import interactiveApp from "./skills/interactive-app.md?raw";
import media from "./skills/media.md?raw";
import { mediaHost } from "./media.js";
import { pdfHost } from "./pdf.js";
import { webHost } from "./web.js";
import { writeFile } from "./ws-paths.js";
import { testAppTool } from "./test-app.js";
import { copy as copyAppStorage, remove as removeAppStorage } from "./app-storage.js";
import { applyBundle, bundleFileName, encodeBundle, readBundleHeader } from "./bundle.js";
import { fetchGistBundle, latestRevision, parseGistParam, publishGist, slugOf } from "./gist.js";
import { primer } from "./primer.js";
import { snapshotBranch } from "./snapshot.js";
import { getSettings } from "./settings.js";

/** @typedef {import("agex-ts").Run} Run */
/** @typedef {import("@agex-ts/world").TurnEvent} TurnEvent */
/** @typedef {import("@agex-ts/world").Workspace} Workspace */
/** @typedef {import("@agex-ts/world").Fold} Fold */

/** `esbuild`, a terminal command: bundles JSX/TSX under app/ (and
 *  helpers/) for the preview. esbuild-wasm loads on its first use. */
const esbuild = commandFactory(
    () => async (ctx) => {
        await runEsbuildCommand(ctx, async (args) => (await import("./esbuild-bridge.js")).runEsbuild(args));
    },
    { description: "esbuild <entry> --outfile=<out>: bundle JSX/TSX under app/ into a module the preview loads (esbuild --help)" },
);

/**
 * What every world the studio opens is given: code runs in the world's
 * worker, bundled by Vite; a bare import loads from esm.sh; what code
 * puts in `ui` is written under /workspace/ui to show in the reply; the
 * studio's host objects (`web`, `media`, `pdf`); `esbuild` in the
 * terminal; and the studio's skills, mounted read-only under
 * /workspace/skills.
 */
export const PROFILE = {
    code: {
        worker: { target: /** @type {const} */ ("browser"), url: workerUrl },
        /** @param {string} name */
        resolve: (name) => `https://esm.sh/${name}`,
        // `ui.chart = spec`: shown in the reply
        ui: true,
    },
    hostObjects: { web: webHost(), media: mediaHost(), pdf: pdfHost() },
    commands: { esbuild },
    skills: [interactiveApp, media],
};

/** The IndexedDB database every session lives in. */
export const DB_NAME = "agex-studio";

/** The plane the studio keeps its own records on. */
export const PLANE = "studio";

/** Where the session last looked at is remembered. */
const CURRENT_KEY = "agex-studio-current";

/** @type {Promise<Store> | null} */
let opening = null;

/** The store, opened once. */
export function openStore() {
    opening ??= IndexedDB.open({ dbName: DB_NAME }).then((kv) => Store.open(kv));
    return opening;
}

/**
 * A session as the list shows it. `source` says where an imported one
 * came from (the head of the bundle it was made from), so opening the
 * same bundle again finds it: kept on the plane apart from `meta`,
 * which a turn and a rename rewrite.
 * @typedef {{ name: string, title: string, createdAt: number, updatedAt: number, source?: SessionSource }} SessionInfo
 * @typedef {{ head: string, gist?: import("./gist.js").GistRef & { pinned: boolean } }} SessionSource
 */

/** A new session's name: a session id, never a delegate's (no dot). */
function newName() {
    return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** @param {Workspace} ws */
async function metaOf(ws) {
    const plane = ws.plane(PLANE);
    const meta = /** @type {Partial<SessionInfo> | null} */ (await plane.get("meta"));
    const source = /** @type {SessionInfo["source"] | null} */ (await plane.get("source"));
    return {
        name: ws.session,
        title: meta?.title ?? "",
        createdAt: meta?.createdAt ?? 0,
        updatedAt: meta?.updatedAt ?? meta?.createdAt ?? 0,
        ...(source && { source }),
    };
}

/**
 * A turn's live view: its parts in the order they streamed, a text or
 * a thinking part growing as its deltas arrive, and each tool call with
 * its result once it ends.
 *
 * @typedef {(
 *   | { kind: "text", text: string }
 *   | { kind: "thinking", text: string }
 *   | { kind: "tool", callId: string, name: string, args: Record<string, unknown>,
 *       result: string | null, isError: boolean }
 *   | { kind: "notes", texts: string[] }
 *   | { kind: "folded", summary: string }
 * )} LivePart
 */

/** The scripted model's steps, in dev builds: set by the driver. */
/** @type {import("@agex-ts/world/conformance").ModelStep[]} */
export const script = [];

/** The scripted model's reply once its script is spent.
 *  @type {import("@agex-ts/world/conformance").ModelStep} */
const RAN_OUT = { kind: "model", text: "(the script ran out)", thinking: "", tool_calls: [], fail: "", input_tokens: 0 };

/** One session, as the chat shows it. */
export class ChatSession {
    /** @type {string} */
    name;
    title = $state("");
    /** When the session was made: kept so a turn's metadata is written
     *  at once, within the turn. */
    createdAt = 0;
    /** @type {Run[]} */
    runs = $state([]);
    /** @type {Fold[]} */
    folds = $state([]);
    /** @type {LivePart[]} */
    live = $state([]);
    busy = $state(false);
    /** The prompt of the turn running now. */
    prompt = $state("");
    /** @type {string | null} */
    error = $state(null);
    /** The head an undo left behind, which redo checks out again. */
    /** @type {string | null} */
    redoHead = $state(null);
    /** @type {string[]} */
    files = $state([]);
    /** Bumped whenever the app under app/ may have changed (a tool call
     *  that wrote, an undo, a reload), so the preview looks again. */
    appStamp = $state(0);
    /** Bumped whenever the record is read again (a turn's end, an
     *  undo), so the artifacts a reply shows are read again too. */
    filesStamp = $state(0);
    /** The inbox outlives each turn's agent: a note queued mid-turn
     *  rides the next tool result. */
    inbox = new Inbox();
    /** @type {Workspace | null} */
    ws = null;
    /** @type {import("agex-ts").Session | null} */
    #turn = null;
    /** @type {Promise<unknown> | null} */
    #running = null;
    /** Called when the session's metadata changes. */
    /** @type {() => void} */
    onMeta = () => {};

    /** @param {string} name */
    constructor(name) {
        this.name = name;
    }

    /** Open the session's workspace (or take one already open) and read
     *  its record.
     *  @param {Workspace} [ws] */
    async open(ws) {
        this.ws = ws ?? (await (await openStore()).open(this.name, { profile: PROFILE }));
        await this.reload();
    }

    /** Whether the last turn was cut short by a provider error, so it
     *  can be resumed. */
    get interrupted() {
        return this.runs.at(-1)?.status === "interrupted";
    }

    /** Read the record, the folds, the files and the title again. */
    async reload() {
        const ws = this.ws;
        if (ws === null) return;
        const reader = new Agent({ model: new ScriptedProvider([]) }).session(ws);
        this.runs = await reader.runs();
        this.folds = await ws.compaction.folds();
        const meta = await metaOf(ws);
        this.title = meta.title;
        this.createdAt = meta.createdAt;
        await this.refreshFiles();
        this.appStamp += 1;
        this.filesStamp += 1;
    }

    async refreshFiles() {
        if (this.ws === null) return;
        // the skills mounted under skills/ are the studio's, not the session's work
        const all = await this.ws.files.list("/workspace", { recursive: true }).catch(() => []);
        this.files = all.filter((p) => p !== "skills" && !p.startsWith("skills/"));
    }

    /** The agent for the next turn: a new one each time, since an agent
     *  holds nothing and the settings may have changed. */
    #agent() {
        const s = getSettings();
        const model =
            s.accessMode === "scripted" && import.meta.env.DEV
                ? new ScriptedProvider(() => script.shift() ?? RAN_OUT)
                : buildModel(s, { session: this.name });
        return new Agent({
            model,
            primer: primer(s),
            settings: { thinking: thinkingOf(s), maxTokens: 16000 },
            compaction: s.foldBudget > 0 ? new Policy(s.foldBudget) : null,
        });
    }

    /** An agex-ts session over `ws` for the next turn: the world's tools,
     *  `test_app`, and the inbox that outlives each agent.
     *  @param {Workspace} ws */
    #session(ws) {
        return this.#agent().session(ws, {
            inbox: this.inbox,
            tools: [testAppTool(this)],
            toolOptions: { vision: getSettings().vision },
        });
    }

    /**
     * Run a turn on `prompt`; resolves when it has ended and the record
     * is read back. A turn already running gets `prompt` as a note.
     *
     * @param {string} prompt
     */
    async say(prompt) {
        if (this.ws === null) throw new Error("the session isn't open");
        if (this.busy) {
            this.inbox.put(prompt);
            return;
        }
        await this.#held;
        const ws = this.ws;
        if (ws === null) throw new Error("the session isn't open");
        const session = this.#session(ws);
        const startedAt = ws.head;
        await this.#runTurn(session, async (apply) => {
            for await (const event of session.stream(prompt)) {
                if (event.kind === "RunStarted") this.#started(event.runId, startedAt, prompt);
                apply(event);
            }
        }, prompt);
    }

    /** Continue the last turn, which an interruption cut short. */
    async resume() {
        await this.#held;
        if (this.ws === null || this.busy || !this.interrupted) return;
        const session = this.#session(this.ws);
        await this.#runTurn(session, async () => {
            const out = await session.resume();
            if (out.status !== "completed" && out.status !== "cancelled") this.error = `the turn ended ${out.status}${out.message ? `: ${out.message}` : ""}`;
        }, "(resuming)");
    }

    /** End the last turn, which an interruption cut short, as it stands. */
    async abandon() {
        await this.#held;
        if (this.ws === null || this.busy || !this.interrupted) return;
        await this.#agent().session(this.ws).abandon("set aside by the person");
        await this.reload();
    }

    /**
     * @param {import("agex-ts").Session} session
     * @param {(apply: (event: TurnEvent) => void) => Promise<void>} body
     * @param {string} prompt
     */
    async #runTurn(session, body, prompt) {
        this.busy = true;
        this.error = null;
        this.live = [];
        this.prompt = prompt;
        this.redoHead = null;
        this.#turn = session;
        const run = (async () => {
            try {
                await body((event) => this.#apply(event));
            } catch (e) {
                this.error = e instanceof Error ? e.message : String(e);
            } finally {
                this.#turn = null;
                await this.reload();
                this.live = [];
                this.busy = false;
                this.onMeta();
            }
        })();
        this.#running = run;
        await run;
    }

    /** A turn has started: note where it started from (what undoing it
     *  checks out), and the session's title and when it was last used.
     *  Written on the plane, so the turn's own commits carry them.
     *  @param {string} runId @param {string} head @param {string} prompt */
    #started(runId, head, prompt) {
        const plane = this.ws?.plane(PLANE);
        if (plane === undefined) return;
        plane.set(`turns/${runId}`, { before: head });
        const now = Date.now();
        const title = this.title || titleFrom(prompt);
        // at once, so the turn's own commits carry it
        plane.set("meta", { title, createdAt: this.createdAt || now, updatedAt: now });
        this.title = title;
    }

    /**
     * Put files the person brought (uploaded, or from Drive) under
     * /workspace/uploads, replacing any of the same name, as one
     * commit; their paths. Not while a turn runs: its commits would take
     * them in as its own.
     *
     * @param {{ name: string, bytes: Uint8Array }[]} files
     */
    async importFiles(files) {
        await this.#held;
        const ws = this.ws;
        if (ws === null || files.length === 0) return [];
        if (this.busy) throw new Error("a turn is running; add files once it ends");
        // a name is one path segment: no separators, and not . or ..
        const paths = files.map((f) => `${ws.root}/uploads/${f.name.replace(/[/\\]/g, "_").replace(/^\.*$/, (dots) => `${dots}file`)}`);
        await ws.exclusive(async () => {
            for (const [i, f] of files.entries()) await writeFile(ws.files.fs, /** @type {string} */ (paths[i]), f.bytes);
            await ws.autoCommit({ tool: "import", paths });
        });
        this.redoHead = null;
        await this.refreshFiles();
        this.onMeta();
        return paths;
    }

    /** Wait for the turn running now, if any. */
    async settled() {
        await this.#running;
    }

    /** A sync of this session in flight: a turn, and every other change
     *  to the workspace from here (resume, undo, redo, rename, files
     *  added), waits for it. */
    /** @type {Promise<unknown> | null} */
    #held = null;

    /**
     * Run `fn` (a sync of this session) with no turn starting until it
     * ends: `say` waits for it. Called only while no turn runs.
     *
     * @template T
     * @param {() => Promise<T>} fn
     */
    async hold(fn) {
        const run = fn();
        this.#held = run.catch(() => undefined);
        try {
            return await run;
        } finally {
            this.#held = null;
        }
    }

    /** Take in commits a sync pulled onto the branch: what is pending
     *  here commits onto them (merging), or the workspace reads them. */
    async adoptPulled() {
        const ws = this.ws;
        if (ws === null) return;
        if (ws.uncommitted) await ws.commit({ tool: "studio.sync" });
        else await ws.refresh();
        this.redoHead = null;
        await this.reload();
    }

    /** Stop the turn running now. */
    cancel() {
        this.#turn?.cancel("stopped by the person");
    }

    /**
     * Undo run `runId` and everything after it: the workspace, the
     * conversation and the folds go back to where that turn started.
     * History is kept, so `redo` brings it all back.
     *
     * @param {string} runId
     */
    async undo(runId) {
        await this.#held;
        if (this.ws === null || this.busy) return;
        const turn = /** @type {{ before?: string } | null} */ (await this.ws.plane(PLANE).get(`turns/${runId}`));
        if (!turn?.before) throw new Error("this turn's starting point isn't recorded, so it can't be undone");
        const head = this.ws.head;
        await this.ws.checkout(turn.before);
        this.redoHead = head;
        await this.reload();
        this.onMeta();
    }

    /** Bring back what the last undo took away. */
    async redo() {
        await this.#held;
        if (this.ws === null || this.busy || this.redoHead === null) return;
        await this.ws.checkout(this.redoHead);
        this.redoHead = null;
        await this.reload();
        this.onMeta();
    }

    /** Give the session a title. @param {string} title */
    async rename(title) {
        await this.#held;
        if (this.ws === null) return;
        const plane = this.ws.plane(PLANE);
        const meta = /** @type {object | null} */ (await plane.get("meta")) ?? {};
        plane.set("meta", { ...meta, title, updatedAt: Date.now() });
        await this.ws.autoCommit({ tool: "studio.rename" });
        this.title = title;
        this.onMeta();
    }

    async close() {
        await this.ws?.close();
        this.ws = null;
    }

    /** @param {TurnEvent} event */
    #apply(event) {
        const last = this.live.at(-1);
        switch (event.kind) {
            case "TextDelta":
            case "ThinkingDelta": {
                const kind = event.kind === "TextDelta" ? "text" : "thinking";
                if (last?.kind === kind) last.text += event.text;
                else this.live.push({ kind, text: event.text });
                break;
            }
            case "ToolStarted":
                this.live.push({ kind: "tool", callId: event.callId, name: event.name, args: { ...event.args }, result: null, isError: false });
                break;
            case "ToolEnded": {
                // a call may have written the app; the preview looks again
                this.appStamp += 1;
                const part = this.live.find((p) => p.kind === "tool" && p.callId === event.callId);
                if (part?.kind === "tool") {
                    part.result = event.result;
                    part.isError = event.isError;
                }
                break;
            }
            case "Delivered":
                this.live.push({ kind: "notes", texts: event.notes.map((n) => n.text) });
                break;
            case "Compacted":
                this.live.push({ kind: "folded", summary: event.summary ?? "" });
                break;
            case "RunEnded":
                // a turn the person stopped isn't an error: its record says so
                if (event.status !== "completed" && event.status !== "cancelled") {
                    this.error = `the turn ended ${event.status}${event.message ? `: ${event.message}` : ""}`;
                }
                break;
            default:
                break;
        }
    }
}

/** A title from a session's first prompt: its first line, cut short.
 *  @param {string} prompt */
export function titleFrom(prompt) {
    const line = prompt.trim().split("\n")[0] ?? "";
    return line.length > 60 ? `${line.slice(0, 57)}…` : line || "Untitled";
}

/** @param {string} key */
function readLocal(key) {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

/** @param {string} key @param {string} value */
function writeLocal(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch {
        // kept for this page only
    }
}

/** The sessions, and the one being looked at. */
export class Studio {
    /** @type {SessionInfo[]} */
    sessions = $state([]);
    /** @type {ChatSession | null} */
    current = $state(null);
    /** Sessions opened in this page, each kept open once opened, so a
     *  turn goes on while another session is looked at. */
    /** @type {Map<string, ChatSession>} */
    #open = new Map();

    /** Open the store, list the sessions, and open the one last looked
     *  at (or a new one). */
    async init() {
        await this.refresh();
        let last = null;
        try {
            last = localStorage.getItem(CURRENT_KEY);
        } catch {
            // no storage: start from the newest
        }
        const target = this.sessions.find((s) => s.name === last) ?? this.sessions[0];
        if (target) await this.switchTo(target.name);
        else await this.create();
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

    /** The session `name`, if this page has it open. @param {string} name */
    opened(name) {
        return this.#open.get(name);
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
        if (session?.busy) throw new Error("a turn is running in that session; stop it first");
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
        const open = this.#open.get(name)?.ws ?? null;
        const ws = open ?? (await (await openStore()).open(name, { profile: PROFILE }));
        try {
            const child = await ws.fork(newName(), { inherit: "full" });
            const now = Date.now();
            child.plane(PLANE).set("meta", { title, createdAt: now, updatedAt: now });
            await child.plane(PLANE).delete("source");
            await child.plane(PLANE).delete("published");
            await child.autoCommit({ tool: "studio.fork" });
            copyAppStorage("ts", name, child.session);
            await child.close();
            await this.refresh();
            return child.session;
        } finally {
            if (open === null) await ws.close();
        }
    }

    /** @param {string} name */
    async switchTo(name) {
        let session = this.#open.get(name);
        if (session === undefined) {
            session = this.#watch(new ChatSession(name));
            await session.open();
        }
        this.current = session;
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
        const session = this.#watch(new ChatSession(ws.session));
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
            const name = await this.#adopt(snap, { title: `${from.title || "Untitled"} (compact)` });
            copyAppStorage("ts", from.name, name);
            await this.switchTo(name);
            return;
        }
        const child = await from.ws.fork(newName(), { inherit });
        const now = Date.now();
        const base = from.title || "Untitled";
        child.plane(PLANE).set("meta", {
            title: inherit === "full" ? `${base} (fork)` : `${base} (files)`,
            createdAt: now,
            updatedAt: now,
        });
        // a fork of an imported session isn't that import, nor what it published
        await child.plane(PLANE).delete("source");
        await child.plane(PLANE).delete("published");
        await child.autoCommit({ tool: "studio.fork" });
        // the app's saved data goes with its files, on either kind of fork
        copyAppStorage("ts", from.name, child.session);
        const session = this.#watch(new ChatSession(child.session));
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
    async #adopt(branch, meta) {
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
        child.plane(PLANE).set("meta", { title: "", createdAt: now, updatedAt: now, ...rest });
        // a snapshot or bundle carries the source session's own record
        if (source !== undefined) child.plane(PLANE).set("source", source);
        else await child.plane(PLANE).delete("source");
        await child.plane(PLANE).delete("published");
        await child.autoCommit({ tool: "studio.adopt" });
        const session = this.#watch(new ChatSession(child.session));
        await session.open(child);
        await this.refresh();
        return child.session;
    }

    /**
     * Open a bundle: a new session from it, looked at; or, when an
     * earlier import of this bundle is here, that one. Its name.
     *
     * @param {Uint8Array} bytes
     * @param {{ gist?: SessionSource["gist"] }} [from] where it came from
     */
    async importBundle(bytes, from = {}) {
        const { header } = readBundleHeader(bytes);
        await this.refresh();
        const known = this.sessions.find((s) => s.source?.head === header.head);
        if (known !== undefined) {
            await this.switchTo(known.name);
            return { name: known.name, existing: true };
        }
        const store = await openStore();
        const branch = `${newName()}.import`;
        await applyBundle(store.repo.store, bytes, branch);
        const name = await this.#adopt(branch, {
            title: header.title || "Imported",
            source: { head: header.head, ...(from.gist && { gist: from.gist }) },
        });
        await this.switchTo(name);
        return { name, existing: false };
    }

    /**
     * Session `name` as a bundle: `everything` (its history) or `current`
     * (as it is now; see `snapshot.js`). What a turn left pending here
     * is committed first.
     *
     * @param {string} name @param {"everything" | "current"} shape
     */
    async exportBundle(name, shape) {
        const store = await openStore();
        const open = this.#open.get(name)?.ws;
        if (open?.uncommitted) await open.commit({ tool: "studio.export" });
        const title = this.sessions.find((s) => s.name === name)?.title || "Untitled";
        const head = await store.repo.branches.get(name);
        const kv = store.repo.store;
        let bytes;
        if (shape === "current") {
            const snap = `${name}.snapshot-${Math.random().toString(36).slice(2, 8)}`;
            try {
                bytes = await encodeBundle(kv, await snapshotBranch(store, head, snap, { session: name }), { title, shape });
            } finally {
                await store.repo.branches.delete(snap).catch(() => undefined);
            }
        } else {
            bytes = await encodeBundle(kv, head, { title, shape });
        }
        return { bytes, fileName: bundleFileName(title) };
    }

    /**
     * Publish session `name` as a gist (see `gist.js`): `shape` as for a
     * bundle; to the gist it was published to before unless `fresh`. The
     * gist is recorded on the session, and the commit published is
     * tagged in the store, `published/<slug>/<version>`. What came of it.
     *
     * @param {string} name
     * @param {{ shape: "everything" | "current", fresh?: boolean }} opts
     */
    async publish(name, { shape, fresh = false }) {
        const s = getSettings();
        const token = s.publishToken.trim() || s.syncToken.trim();
        if (token === "") throw new Error("publishing needs a GitHub token with gist access: add one in settings");
        const prior = fresh ? null : await this.published(name);
        const { bytes } = await this.exportBundle(name, shape);
        const title = this.sessions.find((x) => x.name === name)?.title || "Untitled";
        const gist = await publishGist({ token, title, bytes, existing: prior });
        const store = await openStore();
        const open = this.#open.get(name)?.ws ?? null;
        const ws = open ?? (await store.open(name, { profile: PROFILE }));
        try {
            // the commit published, tagged as this slug's next version
            const prefix = `published/${gist.slug}/`;
            const versions = [...(await store.tags.list()).keys()].filter((t) => t.startsWith(prefix)).length;
            await store.tags.add(ws, `${prefix}${versions + 1}`, {
                info: { gist: { owner: gist.owner, id: gist.id, revision: gist.revision }, shape, session: name, title },
            });
            ws.plane(PLANE).set("published", { owner: gist.owner, id: gist.id, slug: gist.slug, revision: gist.revision, shape, session: name, at: Date.now() });
            await ws.autoCommit({ tool: "studio.publish", gist: gist.id });
        } finally {
            if (open === null) await ws.close();
        }
        this.#open.get(name)?.onMeta();
        return { ...gist, size: bytes.length };
    }

    /**
     * The gist session `name` was published to, if it was, from here
     * or a device it synced from (a fork's record is its parent's, and
     * doesn't count).
     *
     * @param {string} name
     * @returns {Promise<import("./gist.js").GistRef | null>}
     */
    async published(name) {
        const store = await openStore();
        const view = await store.resolve(name);
        try {
            const record = /** @type {any} */ (await view.plane(PLANE).get("published"));
            return record?.session === name ? { owner: record.owner, id: record.id, slug: record.slug, revision: record.revision } : null;
        } finally {
            await view.close();
        }
    }

    /**
     * Open a published session from its `?gist=` value: a new session
     * from the gist's bundle, looked at, or the one an earlier opening
     * of the same bundle made. Its name.
     *
     * @param {string} param
     */
    async openGist(param) {
        const ref = parseGistParam(param);
        if (ref === null) throw new Error(`"${param}" isn't a link to a published session`);
        const bytes = await fetchGistBundle(ref);
        // the revision opened: where update checks start from
        const revision = ref.revision ?? (await latestRevision(ref.id).catch(() => null)) ?? "";
        return this.importBundle(bytes, { gist: { owner: ref.owner, id: ref.id, slug: ref.slug, revision, pinned: ref.revision !== null } });
    }

    /** Opened gists with a newer revision: session name → revision. */
    /** @type {Record<string, string>} */
    updates = $state({});

    /**
     * Look for newer revisions of the gists sessions were opened from
     * (not those opened at one revision): each gist at most every 12
     * hours unless `force`, and a revision the person dismissed stays
     * dismissed.
     *
     * @param {{ force?: boolean }} [opts]
     */
    async checkUpdates({ force = false } = {}) {
        const s = getSettings();
        const token = s.publishToken.trim() || s.syncToken.trim() || undefined;
        for (const info of this.sessions) {
            const gist = info.source?.gist;
            if (gist === undefined || gist.pinned) continue;
            const key = `agex-gist-checked-${gist.id}`;
            const last = Number(readLocal(key) ?? 0);
            if (!force && Date.now() - last < 12 * 3600 * 1000) continue;
            try {
                const latest = await latestRevision(gist.id, { ...(token && { token }) });
                writeLocal(key, String(Date.now()));
                if (latest !== null && latest !== gist.revision && readLocal(`agex-gist-ignored-${info.name}`) !== latest) {
                    this.updates[info.name] = latest;
                }
            } catch {
                // offline, or rate-limited: the next look tries again
            }
        }
    }

    /**
     * Bring session `name` up to its gist's newer revision: the new one
     * opens as a session; the old one goes if nothing was done in it
     * since it was opened, else it stays beside the new.
     *
     * @param {string} name
     */
    async update(name) {
        const info = this.sessions.find((x) => x.name === name);
        const gist = info?.source?.gist;
        const latest = this.updates[name];
        if (gist === undefined || latest === undefined) return;
        const bytes = await fetchGistBundle({ ...gist, revision: latest });
        const store = await openStore();
        const view = await store.resolve(name);
        const untouched = (await view.log({ limit: 1 }))[0]?.info?.tool === "studio.adopt";
        await view.close();
        delete this.updates[name];
        await this.importBundle(bytes, { gist: { ...gist, revision: latest } });
        if (untouched && this.current?.name !== name) await this.remove(name);
    }

    /** Don't offer this revision of session `name`'s gist again. @param {string} name */
    dismissUpdate(name) {
        const latest = this.updates[name];
        if (latest !== undefined) writeLocal(`agex-gist-ignored-${name}`, latest);
        delete this.updates[name];
    }

    /** Delete session `name` for good. @param {string} name */
    async remove(name) {
        const session = this.#open.get(name);
        if (session?.busy) throw new Error("a turn is running in that session; stop it first");
        await session?.close();
        this.#open.delete(name);
        const store = await openStore();
        await store.delete(name);
        removeAppStorage("ts", name);
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
