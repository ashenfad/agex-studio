/**
 * Round-trip checks for the agex-ts → shell-shape translator.
 *
 * The expected output dicts mirror what the py-side
 * `_synthesize_action` / `_split_output_events` /
 * `_serialize_emission` produce in `event_serialization.py`. If
 * those py-side helpers gain a new field or shape detail, this test
 * file is the place that surfaces the drift before it becomes a
 * runtime renderer mismatch.
 */

import { describe, it, expect } from "vitest";
import {
    serializeEmission,
    synthesizeAction,
    serializeOutputParts,
    splitOutputEvents,
    makeLiveTokenTranslator,
    serializeChapterEvents,
    serializeSpawnActionEvent,
    serializeSpawnChips,
    summarizeSpawnValue,
    spawnValueText,
} from "./ts-event-translator.js";
import { normalizeChatResponse } from "./ts-chat-response.js";

describe("serializeEmission", () => {
    it("translates TsEmission to kind='ts' with code/title/thinking", () => {
        const out = serializeEmission(
            {
                type: "ts",
                code: "console.log(1)",
                title: "log",
                thinking: "should be visible",
            },
            0,
        );
        expect(out).toEqual({
            kind: "ts",
            idx: 0,
            code: "console.log(1)",
            title: "log",
            thinking: "should be visible",
        });
    });

    it("translates TerminalEmission to kind='terminal'", () => {
        const out = serializeEmission(
            { type: "terminal", commands: "ls -la", title: "list" },
            2,
        );
        expect(out).toEqual({
            kind: "terminal",
            idx: 2,
            commands: "ls -la",
            title: "list",
            thinking: "",
        });
    });

    it("translates FileWriteEmission to snake_case kind='file_write'", () => {
        const out = serializeEmission(
            { type: "fileWrite", path: "a.ts", content: "x", mode: "write" },
            3,
        );
        expect(out).toEqual({
            kind: "file_write",
            idx: 3,
            path: "a.ts",
            content: "x",
            mode: "write",
        });
    });

    it("translates FileEditEmission, mapping matchAll → match_all", () => {
        const out = serializeEmission(
            {
                type: "fileEdit",
                path: "a.ts",
                search: "old",
                content: "new",
                matchAll: true,
            },
            4,
        );
        expect(out).toEqual({
            kind: "file_edit",
            idx: 4,
            path: "a.ts",
            search: "old",
            content: "new",
            match_all: true,
        });
    });

    it("defaults match_all to false when matchAll is missing", () => {
        const out = serializeEmission(
            { type: "fileEdit", path: "a.ts", search: "x", content: "y" },
            0,
        );
        expect(out.match_all).toBe(false);
    });

    it("translates TextEmission to kind='text'", () => {
        const out = serializeEmission({ type: "text", text: "hello" }, 1);
        expect(out).toEqual({ kind: "text", idx: 1, text: "hello" });
    });

    it("translates ThinkingEmission preserving redacted flag", () => {
        const out = serializeEmission(
            { type: "thinking", text: "...", redacted: true },
            0,
        );
        expect(out).toEqual({
            kind: "thinking",
            idx: 0,
            text: "...",
            redacted: true,
        });
    });

    it("returns null for unrecognized emission types", () => {
        expect(serializeEmission({ type: "unknown" }, 0)).toBeNull();
        expect(serializeEmission(null, 0)).toBeNull();
    });
});

describe("synthesizeAction", () => {
    it("produces the canonical action dict with first-title + report join", () => {
        const action = {
            type: "action",
            timestamp: "2026-05-08T12:00:00Z",
            agentName: "chat",
            inputTokens: 100,
            outputTokens: 50,
            emissions: [
                { type: "thinking", text: "let me consider..." },
                { type: "ts", code: "1 + 1", title: "math", thinking: "" },
                { type: "text", text: "I computed two." },
                { type: "ts", code: "2 + 2", title: "more math" },
                { type: "text", text: "And four." },
            ],
        };
        const out = synthesizeAction(action);
        expect(out.type).toBe("action");
        expect(out.title).toBe("math"); // first ts/terminal title wins
        expect(out.report).toBe("I computed two.\n\nAnd four.");
        expect(out.input_tokens).toBe(100);
        expect(out.output_tokens).toBe(50);
        // Text emissions are excluded from `emissions` — they render as
        // the report bubble (`out.report`), not as activity-card
        // sections. Only the thinking + two ts emissions remain, and
        // their `idx` values stay stable (gaps where text was).
        expect(out.emissions).toHaveLength(3);
        expect(out.emissions.every((em) => em.kind !== "text")).toBe(true);
        expect(out.emissions[0].kind).toBe("thinking");
        expect(out.emissions[0].idx).toBe(0);
        expect(out.emissions[1].kind).toBe("ts");
        expect(out.emissions[1].idx).toBe(1);
        expect(out.emissions[2].kind).toBe("ts");
        expect(out.emissions[2].idx).toBe(3);
    });

    it("keeps a text-only turn's report but yields no emissions", () => {
        const out = synthesizeAction({
            type: "action",
            emissions: [
                { type: "text", text: "Just narrating." },
                { type: "text", text: "Still narrating." },
            ],
        });
        expect(out.report).toBe("Just narrating.\n\nStill narrating.");
        expect(out.emissions).toHaveLength(0);
    });

    it("handles an empty emissions list", () => {
        const out = synthesizeAction({ type: "action", emissions: [] });
        expect(out).toEqual({
            type: "action",
            title: "",
            report: "",
            emissions: [],
            input_tokens: undefined,
            output_tokens: undefined,
        });
    });

    it("uses terminal-emission title when no ts-emission title comes first", () => {
        const out = synthesizeAction({
            type: "action",
            emissions: [
                { type: "terminal", commands: "echo hi", title: "say hi" },
            ],
        });
        expect(out.title).toBe("say hi");
    });

    it("skips emissions without a title when picking the action title", () => {
        const out = synthesizeAction({
            type: "action",
            emissions: [
                { type: "ts", code: "1", title: "" }, // no title
                { type: "ts", code: "2", title: "second" },
            ],
        });
        expect(out.title).toBe("second");
    });
});

describe("serializeOutputParts", () => {
    it("translates text parts to {type:'text', content}", () => {
        const out = serializeOutputParts({
            type: "output",
            parts: [{ type: "text", text: "stdout line" }],
        });
        expect(out).toEqual([{ type: "text", content: "stdout line" }]);
    });

    it("translates image parts preserving format and altText", () => {
        const out = serializeOutputParts({
            type: "output",
            parts: [
                {
                    type: "image",
                    format: "png",
                    data: "base64...",
                    altText: "a chart",
                },
            ],
        });
        expect(out).toEqual([
            {
                type: "image",
                data: "base64...",
                format: "png",
                altText: "a chart",
            },
        ]);
    });

    it("omits format/altText when not provided", () => {
        const out = serializeOutputParts({
            type: "output",
            parts: [{ type: "image", data: "bare" }],
        });
        expect(out).toEqual([{ type: "image", data: "bare" }]);
    });

    it("returns empty list for OutputEvent with no parts", () => {
        expect(serializeOutputParts({ type: "output", parts: [] })).toEqual([]);
        expect(serializeOutputParts({ type: "output" })).toEqual([]);
    });

    it("translates error parts to {type:'error', content:'<name>: <message>'}", () => {
        const out = serializeOutputParts({
            type: "output",
            parts: [
                {
                    type: "error",
                    errorName: "ReferenceError",
                    errorMessage: "inputs is not defined",
                },
            ],
        });
        expect(out).toEqual([
            {
                type: "error",
                content: "ReferenceError: inputs is not defined",
            },
        ]);
    });

    it("error part falls back to message when errorName missing", () => {
        const out = serializeOutputParts({
            type: "output",
            parts: [{ type: "error", errorMessage: "boom" }],
        });
        expect(out).toEqual([{ type: "error", content: "boom" }]);
    });
});

describe("splitOutputEvents", () => {
    it("wraps text parts in a single output event with newline-joined message", () => {
        const out = splitOutputEvents([
            { type: "text", content: "line one" },
            { type: "text", content: "line two" },
        ]);
        expect(out).toEqual([
            {
                type: "output",
                message: "line one\nline two",
                parts: [
                    { type: "text", content: "line one" },
                    { type: "text", content: "line two" },
                ],
            },
        ]);
    });

    it("produces an empty-message output event for image-only parts", () => {
        // Images contribute no `content`, so the joined message ends up empty.
        // The shell renders the parts list directly; the message field is a
        // legacy summary string.
        const out = splitOutputEvents([
            { type: "image", data: "x" },
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].type).toBe("output");
        expect(out[0].message).toBe("");
        expect(out[0].parts).toHaveLength(1);
    });

    it("returns a single empty event for an empty parts list", () => {
        expect(splitOutputEvents([])).toEqual([
            { type: "output", message: "", parts: [] },
        ]);
    });

    it("splits mixed parts into separate output and error events", () => {
        const out = splitOutputEvents([
            { type: "text", content: "before throw" },
            { type: "error", content: "TypeError: nope" },
        ]);
        expect(out).toHaveLength(2);
        expect(out[0]).toEqual({
            type: "output",
            message: "before throw",
            parts: [{ type: "text", content: "before throw" }],
        });
        expect(out[1]).toEqual({
            type: "error",
            message: "TypeError: nope",
            parts: [{ type: "error", content: "TypeError: nope" }],
        });
    });

    it("error-only parts produce a single error event (no empty output)", () => {
        const out = splitOutputEvents([
            { type: "error", content: "ReferenceError: x" },
        ]);
        expect(out).toEqual([
            {
                type: "error",
                message: "ReferenceError: x",
                parts: [{ type: "error", content: "ReferenceError: x" }],
            },
        ]);
    });
});

describe("makeLiveTokenTranslator", () => {
    function chunk(type, content, emissionIndex = 0, done = false) {
        return { type, content, emissionIndex, done };
    }

    it("renames title/thinking/terminal preserving content/index/done", () => {
        const t = makeLiveTokenTranslator();
        expect(t.translate(chunk("title", "do thing", 0, false))).toEqual([
            { type: "title", content: "do thing", emission_index: 0, done: false },
        ]);
        expect(t.translate(chunk("thinking", "...", 1, true))).toEqual([
            { type: "thinking", content: "...", emission_index: 1, done: true },
        ]);
        expect(t.translate(chunk("terminal", "ls", 2, false))).toEqual([
            { type: "terminal", content: "ls", emission_index: 2, done: false },
        ]);
    });

    it("flags the first 'text' chunk per emission with start: true", () => {
        const t = makeLiveTokenTranslator();
        const first = t.translate(chunk("text", "hel", 0));
        const second = t.translate(chunk("text", "lo", 0));
        expect(first[0]).toMatchObject({
            type: "report",
            content: "hel",
            emission_index: 0,
            start: true,
        });
        expect(second[0]).toMatchObject({
            type: "report",
            content: "lo",
            emission_index: 0,
            start: false,
        });
    });

    it("tracks the start flag separately per emission_index", () => {
        const t = makeLiveTokenTranslator();
        t.translate(chunk("text", "a", 0));
        const firstOnIdx1 = t.translate(chunk("text", "x", 1));
        expect(firstOnIdx1[0].start).toBe(true);
    });

    it("translates 'ts' code chunks to type='ts' (not 'python')", () => {
        // Justification: parallels the per-emission `kind: 'ts'`
        // extension. The shell's handleToken has a matching branch.
        const t = makeLiveTokenTranslator();
        expect(t.translate(chunk("ts", "1+1", 0))[0]).toMatchObject({
            type: "ts",
            content: "1+1",
            emission_index: 0,
        });
    });

    it("renames camelCase file types to snake_case shell types", () => {
        const t = makeLiveTokenTranslator();
        expect(t.translate(chunk("filePath", "/a.ts", 0))[0].type).toBe("file_path");
        expect(t.translate(chunk("fileSearch", "x", 0))[0].type).toBe("file_search");
        expect(t.translate(chunk("fileContent", "y", 0))[0].type).toBe("file_content");
    });

    it("drops emission/signature/toolStart and unknown types", () => {
        const t = makeLiveTokenTranslator();
        expect(t.translate(chunk("emission", "", 0, true))).toEqual([]);
        expect(t.translate(chunk("signature", "blob", 0))).toEqual([]);
        expect(t.translate(chunk("toolStart", "", 0))).toEqual([]);
        expect(t.translate(chunk("unknown", "", 0))).toEqual([]);
    });

    it("turnComplete returns a single 'turn_complete' token and resets state", () => {
        const t = makeLiveTokenTranslator();
        t.translate(chunk("text", "a", 0)); // marks emission 0 started
        const flush = t.turnComplete();
        expect(flush).toEqual([{ type: "turn_complete" }]);
        // After flushing, a new 'text' chunk for emission 0 should
        // again be flagged as the first.
        const next = t.translate(chunk("text", "b", 0));
        expect(next[0].start).toBe(true);
    });

    it("ignores null / non-object chunks", () => {
        const t = makeLiveTokenTranslator();
        expect(t.translate(null)).toEqual([]);
        expect(t.translate(undefined)).toEqual([]);
        expect(t.translate("string")).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// serializeChapterEvents — covers what was previously only validated against
// py's `_serialize_chapter_events`. Each case below mirrors a scenario that
// loadHistory's `_doFlatten` + main walk can hit when rendering a real
// session's chaptering output.
// ---------------------------------------------------------------------------

/** Build a `(stateKey) => Promise<event | null>` from a plain object
 *  map. Test fixture stand-in for agex-ts `EventLog.byKey`. */
function makeResolver(map) {
    return async (key) => (key in map ? map[key] : null);
}

describe("serializeChapterEvents", () => {
    it("returns [] for empty refs", async () => {
        const out = await serializeChapterEvents(
            [],
            makeResolver({}),
            normalizeChatResponse,
        );
        expect(out).toEqual([]);
    });

    it("skips refs that resolve to null (missing key, defensive)", async () => {
        const out = await serializeChapterEvents(
            ["missing", "also-missing"],
            makeResolver({}),
            normalizeChatResponse,
        );
        expect(out).toEqual([]);
    });

    it("emits action/output/task_start/success in order", async () => {
        const refs = ["k1", "k2", "k3", "k4"];
        const map = {
            k1: {
                type: "taskStart",
                taskName: "chat",
                inputs: { message: "hi" },
            },
            k2: {
                type: "action",
                emissions: [{ type: "text", text: "hello" }],
                inputTokens: 100,
                outputTokens: 50,
            },
            k3: {
                type: "output",
                parts: [{ type: "text", content: "ok" }],
            },
            k4: { type: "success", result: "done" },
        };
        const out = await serializeChapterEvents(
            refs,
            makeResolver(map),
            normalizeChatResponse,
        );
        expect(out.map((x) => x.type)).toEqual([
            "task_start",
            "action",
            "output",
            "success",
        ]);
        expect(out[0]).toEqual({ type: "task_start", message: "hi" });
        // Success carries the normalized result shape consumers expect.
        expect(out[3].result).toEqual({ type: "text", content: "done" });
    });

    it("recursively serializes a nested chapter via eventRefs", async () => {
        const map = {
            // Top-level chapter contains one nested chapter, which
            // itself contains one action.
            outer: {
                type: "chapter",
                name: "outer",
                message: "outer chapter",
                eventRefs: ["inner"],
            },
            inner: {
                type: "chapter",
                name: "inner",
                message: "inner chapter",
                eventRefs: ["leaf"],
            },
            leaf: {
                type: "action",
                emissions: [{ type: "text", text: "leaf-emission" }],
                inputTokens: 1,
                outputTokens: 1,
            },
        };
        const out = await serializeChapterEvents(
            ["outer"],
            makeResolver(map),
            normalizeChatResponse,
        );
        // Outer chapter entry should carry the nested chapter as
        // its inner event; the nested chapter should carry the leaf
        // action in turn.
        expect(out).toHaveLength(1);
        expect(out[0].type).toBe("chapter");
        expect(out[0].name).toBe("outer");
        expect(out[0].events).toHaveLength(1);
        expect(out[0].events[0].type).toBe("chapter");
        expect(out[0].events[0].name).toBe("inner");
        expect(out[0].events[0].events).toHaveLength(1);
        expect(out[0].events[0].events[0].type).toBe("action");
    });

    it("attaches __chapter__ chapters via the unassigned queue", async () => {
        // Simulates a chaptering sub-task lifecycle inside a chapter:
        // a `__chapter__` taskStart, two nested chapters, then a
        // success returning two Chapter records. The success branch
        // should attach the two unassigned chapters into the
        // preceding `{type:'chaptering'}` band.
        const map = {
            ch1: {
                type: "chapter",
                name: "ch1",
                message: "first",
                eventRefs: [],
            },
            ch2: {
                type: "chapter",
                name: "ch2",
                message: "second",
                eventRefs: [],
            },
        };
        const refs = ["ts", "ch1ref", "ch2ref", "succ"];
        const resolver = async (key) => {
            switch (key) {
                case "ts":
                    return { type: "taskStart", taskName: "__chapter__" };
                case "ch1ref":
                    return map.ch1;
                case "ch2ref":
                    return map.ch2;
                case "succ":
                    return {
                        type: "success",
                        result: [
                            { name: "ch1", message: "first" },
                            { name: "ch2", message: "second" },
                        ],
                    };
                default:
                    return null;
            }
        };
        const out = await serializeChapterEvents(
            refs,
            resolver,
            normalizeChatResponse,
        );
        // The walk should produce:
        //   - {type: 'chaptering', chapters: [ch1, ch2]}
        //   - {type: 'chapter', name: 'ch1', ...} (still in result)
        //   - {type: 'chapter', name: 'ch2', ...} (still in result)
        // (The chapter entries remain in `result` after assignment;
        //  that mirrors py — `_serialize_chapter_events` mutates the
        //  `chaptering` block's `chapters` but doesn't remove the
        //  per-chapter `{type:'chapter'}` entries from the surrounding
        //  list.)
        const chapteringBand = out.find((x) => x.type === "chaptering");
        expect(chapteringBand).toBeDefined();
        expect(chapteringBand.chapters).toHaveLength(2);
        expect(chapteringBand.chapters[0].name).toBe("ch1");
        expect(chapteringBand.chapters[1].name).toBe("ch2");
    });

    it("survives a __chapter__ success without enough unassigned entries", async () => {
        // Defensive: result claims 3 chapters but only 1 chapter
        // event preceded. Should not throw; chaptering band's
        // chapters array should hold what's available.
        const resolver = async (key) => {
            switch (key) {
                case "ts":
                    return { type: "taskStart", taskName: "__chapter__" };
                case "ch":
                    return {
                        type: "chapter",
                        name: "only",
                        message: "only",
                        eventRefs: [],
                    };
                case "succ":
                    return {
                        type: "success",
                        result: [
                            { name: "a" },
                            { name: "b" },
                            { name: "c" },
                        ],
                    };
                default:
                    return null;
            }
        };
        const out = await serializeChapterEvents(
            ["ts", "ch", "succ"],
            resolver,
            normalizeChatResponse,
        );
        const band = out.find((x) => x.type === "chaptering");
        expect(band.chapters).toHaveLength(1);
        expect(band.chapters[0].name).toBe("only");
    });

    it("interleaves spawn chips after the action that spawned them", async () => {
        const resolver = makeResolver({
            ts: { type: "taskStart", taskName: "chat", inputs: "fan out" },
            a1: {
                type: "action",
                timestamp: "2026-06-09T00:00:01.000Z",
                emissions: [{ type: "ts", code: "spawn(...)", title: "a1" }],
            },
            a2: {
                type: "action",
                timestamp: "2026-06-09T00:00:05.000Z",
                emissions: [{ type: "ts", code: "wrapUp()", title: "a2" }],
            },
            succ: {
                type: "success",
                result: "done",
                spawnEvents: [
                    {
                        spawnIndex: 0,
                        events: [
                            {
                                type: "taskStart",
                                inputs: "subtask",
                                // Started during a1's execution.
                                timestamp: "2026-06-09T00:00:02.000Z",
                            },
                            {
                                type: "action",
                                emissions: [
                                    { type: "ts", code: "1+1", title: "t" },
                                ],
                            },
                            { type: "success", result: "2" },
                        ],
                    },
                ],
            },
        });
        const out = await serializeChapterEvents(
            ["ts", "a1", "a2", "succ"],
            resolver,
            normalizeChatResponse,
        );
        // Chip lands between the spawning action (a1) and the next
        // (a2), not at the end of the activity.
        expect(out.map((x) => (x.type === "action" ? x.title : x.type))).toEqual([
            "task_start",
            "a1",
            "spawn",
            "a2",
            "success",
        ]);
        expect(out[2].status).toBe("success");
        expect(out[2].events).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------

describe("synthesizeAction ts stamp", () => {
    it("stamps epoch-ms ts from the event timestamp", () => {
        const out = synthesizeAction({
            type: "action",
            timestamp: "2026-06-09T00:00:01.000Z",
            emissions: [{ type: "ts", code: "f()" }],
        });
        expect(out.ts).toBe(Date.parse("2026-06-09T00:00:01.000Z"));
    });

    it("omits ts when the event has no timestamp", () => {
        const out = synthesizeAction({
            type: "action",
            emissions: [{ type: "ts", code: "f()" }],
        });
        expect("ts" in out).toBe(false);
    });
});

describe("spawn value helpers", () => {
    it("summarizeSpawnValue collapses whitespace and truncates", () => {
        expect(summarizeSpawnValue("a\n  b   c")).toBe("a b c");
        const long = "x".repeat(100);
        const out = summarizeSpawnValue(long);
        expect(out).toHaveLength(60);
        expect(out.endsWith("…")).toBe(true);
        expect(summarizeSpawnValue({ q: "hi" })).toBe('{"q":"hi"}');
        expect(summarizeSpawnValue(undefined)).toBe("");
    });

    it("spawnValueText keeps strings verbatim and pretty-prints objects", () => {
        expect(spawnValueText("a\nb")).toBe("a\nb");
        expect(spawnValueText({ q: "hi" })).toBe('{\n  "q": "hi"\n}');
        expect(spawnValueText(undefined)).toBe("");
    });
});

describe("serializeSpawnActionEvent", () => {
    it("keeps text emissions inline (no report extraction)", () => {
        const out = serializeSpawnActionEvent({
            type: "action",
            emissions: [
                { type: "text", text: "narrating" },
                { type: "ts", code: "f()", title: "call f" },
            ],
        });
        expect(out.type).toBe("action");
        expect(out.title).toBe("call f");
        expect(out.emissions.map((e) => e.kind)).toEqual(["text", "ts"]);
        expect(out.emissions[0].text).toBe("narrating");
    });
});

describe("serializeSpawnChips", () => {
    const t0 = "2026-06-09T00:00:00.000Z";
    const t1 = "2026-06-09T00:00:02.500Z";

    it("reconstructs a successful clone's chip with detail timeline", () => {
        const chips = serializeSpawnChips([
            {
                spawnIndex: 0,
                events: [
                    {
                        type: "taskStart",
                        inputs: { query: "research X" },
                        timestamp: t0,
                    },
                    {
                        type: "action",
                        emissions: [
                            { type: "ts", code: "search()", title: "search" },
                        ],
                    },
                    {
                        type: "output",
                        parts: [{ type: "text", text: "found it" }],
                    },
                    { type: "success", result: "the answer", timestamp: t1 },
                ],
            },
        ]);
        expect(chips).toHaveLength(1);
        const chip = chips[0];
        expect(chip.type).toBe("spawn");
        expect(chip.id).toBe("0");
        expect(chip.status).toBe("success");
        expect(chip.steps).toBe(1);
        expect(chip.startedAt).toBe(Date.parse(t0));
        expect(chip.durationMs).toBe(2500);
        expect(chip.inputsSummary).toBe('{"query":"research X"}');
        expect(chip.inputs).toContain('"query": "research X"');
        expect(chip.resultSummary).toBe("the answer");
        expect(chip.result).toBe("the answer");
        expect(chip.events.map((e) => e.type)).toEqual(["action", "output"]);
        expect(chip.events[0].emissions[0].code).toBe("search()");
        expect(chip.events[1].parts[0].content).toBe("found it");
    });

    it("reconstructs fail and missing-terminal (→ cancelled) clones", () => {
        const chips = serializeSpawnChips([
            {
                spawnIndex: 1,
                events: [
                    { type: "taskStart", inputs: "a", timestamp: t0 },
                    { type: "fail", message: "boom", timestamp: t1 },
                ],
            },
            {
                // Parent cancelled mid-spawn — clone bucket has no
                // terminal event. Nothing is running on reload, so the
                // chip reconstructs as cancelled.
                spawnIndex: 2,
                events: [{ type: "taskStart", inputs: "b", timestamp: t0 }],
            },
        ]);
        expect(chips[0].status).toBe("fail");
        expect(chips[0].error).toBe("boom");
        expect(chips[0].durationMs).toBe(2500);
        expect(chips[1].status).toBe("cancelled");
        expect(chips[1].durationMs).toBeUndefined();
    });

    it("splits mixed clone output into output + error detail events", () => {
        const chips = serializeSpawnChips([
            {
                spawnIndex: 0,
                events: [
                    { type: "taskStart", inputs: "x" },
                    {
                        type: "output",
                        parts: [
                            { type: "text", text: "partial" },
                            {
                                type: "error",
                                errorName: "TypeError",
                                errorMessage: "nope",
                            },
                        ],
                    },
                    { type: "cancelled" },
                ],
            },
        ]);
        expect(chips[0].events.map((e) => e.type)).toEqual([
            "output",
            "error",
        ]);
        expect(chips[0].events[1].message).toBe("TypeError: nope");
    });

    it("returns [] for empty/absent input", () => {
        expect(serializeSpawnChips([])).toEqual([]);
        expect(serializeSpawnChips(undefined)).toEqual([]);
    });
});
