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
import { testAppTool } from "./test-app.js";
import { copy as copyAppStorage, remove as removeAppStorage } from "./app-storage.js";
import { PRIMER } from "./primer.js";
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
 * worker, bundled by Vite; a bare import loads from esm.sh; `esbuild`
 * in the terminal; and the studio's skills, mounted read-only under
 * /workspace/skills.
 */
export const PROFILE = {
    code: {
        worker: { target: /** @type {const} */ ("browser"), url: workerUrl },
        /** @param {string} name */
        resolve: (name) => `https://esm.sh/${name}`,
    },
    commands: { esbuild },
    skills: [interactiveApp],
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
 * A session as the list shows it.
 * @typedef {{ name: string, title: string, createdAt: number, updatedAt: number }} SessionInfo
 */

/** A new session's name: a session id, never a delegate's (no dot). */
function newName() {
    return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** @param {Workspace} ws */
async function metaOf(ws) {
    const meta = /** @type {Partial<SessionInfo> | null} */ (await ws.plane(PLANE).get("meta"));
    return {
        name: ws.session,
        title: meta?.title ?? "",
        createdAt: meta?.createdAt ?? 0,
        updatedAt: meta?.updatedAt ?? meta?.createdAt ?? 0,
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
            primer: PRIMER,
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
        const ws = this.ws;
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
        if (this.ws === null || this.busy || !this.interrupted) return;
        const session = this.#session(this.ws);
        await this.#runTurn(session, async () => {
            const out = await session.resume();
            if (out.status !== "completed" && out.status !== "cancelled") this.error = `the turn ended ${out.status}${out.message ? `: ${out.message}` : ""}`;
        }, "(resuming)");
    }

    /** End the last turn, which an interruption cut short, as it stands. */
    async abandon() {
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

    /** Wait for the turn running now, if any. */
    async settled() {
        await this.#running;
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
        if (this.ws === null || this.busy || this.redoHead === null) return;
        await this.ws.checkout(this.redoHead);
        this.redoHead = null;
        await this.reload();
        this.onMeta();
    }

    /** Give the session a title. @param {string} title */
    async rename(title) {
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

    /** @param {ChatSession} session */
    #watch(session) {
        session.onMeta = () => void this.refresh();
        this.#open.set(session.name, session);
        return session;
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
     * `fresh` only its files. The fork is looked at next.
     *
     * @param {"full" | "fresh"} inherit
     */
    async fork(inherit) {
        const from = this.current;
        if (from?.ws == null || from.busy) return;
        const child = await from.ws.fork(newName(), { inherit });
        const now = Date.now();
        const base = from.title || "Untitled";
        child.plane(PLANE).set("meta", {
            title: inherit === "full" ? `${base} (fork)` : `${base} (files)`,
            createdAt: now,
            updatedAt: now,
        });
        await child.autoCommit({ tool: "studio.fork" });
        // the app's saved data goes with its files, on either kind of fork
        copyAppStorage("ts", from.name, child.session);
        const session = this.#watch(new ChatSession(child.session));
        await session.open(child);
        await this.refresh();
        await this.switchTo(session.name);
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
