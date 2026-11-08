import { Memory } from "@agex-ts/kvgit/backends/memory";
import { Store } from "@agex-ts/world";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keepEvent, openings, turnSoFar } from "./delegation.svelte.js";
import { ChatSession } from "./session.svelte.js";

const NAME = "s1.scout";

beforeEach(() => {
    const items = new Map();
    vi.stubGlobal("localStorage", {
        getItem: (/** @type {string} */ k) => items.get(k) ?? null,
        setItem: (/** @type {string} */ k, /** @type {string} */ v) => items.set(k, String(v)),
        removeItem: (/** @type {string} */ k) => items.delete(k),
    });
});

afterEach(() => {
    delete openings[NAME];
    delete turnSoFar[NAME];
});

/** @type {import("@agex-ts/world").TurnEvent[]} */
const EVENTS = [
    { kind: "ThinkingDelta", text: "Look" },
    { kind: "ThinkingDelta", text: "ing." },
    { kind: "ToolStarted", callId: "c1", name: "run_ts", args: { code: "one" } },
    { kind: "ToolEnded", callId: "c1", name: "run_ts", result: "1", isError: false },
    { kind: "ToolStarted", callId: "c2", name: "run_ts", args: { code: "two" } },
    { kind: "ToolEnded", callId: "c2", name: "run_ts", result: "2", isError: false },
];

/** A delegate's session, open to read, on a fresh world. */
async function delegateView() {
    const store = await Store.open(new Memory());
    const ws = await store.open(NAME);
    return { ws, session: new ChatSession(NAME, { current: null, opened: () => undefined }) };
}

/** The delegate's turn begins, as its runner begins it. */
function turnBegins() {
    openings[NAME] = "Task from s1: count to three.";
    turnSoFar[NAME] = [];
}

/** The runner's next event: kept, then handed to the view, if one is open.
 *  @param {number} i @param {ChatSession | null} view */
function runnerSends(i, view) {
    const event = /** @type {import("@agex-ts/world").TurnEvent} */ (EVENTS[i]);
    keepEvent(turnSoFar[NAME] ?? [], event);
    view?.observe(event);
}

/** The live parts, read briefly. @param {ChatSession} session */
const shown = (session) => session.live.map((p) => (p.kind === "tool" ? `${p.name} ${p.result ?? "…"}` : `${p.kind} ${"text" in p ? p.text : ""}`));

describe("a delegate's view opened mid-turn", () => {
    it("shows the turn from its start, and goes on from there", async () => {
        const { ws, session } = await delegateView();
        turnBegins();
        for (let i = 0; i < 5; i++) runnerSends(i, null);
        await session.open(ws);
        expect(session.busy).toBe(true);
        expect(session.prompt).toBe("Task from s1: count to three.");
        expect(shown(session)).toEqual(["thinking Looking.", "run_ts 1", "run_ts …"]);
        runnerSends(5, session);
        expect(shown(session)).toEqual(["thinking Looking.", "run_ts 1", "run_ts 2"]);
        await session.close();
    });

    it("catches up on the first event it is handed, that event once", async () => {
        const { ws, session } = await delegateView();
        // open before the turn began: nothing to show yet
        await session.open(ws);
        expect(session.busy).toBe(false);
        turnBegins();
        for (let i = 0; i < 2; i++) runnerSends(i, null);
        runnerSends(2, session);
        expect(session.busy).toBe(true);
        expect(shown(session)).toEqual(["thinking Looking.", "run_ts …"]);
        await session.close();
    });

    it("shows the event it is handed when its runner kept none", async () => {
        const { ws, session } = await delegateView();
        await session.open(ws);
        session.observe(/** @type {import("@agex-ts/world").TurnEvent} */ (EVENTS[2]));
        expect(shown(session)).toEqual(["run_ts …"]);
        await session.close();
    });
});
