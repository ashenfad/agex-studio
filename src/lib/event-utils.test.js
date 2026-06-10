import { describe, it, expect } from "vitest";
import {
    trim,
    computeDiff,
    truncateText,
    deriveTitle,
    segmentParts,
    groupEventsForChat,
    hasOutputEvents,
    interleaveSpawnChips,
} from "./event-utils.js";

describe("trim", () => {
    it("removes leading and trailing newlines", () => {
        expect(trim("\n\nhello\n\n")).toBe("hello");
    });

    it("preserves internal newlines", () => {
        expect(trim("\na\nb\n")).toBe("a\nb");
    });

    it("handles empty string", () => {
        expect(trim("")).toBe("");
    });

    it("handles null/undefined", () => {
        expect(trim(null)).toBe("");
        expect(trim(undefined)).toBe("");
    });

    it("returns unchanged text with no surrounding newlines", () => {
        expect(trim("hello")).toBe("hello");
    });
});

describe("computeDiff", () => {
    it("returns removed + added lines for replace", () => {
        const result = computeDiff("old line", "new line", "replace");
        expect(result).toEqual([
            { type: "removed", text: "old line" },
            { type: "added", text: "new line" },
        ]);
    });

    it("returns context + added lines for insert-after", () => {
        const result = computeDiff("anchor", "inserted", "insert-after");
        expect(result).toEqual([
            { type: "context", text: "anchor" },
            { type: "added", text: "inserted" },
        ]);
    });

    it("returns added + context lines for insert-before", () => {
        const result = computeDiff("anchor", "inserted", "insert-before");
        expect(result).toEqual([
            { type: "added", text: "inserted" },
            { type: "context", text: "anchor" },
        ]);
    });

    it("handles multiline inputs", () => {
        const result = computeDiff("a\nb", "c\nd", "replace");
        expect(result).toEqual([
            { type: "removed", text: "a" },
            { type: "removed", text: "b" },
            { type: "added", text: "c" },
            { type: "added", text: "d" },
        ]);
    });

    it("trims surrounding newlines from inputs", () => {
        const result = computeDiff("\nold\n", "\nnew\n", "replace");
        expect(result).toEqual([
            { type: "removed", text: "old" },
            { type: "added", text: "new" },
        ]);
    });

    it("returns empty array for unknown operation", () => {
        expect(computeDiff("a", "b", "unknown")).toEqual([]);
    });

    // The smart-diff path: when search and content share lines, those
    // lines render as ``context`` instead of being shown twice.

    it("renders shared lines as context for replace", () => {
        // Edit changes only the middle line of a 3-line anchor.
        const result = computeDiff(
            "def foo():\n    return 42\n\nx = 1",
            "def foo():\n    return 43\n\nx = 1",
            "replace",
        );
        expect(result).toEqual([
            { type: "context", text: "def foo():" },
            { type: "removed", text: "    return 42" },
            { type: "added", text: "    return 43" },
            { type: "context", text: "" },
            { type: "context", text: "x = 1" },
        ]);
    });

    it("renders pure additions inside a shared block", () => {
        // Edit inserts a new line into a function body.
        const result = computeDiff(
            "def foo():\n    return 42",
            "def foo():\n    print('hi')\n    return 42",
            "replace",
        );
        expect(result).toEqual([
            { type: "context", text: "def foo():" },
            { type: "added", text: "    print('hi')" },
            { type: "context", text: "    return 42" },
        ]);
    });

    it("renders pure deletions inside a shared block", () => {
        const result = computeDiff(
            "def foo():\n    print('hi')\n    return 42",
            "def foo():\n    return 42",
            "replace",
        );
        expect(result).toEqual([
            { type: "context", text: "def foo():" },
            { type: "removed", text: "    print('hi')" },
            { type: "context", text: "    return 42" },
        ]);
    });

    it("falls back to full removed+added when no lines are shared", () => {
        // Existing test pattern: completely different content stays as
        // removed-then-added with no spurious context.
        const result = computeDiff("a\nb", "c\nd", "replace");
        expect(result).toEqual([
            { type: "removed", text: "a" },
            { type: "removed", text: "b" },
            { type: "added", text: "c" },
            { type: "added", text: "d" },
        ]);
    });

    it("renders identical search and content as all context", () => {
        // Edge case: a no-op replace.  Won't usually reach the renderer
        // (apply_file_edit short-circuits and emits a SystemNoteEvent
        // instead), but the diff should still degrade cleanly.
        const result = computeDiff("hello\nworld", "hello\nworld", "replace");
        expect(result).toEqual([
            { type: "context", text: "hello" },
            { type: "context", text: "world" },
        ]);
    });
});

describe("truncateText", () => {
    it("returns short text unchanged", () => {
        const result = truncateText("hello");
        expect(result).toEqual({ display: "hello", truncated: false });
    });

    it("returns non-string input unchanged", () => {
        const obj = { foo: 1 };
        expect(truncateText(obj)).toEqual({ display: obj, truncated: false });
        expect(truncateText(42)).toEqual({ display: 42, truncated: false });
    });

    it("truncates text with more than 8 lines", () => {
        const lines = Array.from({ length: 12 }, (_, i) => `line ${i}`);
        const result = truncateText(lines.join("\n"));
        expect(result.truncated).toBe(true);
        expect(result.display).toContain("line 0");
        expect(result.display).toContain("line 7");
        expect(result.display).not.toContain("line 8");
        expect(result.display.endsWith("…")).toBe(true);
    });

    it("truncates text over 500 chars", () => {
        const long = "x".repeat(600);
        const result = truncateText(long);
        expect(result.truncated).toBe(true);
        expect(result.display.length).toBe(501); // 500 + ellipsis
    });

    it("does not truncate text at exactly 8 lines and <= 500 chars", () => {
        const lines = Array.from({ length: 8 }, (_, i) => `line ${i}`);
        const result = truncateText(lines.join("\n"));
        expect(result.truncated).toBe(false);
    });
});

describe("deriveTitle", () => {
    it("returns the last action title", () => {
        const events = [
            { type: "action", title: "First" },
            { type: "output" },
            { type: "action", title: "Last" },
        ];
        expect(deriveTitle(events)).toBe("Last");
    });

    it("skips actions without titles", () => {
        const events = [
            { type: "action", title: "Good" },
            { type: "action" },
        ];
        expect(deriveTitle(events)).toBe("Good");
    });

    it("returns 'Activity' when no action has a title", () => {
        expect(deriveTitle([{ type: "output" }])).toBe("Activity");
        expect(deriveTitle([])).toBe("Activity");
    });
});

describe("segmentParts", () => {
    it("wraps non-response content as single text segment", () => {
        const result = segmentParts({ type: "text", content: "hello" });
        expect(result).toEqual([{ kind: "text", content: "hello" }]);
    });

    it("handles null content", () => {
        expect(segmentParts(null)).toEqual([{ kind: "text", content: "" }]);
    });

    it("merges consecutive text parts", () => {
        const content = {
            type: "response",
            parts: [
                { type: "text", content: "a" },
                { type: "text", content: "b" },
            ],
        };
        const result = segmentParts(content);
        expect(result).toEqual([{ kind: "text", content: "a\n\nb" }]);
    });

    it("separates rich parts from text", () => {
        const df = { type: "dataframe", columns: [], rows: [] };
        const content = {
            type: "response",
            parts: [
                { type: "text", content: "before" },
                df,
                { type: "text", content: "after" },
            ],
        };
        const result = segmentParts(content);
        expect(result).toHaveLength(3);
        expect(result[0]).toEqual({ kind: "text", content: "before" });
        expect(result[1]).toEqual({ kind: "dataframe", data: df });
        expect(result[2]).toEqual({ kind: "text", content: "after" });
    });

    it("handles all-rich parts with no text", () => {
        const content = {
            type: "response",
            parts: [{ type: "plotly", figure: {} }],
        };
        const result = segmentParts(content);
        expect(result).toHaveLength(1);
        expect(result[0].kind).toBe("plotly");
    });
});

describe("groupEventsForChat", () => {
    it("groups task_start as user message", () => {
        const events = [{ type: "task_start", message: "Hello" }];
        const result = groupEventsForChat(events);
        expect(result).toEqual([{ kind: "user", message: "Hello" }]);
    });

    it("groups success as agent message", () => {
        const result = { type: "response", content: "Done" };
        const events = [{ type: "success", result }];
        const groups = groupEventsForChat(events);
        expect(groups).toEqual([{ kind: "agent", content: result }]);
    });

    it("groups chapter events", () => {
        const events = [
            { type: "chapter", name: "Ch1", message: "Summary", events: [] },
        ];
        const groups = groupEventsForChat(events);
        expect(groups).toEqual([
            { kind: "chapter", name: "Ch1", message: "Summary", events: [] },
        ]);
    });

    it("groups chaptering events", () => {
        const events = [{ type: "chaptering", chapters: [{ name: "A" }] }];
        const groups = groupEventsForChat(events);
        expect(groups).toEqual([
            { kind: "chaptering", chapters: [{ name: "A" }] },
        ]);
    });

    it("accumulates action/output into activity groups", () => {
        const events = [
            { type: "action", title: "Do thing" },
            { type: "output", content: "result" },
        ];
        const groups = groupEventsForChat(events);
        expect(groups).toHaveLength(1);
        expect(groups[0].kind).toBe("activity");
        expect(groups[0].events).toHaveLength(2);
    });

    it("flushes activity buffer before non-activity events", () => {
        const events = [
            { type: "action", title: "Work" },
            { type: "task_start", message: "Next" },
            { type: "action", title: "More" },
        ];
        const groups = groupEventsForChat(events);
        expect(groups).toHaveLength(3);
        expect(groups[0].kind).toBe("activity");
        expect(groups[1].kind).toBe("user");
        expect(groups[2].kind).toBe("activity");
    });

    it("surfaces an action's report as its own bubble before its activity", () => {
        const events = [
            {
                type: "action",
                report: "Narrating the plan.",
                emissions: [{ kind: "ts", idx: 0, code: "1 + 1" }],
            },
        ];
        const groups = groupEventsForChat(events);
        expect(groups).toHaveLength(2);
        expect(groups[0]).toEqual({
            kind: "report",
            content: "Narrating the plan.",
        });
        expect(groups[1].kind).toBe("activity");
        expect(groups[1].events).toHaveLength(1);
    });

    it("a pure-narration action yields only a report bubble, no activity", () => {
        const events = [
            { type: "action", report: "Just thinking out loud.", emissions: [] },
        ];
        const groups = groupEventsForChat(events);
        expect(groups).toEqual([
            { kind: "report", content: "Just thinking out loud." },
        ]);
    });

    it("returns empty array for empty events", () => {
        expect(groupEventsForChat([])).toEqual([]);
    });
});

describe("interleaveSpawnChips", () => {
    const action = (ts, title) => ({ type: "action", ts, title });
    const output = (msg) => ({ type: "output", message: msg });
    const chip = (id, startedAt) => ({ type: "spawn", id, startedAt });

    it("slots a chip after the action that spawned it (and its output)", () => {
        // Spawn started at t=15, during action@10's execution. Its
        // output (no ts) flushes in input order; the chip lands before
        // the next action@20.
        const merged = interleaveSpawnChips(
            [action(10, "a"), output("o1"), action(20, "b"), output("o2")],
            [chip("0", 15)],
        );
        expect(merged.map((e) => e.type)).toEqual([
            "action",
            "output",
            "spawn",
            "action",
            "output",
        ]);
    });

    it("keeps concurrent chips in startedAt order at the same slot", () => {
        const merged = interleaveSpawnChips(
            [action(10, "a"), action(30, "b")],
            [chip("1", 16), chip("0", 14)],
        );
        expect(merged.map((e) => e.id ?? e.title)).toEqual([
            "a",
            "0",
            "1",
            "b",
        ]);
    });

    it("appends chips with no startedAt (and after ts-less events) at the end", () => {
        const merged = interleaveSpawnChips(
            [action(10, "a"), { type: "cancelled" }],
            [chip("0", undefined)],
        );
        expect(merged.map((e) => e.type)).toEqual([
            "action",
            "cancelled",
            "spawn",
        ]);
    });

    it("appends chips that started after every event", () => {
        const merged = interleaveSpawnChips([action(10, "a")], [chip("0", 99)]);
        expect(merged.map((e) => e.type)).toEqual(["action", "spawn"]);
    });

    it("no chips → copy of events", () => {
        const events = [action(10, "a")];
        const merged = interleaveSpawnChips(events, []);
        expect(merged).toEqual(events);
        expect(merged).not.toBe(events);
    });
});

describe("hasOutputEvents", () => {
    it("finds top-level output events", () => {
        expect(hasOutputEvents([{ type: "action" }, { type: "output" }])).toBe(
            true,
        );
    });

    it("finds output nested in a spawn chip's drill-down", () => {
        const events = [
            { type: "action" },
            { type: "spawn", id: "0", events: [{ type: "output" }] },
        ];
        expect(hasOutputEvents(events)).toBe(true);
    });

    it("false when neither level has output (incl. eventless chips)", () => {
        const events = [
            { type: "action" },
            { type: "spawn", id: "0", events: [{ type: "action" }] },
            { type: "spawn", id: "1" },
        ];
        expect(hasOutputEvents(events)).toBe(false);
    });
});
