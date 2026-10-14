/**
 * The studio's runtime: the world's store on IndexedDB, and a session
 * the person chats in, each turn an agex-ts turn over its workspace.
 *
 * The chat renders two things and nothing else: the session's stored
 * runs (agex-ts's record, read back with `runs()`), and, while a turn
 * runs, the `TurnEvent`s it streams. When the turn ends, the record is
 * read again and the live view is dropped.
 */

import { IndexedDB } from "@agex-ts/kvgit/backends/idb";
import { Inbox, Store } from "@agex-ts/world";
import workerUrl from "@agex-ts/world/worker?worker&url";
import { Agent, ScriptedProvider } from "agex-ts";
import { buildModel, thinkingOf } from "./model.js";
import { PRIMER } from "./primer.js";
import { getSettings } from "./settings.js";

/** @typedef {import("agex-ts").Run} Run */
/** @typedef {import("agex-ts").Message} Message */
/** @typedef {import("@agex-ts/world").TurnEvent} TurnEvent */
/** @typedef {import("@agex-ts/world").Workspace} Workspace */

/** What every world the studio opens is given: code runs in the
 *  world's worker, bundled by Vite, and a bare import loads from esm.sh. */
export const PROFILE = {
    code: {
        worker: { target: /** @type {const} */ ("browser"), url: workerUrl },
        /** @param {string} name */
        resolve: (name) => `https://esm.sh/${name}`,
    },
};

/** The IndexedDB database every session lives in. */
export const DB_NAME = "agex-studio";

/** @type {Promise<Store> | null} */
let opening = null;

/** The store, opened once. */
export function openStore() {
    opening ??= IndexedDB.open({ dbName: DB_NAME }).then((kv) => Store.open(kv));
    return opening;
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

/** One session, as the chat shows it. */
export class ChatSession {
    /** @type {string} */
    name;
    /** @type {Run[]} */
    runs = $state([]);
    /** @type {LivePart[]} */
    live = $state([]);
    busy = $state(false);
    /** The prompt of the turn running now. */
    prompt = $state("");
    /** @type {string | null} */
    error = $state(null);
    /** The inbox outlives each turn's agent: a note queued mid-turn
     *  rides the next tool result. */
    inbox = new Inbox();
    /** @type {Workspace | null} */
    ws = null;
    /** @type {import("agex-ts").Session | null} */
    #turn = null;
    /** @type {Promise<unknown> | null} */
    #running = null;

    /** @param {string} name */
    constructor(name) {
        this.name = name;
    }

    /** Open the session's workspace and read its record. */
    async open() {
        const store = await openStore();
        this.ws = await store.open(this.name, { profile: PROFILE });
        await this.reload();
    }

    async reload() {
        if (this.ws === null) return;
        const agent = new Agent({ model: new ScriptedProvider([]) });
        this.runs = await agent.session(this.ws).runs();
    }

    /** The agent for the next turn: a new one each time, since an agent
     *  holds nothing and the settings may have changed. */
    #agent() {
        const s = getSettings();
        const model =
            s.accessMode === "scripted" && import.meta.env.DEV
                ? new ScriptedProvider(() => script.shift() ?? { kind: "model", text: "(the script ran out)", thinking: "", tool_calls: [], fail: "", input_tokens: 0 })
                : buildModel(s, { session: this.name });
        return new Agent({
            model,
            primer: PRIMER,
            settings: { thinking: thinkingOf(s), maxTokens: 16000 },
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
        this.busy = true;
        this.error = null;
        this.live = [];
        this.prompt = prompt;
        const session = this.#agent().session(this.ws, { inbox: this.inbox });
        this.#turn = session;
        const run = (async () => {
            try {
                for await (const event of session.stream(prompt)) this.#apply(event);
            } catch (e) {
                this.error = e instanceof Error ? e.message : String(e);
            } finally {
                this.#turn = null;
                await this.reload();
                this.live = [];
                this.busy = false;
            }
        })();
        this.#running = run;
        await run;
    }

    /** Wait for the turn running now, if any. */
    async settled() {
        await this.#running;
    }

    /** Stop the turn running now. */
    cancel() {
        this.#turn?.cancel("stopped by the person");
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
                if (event.status !== "completed") {
                    this.error = `the turn ended ${event.status}${event.message ? `: ${event.message}` : ""}`;
                }
                break;
            default:
                break;
        }
    }
}
