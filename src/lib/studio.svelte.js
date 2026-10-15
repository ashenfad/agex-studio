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
import { SvelteMap } from "svelte/reactivity";
import { Inbox, Policy, Sessions, Store, commandFactory, wsGit } from "@agex-ts/world";
import workerUrl from "@agex-ts/world/worker?worker&url";
import { AGEX_GUIDE, Agent, AiSdkProvider, RunStream, ScriptedProvider, agentTasks } from "agex-ts";
import { runEsbuildCommand } from "./esbuild-terminal.js";
import { DELEGATE_TOOL_CALLS, StudioRunner, WAKES, depthOf, openings, renderPublished, studioSessionsTool } from "./delegation.svelte.js";
import { buildModel, thinkingOf } from "./model.js";
import { SKILLS } from "./skills/index.js";
import { mediaHost } from "./media.js";
import { pdfHost } from "./pdf.js";
import { webHost } from "./web.js";
import { writeFile } from "./ws-paths.js";
import { testAppTool } from "./test-app.js";
import { copy as copyAppStorage, remove as removeAppStorage } from "./app-storage.js";
import { applyBundle, bundleFileName, encodeBundle, readBundleHeader } from "./bundle.js";
import { fetchGistBundle, latestRevision, parseGistParam, publishGist, slugOf } from "./gist.js";
import { attachmentsOf } from "./notes.js";
import { primer } from "./primer.js";
import { snapshotBranch } from "./snapshot.js";
import { looking, onScreen } from "./status.js";
import { getSettings, isConfigured } from "./settings.js";
import { generateTitle, personTurns, titleDue, transcriptText } from "./titles.js";

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
 * The model agent-defined tasks run on: whatever the settings say when
 * each request goes, since one agent serves every session's tasks for
 * the page's life and the settings may change meanwhile. A provider
 * built per request from the settings now, its thinking theirs too.
 *
 * @type {import("agex-ts").Provider}
 */
const currentModel = {
    name: "agex-studio:current",
    stream(messages, tools, settings, opts) {
        const s = getSettings();
        return providerNow(s).stream(messages, tools, { ...settings, thinking: thinkingOf(s) }, opts);
    },
    transient(error) {
        return providerNow(getSettings()).transient(error);
    },
    describe(error) {
        const now = /** @type {import("agex-ts").Provider} */ (providerNow(getSettings()));
        return now.describe?.(error) ?? null;
    },
};

/** The provider the settings name now (in dev, possibly the scripted
 *  one the driver fills). @param {import("./settings.js").Settings} s */
function providerNow(s) {
    if (s.accessMode === "scripted" && import.meta.env.DEV) return new ScriptedProvider(() => script.shift() ?? RAN_OUT);
    return new AiSdkProvider(buildModel(s, { session: "agex-tasks" }));
}

/**
 * `agex` in the agent's code: tasks it defines (`agex.task`) and calls,
 * each run by a helper agent on the person's model, in a scratch world
 * of its own (not a delegate: no branch, no strip, no waking).
 */
const agex = agentTasks(new Agent({ model: currentModel, settings: { maxTokens: 16000 } }), { scratch: true });

/** What a turn's tools are told, beside the world's own: whether the
 *  model takes images, and how to use `agex`. */
export function toolOptionsNow() {
    return { vision: getSettings().vision, codePrimer: AGEX_GUIDE };
}

/**
 * What every world the studio opens is given: code runs in the world's
 * worker, bundled by Vite; a bare import loads from esm.sh; what code
 * puts in `ui` is written under /workspace/ui to show in the reply; the
 * studio's host objects (`web`, `media`, `pdf`, and `agex` for tasks the
 * agent's code defines); `esbuild` in the
 * terminal; and the studio's skills (`skills/`: a directory each),
 * mounted read-only under /workspace/skills.
 */
export const PROFILE = {
    code: {
        worker: { target: /** @type {const} */ ("browser"), url: workerUrl },
        /** @param {string} name */
        resolve: (name) => `https://esm.sh/${name}`,
        // `ui.chart = spec`: shown in the reply
        ui: true,
    },
    hostObjects: { web: webHost(), media: mediaHost(), pdf: pdfHost(), agex },
    // ws-git: the agent's own git, which brings a delegate's work back
    commands: { esbuild, "ws-git": wsGit },
    skills: SKILLS,
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
 *   | { kind: "notes", notes: { kind: "principal" | "mechanism", label: string, text: string }[] }
 *   | { kind: "folded", summary: string }
 * )} LivePart
 */

/** The scripted model's steps, in dev builds: set by the driver. */
/** @type {import("@agex-ts/world/conformance").ModelStep[]} */
export const script = [];

/** The scripted model's reply once its script is spent.
 *  @type {import("@agex-ts/world/conformance").ModelStep} */
const RAN_OUT = { kind: "model", text: "(the script ran out)", thinking: "", tool_calls: [], fail: "", input_tokens: 0 };

/** The published apps, for `sessions published`. */
async function publishedNow() {
    return renderPublished(await openStore());
}

/**
 * What a session's delegates run with: its agent (capped as a
 * delegate's), `test_app` and the `sessions` tool at their depth, and
 * the chat session open on one, which follows its turns.
 *
 * @param {ChatSession} owner
 * @returns {import("./delegation.svelte.js").RunnerHost}
 */
function runnerHost(owner) {
    return {
        agent: (opts) => owner.delegateAgent(opts),
        // a delegate tests its own app, seeded with its top session's storage
        tools: (helper, depth, ws) => [
            testAppTool({ ws, name: ws.session.split(".")[0] ?? ws.session, delegate: true }),
            studioSessionsTool(helper, depth, publishedNow),
        ],
        observe: (name) => studio.opened(name),
        toolOptions: toolOptionsNow,
    };
}

/** One session, as the chat shows it. */
export class ChatSession {
    /** @type {string} */
    name;
    title = $state("");
    /** When the session was made: kept so a turn's metadata is written
     *  at once, within the turn. */
    createdAt = 0;
    /** The session's record on the plane as last read or written here,
     *  whole: what a turn's start writes over keeps every field it
     *  doesn't set (`named`, `titledAt`). @type {Record<string, unknown>} */
    #meta = {};
    /** @type {Run[]} */
    runs = $state([]);
    /** @type {Fold[]} */
    folds = $state([]);
    /** @type {LivePart[]} */
    live = $state([]);
    /** What the person is writing, kept while they look elsewhere. */
    draft = $state("");
    /** Files attached to the next message: added under uploads/ already,
     *  named to the agent with it. @type {string[]} */
    attached = $state([]);
    /** Messages written while a turn runs, waiting for the agent's next
     *  tool result. @type {{ id: string, text: string }[]} */
    queued = $state([]);
    busy = $state(false);
    /** The context the next request carries, in tokens, as the fold
     *  policy measures it; during a turn, the latest request's, as the
     *  provider reported it. Null until it's known. @type {number | null} */
    context = $state(null);
    /** A fold the person asked for is being written. */
    folding = $state(false);
    /** A turn ended while the person wasn't looking at the session (see
     *  `status.js`), and they haven't since. This page's only. */
    unseen = $state(false);
    /** One of those turns ended failed or interrupted. */
    attention = $state(false);
    /** That fold, settling when it's done. @type {Promise<void>} */
    #folding = Promise.resolve();
    /** The person stopped that fold: its ending isn't an error. */
    #foldStopped = false;
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
    /** Bumped when another device's app data was taken in here: the
     *  preview offers to reload the app with it. */
    appDataStamp = $state(0);
    /** Bumped whenever the record is read again (a turn's end, an
     *  undo), so the artifacts a reply shows are read again too. */
    filesStamp = $state(0);
    /** The inbox outlives each turn's agent: a note queued mid-turn
     *  rides the next tool result. What opens a woken turn (the answers
     *  that woke it) is told here as it is delivered, and shown as the
     *  live turn's opening. */
    inbox = new Inbox({ onDelivered: (notes) => this.#delivered(notes) });
    /** A woken turn is starting, its opening not yet delivered. */
    #awaitingOpening = false;
    /** The helper this session delegates through, made when it opens,
     *  so its delegates outlive each turn's agent. A delegate's own
     *  session (one with a dot in its name) has none here: its runner
     *  holds it. @type {Sessions | null} */
    helper = null;
    /** Its delegates, as the strip shows them: the helper's job table,
     *  copied when it changes. @type {import("@agex-ts/world").Job[]} */
    jobs = $state([]);
    /** The delegates whose answers this session hasn't read yet (or
     *  still running). @type {string[]} */
    unread = $state([]);
    /** Turns that answers may still start before the person writes
     *  again; a stopped or failed turn stops them until then. */
    wakesLeft = WAKES;
    #wakeOk = true;
    #wakeNoted = false;
    /** When the turn running now started: the delegates it asked are
     *  the ones its stop stops. */
    #turnAt = 0;
    /** How the last turn ended. */
    #lastStatus = "completed";
    /** Something the studio says about the session (answers waiting,
     *  say). @type {string | null} */
    notice = $state(null);
    /** @type {ReturnType<typeof setInterval> | null} */
    #poll = null;
    /** Each run's starting head, by run id (its undo point): where the
     *  run before it ended. @type {Record<string, string>} */
    starts = $state({});
    /** Frozen views of this session at a commit, for replies' artifacts.
     *  @type {Map<string, Promise<Workspace>>} */
    #views = new Map();
    /** Delegates the page lost: it closed while they ran, so they never
     *  answered. Shown in the strip until the next turn, which is told.
     *  @type {string[]} */
    lostDelegates = $state([]);
    /** What the plane last recorded of each delegate (answered and read,
     *  or not). @type {Map<string, boolean>} */
    #recorded = new Map();
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
        if (!this.readonly) {
            const helper = new Sessions(this.ws, new StudioRunner(this.ws, runnerHost(this)));
            helper.onAnswer = () => {
                this.syncJobs();
                void this.#maybeWake();
            };
            this.helper = helper;
        }
        await this.reload();
        if (!this.readonly) await this.#findInterrupted();
        // a delegate opened while it runs: its turn, live from here, opening as
        // it did (unless its runner's events, arriving while this opened, began it)
        else if (openings[this.name] !== undefined && !this.busy) this.begin(openings[this.name] ?? "");
    }

    /**
     * The commit run `i`'s files are read at: where the run after it
     * started, so its artifacts show as it left them; null for the
     * latest run (the files as they are now) or one with no record.
     *
     * @param {number} i
     */
    endOf(i) {
        const next = this.runs[i + 1];
        return next === undefined ? null : (this.starts[next.runId] ?? null);
    }

    /** This session frozen at `commit`, opened once. @param {string} commit */
    viewAt(commit) {
        let view = this.#views.get(commit);
        if (view === undefined) {
            view = openStore().then((store) => store.resolve(`${this.name}@${commit}`));
            this.#views.set(commit, view);
        }
        return view;
    }

    /**
     * Delegates this session asked that never answered: the page they
     * ran in closed. Each is told to the next turn (its work is on its
     * branch, to merge or ask again) and shown in the strip; the record
     * says so, so it is told once. Nothing starts a turn: that waits for
     * the person.
     */
    async #findInterrupted() {
        const ws = this.ws;
        if (ws === null) return;
        const plane = ws.plane(PLANE);
        const lost = [];
        for (const key of await plane.keys()) {
            if (!key.startsWith("delegates/")) continue;
            const record = /** @type {{ asked?: number, done?: boolean } | null} */ (await plane.get(key));
            if (record === null || record.done) continue;
            const name = key.slice("delegates/".length);
            // a full fork carries its parent's records: only this session's own count
            if (!name.startsWith(`${this.name}.`)) continue;
            lost.push(name);
            this.inbox.put(
                `[the studio's delegation mechanism speaking, not the person at the keyboard: delegate \`${name}\` was interrupted, since the page it ran in closed, and never answered. Its work so far is on its branch: ws-git diff ${name} --stat shows what it did; merge or check out what is useful, or ask afresh.]`,
                { kind: "mechanism", label: `delegate ${name}` },
            );
            plane.set(key, { ...record, done: true, interrupted: true });
            this.#recorded.set(name, true);
        }
        if (lost.length === 0) return;
        this.lostDelegates = lost;
        await ws.autoCommit({ tool: "studio.delegates" });
    }

    /** Record on the plane each delegate asked, and whether its answer
     *  was read: what a later page reads to find those it lost. Whether
     *  anything was written. */
    #recordDelegates() {
        const plane = this.ws?.plane(PLANE);
        if (plane === undefined) return false;
        let wrote = false;
        for (const job of this.jobs) {
            const done = job.status !== "running" && !this.unread.includes(job.name);
            if (this.#recorded.get(job.name) === done) continue;
            this.#recorded.set(job.name, done);
            plane.set(`delegates/${job.name}`, { asked: job.started, done });
            wrote = true;
        }
        return wrote;
    }

    /** The commit of delegate records written while no turn ran, in
     *  flight. @type {Promise<unknown> | null} */
    #saving = null;

    /** A delegate's session, opened to read: its runner works it. */
    get readonly() {
        return this.name.includes(".");
    }

    /** The parent of a delegate's session. */
    get parent() {
        return this.readonly ? this.name.slice(0, this.name.lastIndexOf(".")) : null;
    }

    /** Copy the helper's job table for the strip; poll it while a
     *  delegate runs, as their state changes away from any turn. */
    syncJobs() {
        this.jobs = this.helper?.list().map((j) => ({ ...j })) ?? [];
        this.unread = this.helper?.outstanding() ?? [];
        // a turn's own commits carry what changes during it; outside one,
        // commit it now, so what syncs never says an answer read is unread
        if (this.#recordDelegates() && !this.busy && this.ws !== null) {
            this.#saving = this.ws.commit({ tool: "studio.delegates" }).catch(() => undefined);
        }
        // while a turn runs (an ask may start any time) or a delegate does
        const running = this.busy || this.jobs.some((j) => j.status === "running");
        if (running && this.#poll === null && this.helper !== null) this.#poll = setInterval(() => this.syncJobs(), 1000);
        if (!running && this.#poll !== null) {
            clearInterval(this.#poll);
            this.#poll = null;
        }
    }

    /** Notes reached the model: a woken turn's first are its opening.
     *  @param {readonly import("@agex-ts/world").Note[]} notes */
    #delivered(notes) {
        if (!this.#awaitingOpening) return;
        this.#awaitingOpening = false;
        this.opened(this.inbox.render(notes));
    }

    /** The turn running opened with `text` (a woken turn's, delivered
     *  once it started). @param {string} text */
    opened(text) {
        this.prompt = text;
    }

    /** A delegate's turn starts, when this session is that delegate's,
     *  open to read: with `prompt`, or as a woken turn, its opening to
     *  come. @param {string} prompt */
    begin(prompt) {
        this.busy = true;
        this.live = [];
        this.prompt = prompt;
    }

    /** A delegate's turn event, from its runner, when this session is
     *  that delegate's, open to read. @param {TurnEvent} event */
    observe(event) {
        if (!this.busy) {
            // opened mid-turn: how the turn opened, from its runner
            this.begin(openings[this.name] ?? "");
        }
        this.#apply(event);
    }

    /** A delegate's turn ended: its record is read again. */
    async observed() {
        await this.ws?.refresh();
        await this.reload();
        this.live = [];
        this.busy = false;
        void this.#measure();
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
        /** @type {Record<string, string>} */
        const starts = {};
        const plane = ws.plane(PLANE);
        await Promise.all(
            this.runs.map(async (run) => {
                const turn = /** @type {{ before?: string } | null} */ (await plane.get(`turns/${run.runId}`));
                if (turn?.before) starts[run.runId] = turn.before;
            }),
        );
        this.starts = starts;
        this.folds = await ws.compaction.folds();
        const meta = await metaOf(ws);
        this.title = meta.title;
        this.createdAt = meta.createdAt;
        this.#meta = /** @type {Record<string, unknown> | null} */ (await ws.plane(PLANE).get("meta")) ?? {};
        await this.refreshFiles();
        this.appStamp += 1;
        this.filesStamp += 1;
        void this.#measure();
    }

    /** The next request's size, read again between turns. */
    async #measure() {
        const ws = this.ws;
        if (ws === null || this.busy || this.folding) return;
        try {
            const { tokens } = await this.#session(ws).context();
            if (!this.busy) this.context = this.runs.length > 0 ? tokens : null;
        } catch {
            // no model chosen, say: the meter waits for one
            this.context = null;
        }
    }

    /** Whether there's a turn since the last fold: something to fold. */
    get foldable() {
        const last = this.runs.at(-1)?.messages.at(-1)?.id;
        return last !== undefined && this.folds.at(-1)?.through !== last;
    }

    /**
     * Fold the conversation so far into a summary now, between turns, so
     * the next request starts small: the fold a budget would make, written
     * by the agent's model and committed on its own. Stop stops it; a
     * message sent meanwhile waits for it.
     */
    async foldNow() {
        await this.#held;
        const ws = this.ws;
        if (ws === null || this.busy || this.folding || this.interrupted || !this.foldable) return;
        const session = this.#session(ws);
        this.folding = true;
        this.#foldStopped = false;
        this.error = null;
        this.redoHead = null;
        this.#turn = session;
        const run = (async () => {
            try {
                await session.fold();
            } catch (e) {
                if (!this.#foldStopped) this.error = `couldn't fold: ${e instanceof Error ? e.message : String(e)}`;
            } finally {
                this.#turn = null;
                this.folding = false;
                await this.reload();
                await this.#saving;
                this.onMeta();
                // answers that landed while it folded
                void this.#maybeWake();
            }
        })();
        this.#folding = run;
        await run;
    }

    async refreshFiles() {
        if (this.ws === null) return;
        // the skills mounted under skills/ are the studio's, not the session's work
        const all = await this.ws.files.list("/workspace", { recursive: true }).catch(() => []);
        this.files = all.filter((p) => p !== "skills" && !p.startsWith("skills/"));
    }

    /** The agent for the next turn: a new one each time, since an agent
     *  holds nothing and the settings may have changed. */
    /** @param {{ delegate?: boolean }} [opts] a delegate's agent caps its
     *  tool calls per turn */
    #agent(opts = {}) {
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
            ...(opts.delegate && { maxToolCalls: DELEGATE_TOOL_CALLS }),
        });
    }

    /** The agent a delegate of this session runs on: this one's, its
     *  tool calls capped. @param {{ delegate: boolean }} opts */
    delegateAgent(opts) {
        return this.#agent(opts);
    }

    /** An agex-ts session over `ws` for the next turn: the world's tools,
     *  `test_app`, and the inbox that outlives each agent.
     *  @param {Workspace} ws */
    #session(ws) {
        const helper = this.helper;
        return this.#agent().session(ws, {
            inbox: this.inbox,
            ...(helper !== null && { sessions: helper }),
            tools: [testAppTool(this), ...(helper !== null ? [studioSessionsTool(helper, depthOf(this.name), publishedNow)] : [])],
            toolOptions: toolOptionsNow(),
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
        // the person spoke (a note mid-turn too): answers may wake the session again
        this.wakesLeft = WAKES;
        this.#wakeOk = true;
        this.#wakeNoted = false;
        this.notice = null;
        if (this.busy) {
            const note = this.inbox.put(prompt);
            this.queued = [...this.queued, { id: note.id, text: prompt }];
            return;
        }
        // a fold being written goes first: the turn starts from it
        await this.#folding;
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

    /** Take back a message still waiting for the turn running; whether
     *  it was still waiting (one on its way to the model can't be).
     *  @param {string} id */
    withdraw(id) {
        const taken = this.inbox.withdraw(id);
        if (taken) this.queued = this.queued.filter((q) => q.id !== id);
        return taken;
    }

    /** Continue the last turn, which an interruption cut short. */
    async resume() {
        await this.#held;
        if (this.ws === null || this.busy || this.folding || !this.interrupted) return;
        const session = this.#session(this.ws);
        await this.#runTurn(session, async () => {
            const out = await session.resume();
            // how it ended decides waking, as RunEnded does for a streamed turn
            this.#lastStatus = out.status;
            if (out.status !== "completed" && out.status !== "cancelled") this.error = `the turn ended ${out.status}${out.message ? `: ${out.message}` : ""}`;
        }, "(resuming)");
    }

    /** End the last turn, which an interruption cut short, as it stands. */
    async abandon() {
        await this.#held;
        if (this.ws === null || this.busy || this.folding || !this.interrupted) return;
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
        this.#turnAt = Date.now();
        this.#lastStatus = "completed";
        // the lost delegates are told to this turn
        this.lostDelegates = [];
        this.syncJobs();
        const run = (async () => {
            try {
                await body((event) => this.#apply(event));
            } catch (e) {
                this.error = e instanceof Error ? e.message : String(e);
                // a turn that threw ended no better than one that failed
                this.#lastStatus = "failed";
            } finally {
                this.#turn = null;
                // a woken turn that found nothing waiting opened on nothing
                this.#awaitingOpening = false;
                await this.reload();
                this.live = [];
                this.busy = false;
                this.#ended();
                // the next request's size, now the turn's reply is in it
                void this.#measure();
                // a turn stopped or failed: no waking until the person writes
                if (this.#lastStatus !== "completed") this.#wakeOk = false;
                this.syncJobs();
                // the records it changed are committed before sync hears of the change
                await this.#saving;
                this.onMeta();
                // the model names the session, when it's due, beside what follows
                void this.#retitle();
                // what the person wrote after the agent's last tool call never
                // reached it: the next turn, or after a stop, theirs to edit
                const missed = this.#takeQueued();
                if (missed !== "" && this.#lastStatus === "completed") void this.say(missed);
                else {
                    if (missed !== "") this.draft = this.draft === "" ? missed : `${missed}\n\n${this.draft}`;
                    // answers that landed after its last tool call
                    void this.#maybeWake();
                }
            }
        })();
        this.#running = run;
        await run;
    }

    /** A turn ended (the person's, a woken one, a resumed one): one the
     *  person wasn't looking at waits for them. */
    #ended() {
        if (looking(studio.current?.name === this.name)) return;
        this.unseen = true;
        if (this.#lastStatus === "failed" || this.#lastStatus === "interrupted") this.attention = true;
    }

    /** The person is looking at the session: what ended while they
     *  weren't is seen. */
    seen() {
        this.unseen = false;
        this.attention = false;
    }

    /** The person's messages still waiting, taken back, as one. */
    #takeQueued() {
        const texts = [];
        for (const note of this.inbox.pending()) {
            if (note.kind === "principal" && this.inbox.withdraw(note.id)) texts.push(note.text);
        }
        this.queued = [];
        return texts.join("\n\n");
    }

    /** A turn has started: note where it started from (what undoing it
     *  checks out), and the session's title and when it was last used.
     *  Written on the plane, so the turn's own commits carry them.
     *  @param {string} runId @param {string} head @param {string} prompt */
    #started(runId, head, prompt) {
        const plane = this.ws?.plane(PLANE);
        if (plane === undefined) return;
        plane.set(`turns/${runId}`, { before: head, at: Date.now() });
        const now = Date.now();
        // named for what was asked, not for the files attached to it
        const title = this.title || titleFrom(attachmentsOf(prompt ?? "").text);
        // at once, so the turn's own commits carry it
        this.#meta = { ...this.#meta, title, createdAt: this.createdAt || now, updatedAt: now };
        plane.set("meta", this.#meta);
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

    /** Stop the turn running now, and the delegates it asked that are
     *  still running (those of earlier turns go on). */
    cancel() {
        this.#turn?.cancel("stopped by the person");
        // a fold stopped stops alone: the delegates are the last turn's
        if (this.folding) {
            this.#foldStopped = true;
            return;
        }
        this.#cancelDelegates(this.#turnAt, { running: true });
    }

    /**
     * Cancel the delegates asked since `since`: running ones stop; with
     * `answered`, an answer not yet read is discarded too.
     *
     * @param {number} since @param {{ running?: boolean, answered?: boolean }} which
     */
    #cancelDelegates(since, which) {
        const helper = this.helper;
        if (helper === null) return;
        const waiting = new Set(helper.outstanding());
        for (const job of helper.list()) {
            if (job.started < since) continue;
            try {
                if (which.running && job.status === "running") helper.cancel(job.name);
                else if (which.answered && job.status !== "running" && waiting.has(job.name)) helper.result(job.name);
            } catch {
                // the rest still go
            }
        }
        this.syncJobs();
    }

    /**
     * A turn woken by delegates' answers that landed while the session
     * was idle: up to `WAKES` of them before the person writes again,
     * none after a turn was stopped or failed, and none without a model.
     */
    async #maybeWake() {
        // a sync of this session in flight finishes first; then look again
        await this.#held;
        const helper = this.helper;
        const ws = this.ws;
        // a fold being written wakes it once it lands (foldNow looks again)
        if (helper === null || ws === null || this.busy || this.folding || !this.#wakeOk) return;
        const running = new Set(helper.list().filter((j) => j.status === "running").map((j) => j.name));
        if (!helper.outstanding().some((name) => !running.has(name))) return;
        if (!isConfigured(getSettings())) return;
        if (this.wakesLeft <= 0) {
            if (!this.#wakeNoted) {
                this.#wakeNoted = true;
                this.notice = "Delegates have answered, but their answers have already started as many turns as they may since your last message. The agent will read them when you next write.";
            }
            return;
        }
        this.wakesLeft -= 1;
        const session = this.#session(ws);
        const startedAt = ws.head;
        this.#awaitingOpening = true;
        await this.#runTurn(
            session,
            async (apply) => {
                for await (const event of new RunStream(session, { wake: true })) {
                    if (event.kind === "RunStarted") this.#started(event.runId, startedAt, null);
                    apply(event);
                }
            },
            // its opening is the answers, told as they're delivered
            "",
        );
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
        if (this.ws === null || this.busy || this.folding) return;
        const turn = /** @type {{ before?: string, at?: number } | null} */ (await this.ws.plane(PLANE).get(`turns/${runId}`));
        if (!turn?.before) throw new Error("this turn's starting point isn't recorded, so it can't be undone");
        // the delegates asked since are unsaid: stopped, their answers dropped
        if (typeof turn.at === "number") this.#cancelDelegates(turn.at, { running: true, answered: true });
        const head = this.ws.head;
        await this.ws.checkout(turn.before);
        this.redoHead = head;
        await this.reload();
        this.onMeta();
    }

    /** Bring back what the last undo took away. */
    async redo() {
        await this.#held;
        if (this.ws === null || this.busy || this.folding || this.redoHead === null) return;
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
        // the person's name: the model's stop for good
        this.#meta = { ...meta, title, named: true, updatedAt: Date.now() };
        plane.set("meta", this.#meta);
        await this.ws.autoCommit({ tool: "studio.rename" });
        this.title = title;
        this.onMeta();
    }

    /**
     * Let the model name the session from its conversation, when that's
     * due (see `titles.js`): the person's own sessions only, on their
     * model, a failure leaving the name as it was.
     */
    async #retitle() {
        const ws = this.ws;
        const s = getSettings();
        if (ws === null || this.readonly || !isConfigured(s) || s.accessMode === "scripted") return;
        const plane = ws.plane(PLANE);
        const turns = personTurns(this.runs);
        if (!titleDue(/** @type {any} */ (await plane.get("meta")), turns)) return;
        /** @type {string | null} */
        let title;
        try {
            title = await generateTitle(buildModel(s, { session: this.name }), transcriptText(this.runs), { thinking: thinkingOf(s) });
        } catch {
            return;
        }
        if (title === null || this.ws !== ws) return;
        await this.#held;
        // read again: the person may have renamed it, or a later turn named it, meanwhile
        const meta = /** @type {any} */ (await plane.get("meta")) ?? {};
        if (meta.named === true || (typeof meta.titledAt === "number" && meta.titledAt >= turns)) return;
        this.#meta = { ...meta, title, titledAt: turns };
        plane.set("meta", this.#meta);
        // a turn running now commits it with its own; else a commit of its own
        if (!this.busy) await ws.autoCommit({ tool: "studio.title" });
        this.title = title;
        this.onMeta();
    }

    async close() {
        // its delegates stop with it: closing waits for running ones
        if (this.helper !== null) {
            for (const job of this.helper.list()) if (job.status === "running") this.helper.cancel(job.name);
            await this.helper.close();
            this.helper = null;
        }
        if (this.#poll !== null) clearInterval(this.#poll);
        this.#poll = null;
        for (const view of this.#views.values()) void view.then((v) => v.close(), () => undefined);
        this.#views.clear();
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
                if (event.name === "sessions") this.syncJobs();
                const part = this.live.find((p) => p.kind === "tool" && p.callId === event.callId);
                if (part?.kind === "tool") {
                    part.result = event.result;
                    part.isError = event.isError;
                }
                break;
            }
            case "Delivered": {
                this.live.push({ kind: "notes", notes: event.notes.map((n) => ({ kind: n.kind, label: n.label, text: n.text })) });
                const gone = new Set(event.notes.map((n) => n.id));
                this.queued = this.queued.filter((q) => !gone.has(q.id));
                break;
            }
            case "Usage":
                this.context = event.inputTokens;
                break;
            case "Compacted":
                this.live.push({ kind: "folded", summary: event.summary ?? "" });
                if (typeof event.tokensAfter === "number") this.context = event.tokensAfter;
                break;
            case "RunEnded":
                this.#lastStatus = event.status;
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
            // opened from a gist now: where its updates come from
            if (from.gist !== undefined && JSON.stringify(known.source?.gist) !== JSON.stringify(from.gist)) {
                await this.#setSource(known.name, { head: header.head, gist: from.gist });
            }
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

    /** Record where session `name` came from.
     *  @param {string} name @param {SessionSource} source */
    async #setSource(name, source) {
        const store = await openStore();
        const open = this.#open.get(name)?.ws ?? null;
        const ws = open ?? (await store.open(name, { profile: PROFILE }));
        try {
            ws.plane(PLANE).set("source", source);
            await ws.autoCommit({ tool: "studio.source" });
        } finally {
            if (open === null) await ws.close();
        }
        await this.refresh();
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
        // the title as the session holds it (the list may not have caught up)
        const view = await store.resolve(name);
        const title = (await metaOf(view)).title || "Untitled";
        await view.close();
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
        // the revision first, then its bytes, so the revision recorded (where
        // update checks start from) is the one opened; when GitHub's API
        // can't say (rate-limited), the latest file, its revision unknown
        const revision = ref.revision ?? (await latestRevision(ref.id).catch(() => null));
        const bytes = await fetchGistBundle({ ...ref, revision });
        return this.importBundle(bytes, { gist: { owner: ref.owner, id: ref.id, slug: ref.slug, revision: revision ?? "", pinned: ref.revision !== null } });
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
