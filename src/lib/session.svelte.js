/**
 * One session, as the chat shows it: its record, read from the
 * workspace, and each turn an agex-ts turn over it.
 *
 * The chat renders the stored runs (agex-ts's record) and, while a turn
 * runs, the `TurnEvent`s it streams; when the turn ends the record is
 * read again and the live view dropped.
 */

import { Inbox, Policy, Sessions } from "@agex-ts/world";
import { Agent, RunStream, ScriptedProvider } from "agex-ts";
import { dbRestores } from "./db-restore.svelte.js";
import { DELEGATE_TOOL_CALLS, StudioRunner, WAKES, cancelRunning, depthOf, openings, renderPublished, studioSessionsTool } from "./delegation.svelte.js";
import { buildModel, foldBudgetOf, thinkingOf } from "./model.js";
import { attachmentsOf } from "./notes.js";
import { lastReply, notifyTurnEnded } from "./notify.js";
import { primer } from "./primer.js";
import { profileFor, toolOptionsNow } from "./profile.js";
import { requestSecretTool } from "./request-secret.js";
import { keepUnchanged } from "./runs.js";
import { scriptedNow } from "./scripted.js";
import { getSettings, isConfigured } from "./settings.js";
import { looking } from "./status.js";
import { Gate, SessionBusy } from "./gate.js";
import { PLANE, metaOf, openStore } from "./store.js";
import { testAppTool } from "./test-app.js";
import { generateTitle, personTurns, titleDue, transcriptText } from "./titles.js";
import { errorText } from "./errors.js";
import { writeFile } from "./ws-paths.js";

/** @typedef {import("agex-ts").Run} Run */
/** @typedef {import("@agex-ts/world").TurnEvent} TurnEvent */
/** @typedef {import("@agex-ts/world").Workspace} Workspace */
/** @typedef {import("@agex-ts/world").Fold} Fold */

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

/** The published apps, for `sessions published`. */
async function publishedNow() {
    return renderPublished(await openStore());
}

/**
 * What a session's delegates run with: its agent (capped as a
 * delegate's), `test_app`, `request_secret` (which refuses, saying to
 * name the key in its answer), the `sessions` tool at their depth, and
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
            // refused: a delegate says in its answer which key it needs
            requestSecretTool({ name: ws.session, delegate: true }),
            studioSessionsTool(helper, depth, publishedNow),
        ],
        observe: (name) => owner.studio.opened(name),
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
    /** What has the session's workspace to itself: a turn, a fold, a
     *  sync or an edit. */
    #gate = new Gate();
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

    /** The studio the session is open in: what the person is looking at,
     *  and the sessions open beside it. @type {Pick<import("./studio.svelte.js").Studio, "current" | "opened">} */
    studio;

    /** @param {string} name @param {Pick<import("./studio.svelte.js").Studio, "current" | "opened">} studio */
    constructor(name, studio) {
        this.name = name;
        this.studio = studio;
        // what a fold, a sync or an edit kept from committing goes now
        this.#gate.onFree = () => this.#saveRecords();
    }

    /** Open the session's workspace (or take one already open) and read
     *  its record.
     *  @param {Workspace} [ws] */
    async open(ws) {
        this.ws = ws ?? (await (await openStore()).open(this.name, { profile: profileFor(this.name) }));
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
        // commit it now (or once a fold, sync or edit lets the session
        // go), so what syncs never says an answer read is unread
        if (this.#recordDelegates()) this.#recordsDirty = true;
        this.#saveRecords();
        // while a turn runs (an ask may start any time) or a delegate does
        const running = this.busy || this.jobs.some((j) => j.status === "running");
        if (running && this.#poll === null && this.helper !== null) this.#poll = setInterval(() => this.syncJobs(), 1000);
        if (!running && this.#poll !== null) {
            clearInterval(this.#poll);
            this.#poll = null;
        }
    }

    /** Delegate records written since the last commit: one waits for the
     *  session to be free. */
    #recordsDirty = false;

    /** Commit the delegate records written, as an edit of its own, if
     *  nothing holds the session (a turn's own commits carry them, and
     *  what else holds it commits them as it lets go): what waits for the
     *  session starts once they're committed. */
    #saveRecords() {
        const ws = this.ws;
        if (!this.#recordsDirty || ws === null || this.busy) return;
        const release = this.#gate.tryTake("edit");
        if (release === null) return;
        this.#recordsDirty = false;
        this.#saving = ws.commit({ tool: "studio.delegates" }).catch(() => undefined).finally(release);
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
        try {
            await this.ws?.refresh();
            await this.#reloadAfter();
        } finally {
            this.live = [];
            this.busy = false;
        }
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
        this.runs = keepUnchanged(this.runs, await reader.runs());
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

    /** Read the record again once a turn or a fold has ended: a failure
     *  is told in `error` (beside any the turn left), not thrown, so
     *  what ends the turn still runs. */
    async #reloadAfter() {
        try {
            await this.reload();
        } catch (e) {
            this.error ??= `couldn't read the session back: ${errorText(e)}`;
        }
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
        const release = await this.#gate.take("fold", ["turn", "fold"], () => this.ws !== null && !this.interrupted && this.foldable);
        const ws = this.ws;
        if (release === null || ws === null) return release?.();
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
                if (!this.#foldStopped) this.error = `couldn't fold: ${errorText(e)}`;
            } finally {
                this.#turn = null;
                await this.#reloadAfter();
                this.folding = false;
                release();
                // the next request's size, now it starts from the fold
                void this.#measure();
                await this.#saving;
                this.onMeta();
                // answers that landed while it folded
                void this.#maybeWake();
            }
        })();
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
    /** @param {{ delegate?: boolean, session?: string }} [opts] a
     *  delegate's agent caps its tool calls per turn, and its model is
     *  its own session's (`session`, which names its affinity key) */
    #agent(opts = {}) {
        const s = getSettings();
        return new Agent({
            model: scriptedNow(s) ?? buildModel(s, { session: opts.session ?? this.name }),
            primer: primer(s),
            settings: { thinking: thinkingOf(s), maxTokens: 16000 },
            compaction: foldBudgetOf(s) > 0 ? new Policy(foldBudgetOf(s)) : null,
            ...(opts.delegate && { maxToolCalls: DELEGATE_TOOL_CALLS }),
        });
    }

    /** The agent a delegate of this session runs on: this one's, its
     *  tool calls capped, its model the delegate's own session's.
     *  @param {{ delegate: boolean, session: string }} opts */
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
            tools: [testAppTool(this), requestSecretTool(this), ...(helper !== null ? [studioSessionsTool(helper, depthOf(this.name), publishedNow)] : [])],
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
        // a fold, a sync or an edit of this session goes first: the turn
        // starts from it; a turn running (or one another call started
        // meanwhile: a message sent beside this one, answers waking the
        // session) takes this one as a note
        const release = await this.#gate.take("turn", ["turn"], () => this.ws !== null);
        const ws = this.ws;
        if (ws === null) {
            release?.();
            throw new Error("the session isn't open");
        }
        if (release === null) return this.#queue(prompt);
        const session = this.#session(ws);
        const startedAt = ws.head;
        await this.#runTurn(session, async (apply) => {
            for await (const event of session.stream(prompt)) {
                if (event.kind === "RunStarted") this.#started(event.runId, startedAt, prompt);
                apply(event);
            }
        }, prompt, release);
    }

    /** Queue `prompt` for the turn running, to ride its next tool result.
     *  @param {string} prompt */
    #queue(prompt) {
        const note = this.inbox.put(prompt);
        this.queued = [...this.queued, { id: note.id, text: prompt }];
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
        const release = await this.#gate.take("turn", ["turn", "fold"], () => this.ws !== null && this.interrupted);
        if (release === null || this.ws === null) return release?.();
        const session = this.#session(this.ws);
        await this.#runTurn(session, async () => {
            const out = await session.resume();
            // how it ended decides waking, as RunEnded does for a streamed turn
            this.#lastStatus = out.status;
            if (out.status !== "completed" && out.status !== "cancelled") this.error = `the turn ended ${out.status}${out.message ? `: ${out.message}` : ""}`;
        }, "(resuming)", release);
    }

    /** End the last turn, which an interruption cut short, as it stands. */
    async abandon() {
        const release = await this.#gate.take("edit", ["turn", "fold"], () => this.ws !== null && this.interrupted);
        if (release === null) return;
        try {
            if (this.ws === null) return;
            await this.#agent().session(this.ws).abandon("set aside by the person");
            await this.reload();
        } finally {
            release();
        }
    }

    /**
     * Run a turn, the session's gate taken for it: let go once its record
     * is read back.
     *
     * @param {import("agex-ts").Session} session
     * @param {(apply: (event: TurnEvent) => void) => Promise<void>} body
     * @param {string} prompt
     * @param {() => void} release
     */
    async #runTurn(session, body, prompt, release) {
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
                this.error = errorText(e);
                // a turn that threw ended no better than one that failed
                this.#lastStatus = "failed";
            } finally {
                this.#turn = null;
                // a restore of the app's database it asked about goes unanswered
                dbRestores.cancel(this.name);
                // a woken turn that found nothing waiting opened on nothing
                this.#awaitingOpening = false;
                await this.#reloadAfter();
                this.live = [];
                this.busy = false;
                // what the person wrote after the agent's last tool call never
                // reached it: taken back before the session is let go, so a
                // turn starting next doesn't take it as its own note
                const missed = this.#takeQueued();
                release();
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
                // the next turn, or after a stop, theirs to edit
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
     *  person wasn't looking at waits for them, and tells them if they
     *  asked to be told. */
    #ended() {
        if (looking(this.studio.current?.name === this.name)) return;
        this.unseen = true;
        if (this.#lastStatus === "failed" || this.#lastStatus === "interrupted") this.attention = true;
        notifyTurnEnded({ session: this.name, title: this.title, status: this.#lastStatus, reply: lastReply(this.runs.at(-1)), error: this.error });
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
        if (this.ws === null || files.length === 0) return [];
        const release = await this.#gate.take("edit", ["turn"]);
        if (release === null) throw new Error("a turn is running; add files once it ends");
        try {
            const ws = this.ws;
            if (ws === null) return [];
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
        } finally {
            release();
        }
    }

    /** Wait for the turn running now, if any. */
    async settled() {
        await this.#running;
    }

    /**
     * Run `fn` (a sync of this session) with the session to itself: it
     * waits for an edit, and nothing else starts until it ends. Refused
     * (`SessionBusy`) while a turn or a fold has it; their ends schedule
     * the sync again.
     *
     * @template T
     * @param {() => Promise<T>} fn
     */
    async hold(fn) {
        const release = await this.#gate.take("sync", ["turn", "fold"]);
        if (release === null) throw new SessionBusy();
        try {
            return await fn();
        } finally {
            release();
        }
    }

    /**
     * Run `fn` on the session's workspace (a fork taken of it, say) with
     * the session to itself: it waits for a sync or an edit; null, without
     * running it, while a turn or a fold has it.
     *
     * @template T
     * @param {(ws: Workspace) => Promise<T>} fn
     * @returns {Promise<T | null>}
     */
    async edit(fn) {
        const release = await this.#gate.take("edit", ["turn", "fold"], () => this.ws !== null);
        const ws = this.ws;
        if (release === null || ws === null) {
            release?.();
            return null;
        }
        try {
            return await fn(ws);
        } finally {
            release();
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
        // a sync or an edit of this session finishes first; a turn or a
        // fold looks again when it ends
        const release = await this.#gate.take("turn", ["turn", "fold"], () => this.#wakeDue());
        const ws = this.ws;
        if (release === null || ws === null) return release?.();
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
            release,
        );
    }

    /** Whether answers are waiting that a woken turn may read now; out
     *  of wakes, the person is told so, once. */
    #wakeDue() {
        const helper = this.helper;
        if (helper === null || this.ws === null || !this.#wakeOk) return false;
        const running = new Set(helper.list().filter((j) => j.status === "running").map((j) => j.name));
        if (!helper.outstanding().some((name) => !running.has(name))) return false;
        if (!isConfigured(getSettings())) return false;
        if (this.wakesLeft > 0) return true;
        if (!this.#wakeNoted) {
            this.#wakeNoted = true;
            this.notice = "Delegates have answered, but their answers have already started as many turns as they may since your last message. The agent will read them when you next write.";
        }
        return false;
    }

    /**
     * Undo run `runId` and everything after it: the workspace, the
     * conversation and the folds go back to where that turn started.
     * History is kept, so `redo` brings it all back.
     *
     * @param {string} runId
     */
    async undo(runId) {
        const release = await this.#gate.take("edit", ["turn", "fold"], () => this.ws !== null);
        if (release === null) return;
        try {
            const ws = this.ws;
            if (ws === null) return;
            const turn = /** @type {{ before?: string, at?: number } | null} */ (await ws.plane(PLANE).get(`turns/${runId}`));
            if (!turn?.before) throw new Error("this turn's starting point isn't recorded, so it can't be undone");
            // the delegates asked since are unsaid: stopped, their answers dropped
            if (typeof turn.at === "number") this.#cancelDelegates(turn.at, { running: true, answered: true });
            const head = ws.head;
            await ws.checkout(turn.before);
            this.redoHead = head;
            await this.reload();
        } finally {
            release();
        }
        this.onMeta();
    }

    /** Bring back what the last undo took away. */
    async redo() {
        const release = await this.#gate.take("edit", ["turn", "fold"], () => this.ws !== null && this.redoHead !== null);
        if (release === null) return;
        try {
            if (this.ws === null || this.redoHead === null) return;
            await this.ws.checkout(this.redoHead);
            this.redoHead = null;
            await this.reload();
        } finally {
            release();
        }
        this.onMeta();
    }

    /** Give the session a title. @param {string} title */
    async rename(title) {
        // beside a turn or a fold, whose commits take it in too; not
        // beside a sync or an edit, which move the workspace under it
        await this.#gate.clearOf(["sync", "edit"]);
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
        await this.#gate.clearOf(["sync", "edit"]);
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
            cancelRunning(this.helper);
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
function titleFrom(prompt) {
    const line = prompt.trim().split("\n")[0] ?? "";
    return line.length > 60 ? `${line.slice(0, 57)}…` : line || "Untitled";
}
