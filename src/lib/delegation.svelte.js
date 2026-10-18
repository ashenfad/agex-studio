/**
 * Delegation, as the studio runs it: a session hands separable work to
 * delegates, forks of itself that run on the person's model in this
 * page, and their answers come back to it (agex-ts and the world do the
 * mechanics: the `sessions` tool, the forks, the answers).
 *
 * What the studio adds:
 *
 * - **Its own runner**, so a delegate's turns stream to the page (the
 *   strip's "doing" line, and its transcript live when opened), and a
 *   delegate runs as the parent's agent does, with `test_app` in a
 *   hidden page of its own (not `live`: the preview is the parent's),
 *   and a cap on its tool calls per turn.
 * - **A depth cap:** delegation nests two levels deep, past which
 *   `sessions ask` is refused, saying to do the work itself.
 * - **`sessions published`:** the apps the person published (the
 *   store's `published/<slug>/<n>` tags), each a tag to start from.
 *
 * Waking a parent whose delegates answered while it was idle is the
 * chat session's (see `ChatSession`), as are stopping and undoing.
 */

import { Inbox, Sessions, sessionsTool, untilSettled } from "@agex-ts/world";
import { RunStream } from "agex-ts";
import { dbRestores } from "./db-restore.svelte.js";

/** How deep delegation nests: a delegate's delegate, and no further. */
const DEPTH_CAP = 2;
/** The most tool calls a delegate makes in one turn. */
export const DELEGATE_TOOL_CALLS = 60;
/** The woken turns a delegate gets to settle its own delegates' answers,
 *  when its ask sets no budget. */
const DELEGATE_WAKES = 3;
/** The turns an idle session is woken for by answers, before the
 *  person writes again. */
export const WAKES = 10;

/** How deep session `name` is: a delegate's name is its parent's and a
 *  dot and its own (`lead.scout.notes` is two deep). @param {string} name */
export function depthOf(name) {
    return name.split(".").length - 1;
}

/** What a running delegate is doing now, by session name, for the strip.
 *  @type {Record<string, string>} */
export const doing = $state({});

/** How a running delegate's turn opened (its brief and task, or the
 *  answers that woke it), by session name: for a view of it opened
 *  mid-turn. @type {Record<string, string>} */
export const openings = {};

/** @param {import("@agex-ts/world").TurnEvent} event */
function doingOf(event) {
    switch (event.kind) {
        case "ThinkingDelta":
            return "thinking";
        case "TextDelta":
            return "writing";
        case "ToolStarted": {
            const args = /** @type {Record<string, unknown>} */ (event.args);
            const first = Object.values(args).find((v) => typeof v === "string");
            const what = typeof first === "string" ? first.split("\n")[0]?.slice(0, 60) : "";
            return `${event.name}${what ? `: ${what}` : ""}`;
        }
        default:
            return null;
    }
}

/** Where a delegate's brief ends and its task begins. */
const TASK_FOLLOWS = "\n\nThe task follows.\n\n";

/** A delegate's task and who asked, from its first message (the brief
 *  its runner wrote), or null. @param {string} text */
export function delegateTask(text) {
    const m = /^\[the studio's delegation mechanism speaking, not the person at the keyboard: you are a delegate of `([^`]+)`/.exec(text);
    const at = text.indexOf(TASK_FOLLOWS);
    if (m === null || at < 0) return null;
    return { parent: /** @type {string} */ (m[1]), task: text.slice(at + TASK_FOLLOWS.length) };
}

const BRIEF = (/** @type {string} */ parent) =>
    `[the studio's delegation mechanism speaking, not the person at the keyboard: you are a delegate of \`${parent}\`, working on a fork of its workspace. Your reply is the whole of what reaches it: say what you did and what you found, in prose. It brings your files back itself (ws-git merge or checkout of your branch). test_app checks an app here, in a hidden page of its own; the person's preview shows the session that asked, so live isn't yours.]${TASK_FOLLOWS}`;

const DEPTH_REFUSAL = (/** @type {number} */ cap) =>
    `sessions ask refused: delegation nests ${cap} levels deep here and this session is already that deep, so there is no fork to hand this to. Do the task yourself, or answer with what you have found: your reply is the whole of what reaches the session that asked. list, result, keep, cancel and published still work.`;

const PUBLISHED_NOTE =
    '\n\naction="published" lists the apps the person published, newest first, each with a store tag naming the session as it was published. Start from one with ws-git checkout <tag> -- app/ (its files), ws-git diff <tag>, or sessions ask fork_from="<tag>" (the session that built it, inherit="full" with its conversation).';

/**
 * The `sessions` tool for a session `depth` deep: the world's, refusing
 * an ask at the depth cap, and listing what the person published.
 *
 * @param {Sessions} helper
 * @param {number} depth
 * @param {() => Promise<string>} published the published apps, rendered
 */
export function studioSessionsTool(helper, depth, published) {
    const base = sessionsTool(helper);
    return {
        ...base,
        description: base.description + PUBLISHED_NOTE,
        /** @param {any} args @param {any} [call] */
        async call(args, call) {
            if (args?.action === "published") return { text: await published(), images: [], isError: false };
            if (args?.action === "ask" && depth >= DEPTH_CAP) return { text: DEPTH_REFUSAL(DEPTH_CAP), images: [], isError: true };
            return base.call(args, call);
        },
    };
}

/**
 * The published apps as `sessions published` says them: newest version
 * of each, with its tag.
 *
 * @param {import("@agex-ts/world").Store} store
 */
export async function renderPublished(store) {
    /** @type {Map<string, { title: string, version: number, tag: string }>} */
    const apps = new Map();
    for (const tag of (await store.tags.list()).keys()) {
        const m = /^published\/([^/]+)\/(\d+)$/.exec(tag);
        if (m === null) continue;
        const slug = /** @type {string} */ (m[1]);
        const version = Number(m[2]);
        if ((apps.get(slug)?.version ?? 0) >= version) continue;
        const info = /** @type {any} */ ((await store.tags.info(tag))?.info);
        apps.set(slug, { title: typeof info?.title === "string" ? info.title : slug, version, tag });
    }
    if (apps.size === 0) return "The person has published nothing yet.";
    const lines = [...apps.values()].sort((a, b) => b.version - a.version).map((a) => `- ${a.title} (version ${a.version}): ${a.tag}`);
    return `Published apps, each with the store tag of its latest version:\n${lines.join("\n")}`;
}

/** A delegate's turn ended other than completed. */
class Ended extends Error {
    /** @param {{ text: string, status: "failed" }} reply */
    constructor(reply) {
        super(reply.text);
        this.reply = reply;
    }
}

/** Stop every running delegate of `helper`: one that fails to stop
 *  doesn't keep the rest running. @param {Sessions} helper */
export function cancelRunning(helper) {
    for (const job of helper.list()) {
        if (job.status !== "running") continue;
        try {
            helper.cancel(job.name);
        } catch {
            // the rest still stop
        }
    }
}

/** @typedef {import("agex-ts").Agent} Agent */
/** @typedef {import("@agex-ts/world").Tool} Tool */
/** @typedef {import("@agex-ts/world").TurnEvent} TurnEvent */
/** @typedef {{ begin: (prompt: string) => void, opened: (text: string) => void, observe: (event: TurnEvent) => void, observed: () => Promise<void> }} Observer */
/**
 * What a runner needs from the studio: the agent a delegate runs on,
 * its tools at a depth, and the chat session open on a delegate.
 *
 * @typedef {{ agent: (opts: { delegate: boolean }) => Agent, tools: (helper: Sessions, depth: number, ws: import("@agex-ts/world").Workspace) => Tool[], observe: (name: string) => Observer | undefined, toolOptions: () => { vision: boolean, codePrimer: string } }} RunnerHost
 */

/**
 * Runs the delegates of the session on `ws`, as agex-ts's `Runner`
 * does, and streams their turns: to `doing` for the strip, and to the
 * chat session open on a delegate, if one is. A `SessionRunner`.
 */
export class StudioRunner {
    /** @param {import("@agex-ts/world").Workspace} ws @param {RunnerHost} host */
    constructor(ws, host) {
        this.ws = ws;
        this.host = host;
    }

    /**
     * @param {string} session
     * @param {string} task
     * @param {{ budget?: unknown, signal: AbortSignal }} opts
     */
    async run(session, task, { budget, signal }) {
        const wakes = typeof budget === "number" ? budget : DELEGATE_WAKES;
        const child = await this.ws.store.open(session, this.ws.settings);
        const depth = depthOf(session);
        const helper = new Sessions(child, new StudioRunner(child, this.host));
        /** A woken turn is starting, its opening (its own delegates'
         *  answers) not yet delivered. */
        let awaiting = false;
        const inbox = new Inbox({
            onDelivered: (notes) => {
                if (!awaiting) return;
                awaiting = false;
                openings[session] = inbox.render(notes);
                this.host.observe(session)?.opened(openings[session]);
            },
        });
        const delegate = this.host.agent({ delegate: true }).session(child, {
            sessions: helper,
            inbox,
            tools: this.host.tools(helper, depth, child),
            // the parent's: view_image when the model takes images, and agex's guide
            toolOptions: this.host.toolOptions(),
        });
        const stop = () => {
            delegate.cancel("stopped");
            cancelRunning(helper);
            void helper.close();
        };
        signal.addEventListener("abort", stop, { once: true });
        doing[session] = "starting";
        try {
            if (signal.aborted) stop();
            const settled = await untilSettled(
                async (prompt) => {
                    if (signal.aborted) throw new Ended({ text: "stopped", status: "failed" });
                    // the view open on it, if any, opens the turn as its record will:
                    // the brief and task, or for a woken turn, the answers it's told of
                    awaiting = prompt === null;
                    openings[session] = prompt ?? "";
                    this.host.observe(session)?.begin(openings[session]);
                    /** @param {import("@agex-ts/world").TurnEvent} event */
                    const onEvent = (event) => {
                        const now = doingOf(event);
                        if (now !== null) doing[session] = now;
                        this.host.observe(session)?.observe(event);
                    };
                    const turn = prompt !== null ? delegate.stream(prompt, { onEvent }) : new RunStream(delegate, { wake: true, onEvent });
                    const outcome = await turn.wait();
                    // a restore of the app's database it asked about goes unanswered
                    dbRestores.cancel(session);
                    await this.host.observe(session)?.observed();
                    if (outcome.status !== "completed") {
                        const said = outcome.text !== "" ? `${outcome.text}\n\n` : "";
                        throw new Ended({ text: `${said}[the delegate's turn ended ${outcome.status}: ${outcome.message ?? outcome.status}]`, status: "failed" });
                    }
                    return outcome.text;
                },
                helper,
                delegate.inbox,
                { prompt: BRIEF(this.ws.session) + task, maxWakes: wakes },
            );
            return settled.text;
        } catch (e) {
            if (e instanceof Ended) return e.reply;
            throw e;
        } finally {
            delete doing[session];
            delete openings[session];
            signal.removeEventListener("abort", stop);
            await helper.close();
            await child.close();
        }
    }
}

/**
 * The delegates' answers a turn's opening delivered (the inbox the
 * mechanism prefixes to a woken turn, or to the person's message): what
 * the person said, if anything, and each answer's delegate and first
 * line. Null when it delivered none.
 *
 * @param {string} text
 * @returns {{ said: string, answers: { name: string, preview: string }[] } | null}
 */
export function deliveredAnswers(text) {
    const at = text.indexOf("---- inbox ----");
    if (at < 0) return null;
    const end = text.indexOf("---- /inbox", at);
    const inbox = text.slice(at, end < 0 ? undefined : end);
    /** @type {{ name: string, preview: string }[]} */
    const answers = [];
    for (const m of inbox.matchAll(/^\[delegate (\S+) [—-][^\n]*\n([^\n]*)/gm)) {
        answers.push({ name: /** @type {string} */ (m[1]), preview: (m[2] ?? "").trim() });
    }
    if (answers.length === 0) return null;
    // what follows the block's trailer line, if anything does
    const eol = end < 0 ? -1 : text.indexOf("\n", end);
    const after = eol < 0 ? "" : text.slice(eol + 1);
    return { said: `${text.slice(0, at)}${after}`.trim(), answers };
}
