/**
 * Unit tests for the streaming-accumulation logic in `SessionRuntime`.
 *
 * This logic used to live inside `ChatShell.svelte` (untestable as
 * component-local closures). Lifting it into `session-runtime.svelte.js`
 * (Phase 1 of concurrent-sessions) makes it directly exercisable — these
 * tests pin the token → events/report behavior the chat feed depends on.
 *
 * Only the pure accumulation surface is exercised here (handleToken,
 * snapshotTurn, commitActiveReport, rebuildStreamingMessages, spawn
 * chips). The async loop (`send`, undo, …) hits the kernel adapter and
 * is out of scope for unit tests.
 */

import { describe, it, expect } from "vitest";
import { SessionRuntime } from "./session-runtime.svelte.js";

describe("SessionRuntime — report (text) accumulation", () => {
    it("streams a report into a live bubble, commits it on turn_complete", () => {
        const rt = new SessionRuntime("chat-test");
        rt.handleToken({
            type: "report",
            start: true,
            content: "Hello ",
            emission_index: 0,
        });
        rt.handleToken({ type: "report", content: "world", emission_index: 0 });

        // While streaming: a live (streaming) report bubble is present.
        expect(rt.activeReportText).toBe("Hello world");
        const streaming = rt.messages.filter((m) => m.streaming);
        const liveReport = streaming.find((m) => m.isReport);
        expect(liveReport?.content).toBe("Hello world");

        rt.handleToken({ type: "turn_complete" });

        // After turn_complete: one permanent (non-streaming) report
        // bubble; the live accumulator is cleared.
        expect(rt.activeReportText).toBe(null);
        const committed = rt.messages.filter((m) => !m.streaming);
        expect(committed).toHaveLength(1);
        expect(committed[0].isReport).toBe(true);
        expect(committed[0].content).toBe("Hello world");
        // A pure-narration turn produces no activity event.
        expect(rt.streamingEvents).toHaveLength(0);
    });
});

describe("SessionRuntime — snapshotTurn", () => {
    it("keeps tool emissions but excludes text (report renders as its own bubble)", () => {
        const rt = new SessionRuntime("chat-test");
        rt.handleToken({ type: "title", content: "Do math", emission_index: 0 });
        rt.handleToken({ type: "ts", content: "1 + 1", emission_index: 0 });
        rt.handleToken({
            type: "report",
            start: true,
            content: "Computing.",
            emission_index: 1,
        });

        const snap = rt.snapshotTurn();
        expect(snap.title).toBe("Do math");
        expect(snap.report).toBe("Computing.");
        // The ts emission is in `emissions`; the text emission is not.
        expect(snap.emissions).toHaveLength(1);
        expect(snap.emissions[0].kind).toBe("ts");
        expect(snap.emissions.every((e) => e.kind !== "text")).toBe(true);
    });

    it("migrates leading thinking into a ts emission's thinking field", () => {
        const rt = new SessionRuntime("chat-test");
        // Thinking streams first on emission 0, then code arrives — the
        // block should end up as a `ts` emission carrying the thinking,
        // not a standalone `thinking` block that vanishes.
        rt.handleToken({
            type: "thinking",
            content: "let me think",
            emission_index: 0,
        });
        rt.handleToken({ type: "ts", content: "doWork()", emission_index: 0 });

        const snap = rt.snapshotTurn();
        expect(snap.emissions).toHaveLength(1);
        expect(snap.emissions[0].kind).toBe("ts");
        expect(snap.emissions[0].code).toBe("doWork()");
        expect(snap.emissions[0].thinking).toBe("let me think");
    });
});

describe("SessionRuntime — turn_complete activity", () => {
    it("commits a tool turn as one activity event", () => {
        const rt = new SessionRuntime("chat-test");
        rt.handleToken({ type: "title", content: "Run", emission_index: 0 });
        rt.handleToken({ type: "terminal", content: "ls -la", emission_index: 0 });
        rt.handleToken({ type: "turn_complete" });

        expect(rt.streamingEvents).toHaveLength(1);
        const ev = rt.streamingEvents[0];
        expect(ev.type).toBe("action");
        expect(ev.title).toBe("Run");
        expect(ev.emissions[0].kind).toBe("terminal");
        expect(ev.emissions[0].commands).toBe("ls -la");
    });
});

describe("SessionRuntime — spawn chips", () => {
    it("tracks a clone from running to success", () => {
        const rt = new SessionRuntime("chat-test");
        rt.handleToken({
            type: "spawn",
            phase: "start",
            id: "0",
            inputsSummary: "research X",
        });
        expect(rt.liveSpawnChips).toHaveLength(1);
        expect(rt.liveSpawnChips[0].status).toBe("running");

        rt.handleToken({ type: "spawn", phase: "progress", id: "0", steps: 2 });
        expect(rt.liveSpawnChips[0].steps).toBe(2);

        rt.handleToken({
            type: "spawn",
            phase: "end",
            id: "0",
            status: "success",
            steps: 3,
            durationMs: 1234,
            resultSummary: "done",
        });
        expect(rt.liveSpawnChips[0].status).toBe("success");
        expect(rt.liveSpawnChips[0].resultSummary).toBe("done");
    });

    it("accumulates drill-down detail events across progress tokens", () => {
        const rt = new SessionRuntime("chat-test");
        rt.handleToken({
            type: "spawn",
            phase: "start",
            id: "0",
            inputsSummary: "research X",
            inputs: '{\n  "query": "research X"\n}',
        });
        expect(rt.liveSpawnChips[0].events).toEqual([]);
        expect(rt.liveSpawnChips[0].inputs).toContain("research X");

        const action = { type: "action", title: "search", emissions: [] };
        rt.handleToken({
            type: "spawn",
            phase: "progress",
            id: "0",
            steps: 1,
            events: [action],
        });
        // Output-only progress: no steps field — step count must hold.
        const output = { type: "output", message: "found", parts: [] };
        rt.handleToken({
            type: "spawn",
            phase: "progress",
            id: "0",
            events: [output],
        });
        expect(rt.liveSpawnChips[0].steps).toBe(1);
        expect(rt.liveSpawnChips[0].events).toEqual([action, output]);

        rt.handleToken({
            type: "spawn",
            phase: "end",
            id: "0",
            status: "success",
            steps: 1,
            durationMs: 10,
            resultSummary: "done",
            result: "done",
        });
        // End keeps the accumulated timeline and adds the full result.
        expect(rt.liveSpawnChips[0].events).toEqual([action, output]);
        expect(rt.liveSpawnChips[0].result).toBe("done");
    });
});

describe("SessionRuntime — rebuildStreamingMessages", () => {
    it("does not render an emission-less live turn as an empty activity card", () => {
        const rt = new SessionRuntime("chat-test");
        // Only narration in flight — the snapshot has no emissions, so
        // the live activity message should carry no events.
        rt.handleToken({
            type: "report",
            start: true,
            content: "thinking out loud",
            emission_index: 0,
        });
        const activity = rt.messages.find((m) => m.streaming && !m.isReport);
        expect(activity).toBeDefined();
        expect(activity.events).toHaveLength(0);
    });
});
