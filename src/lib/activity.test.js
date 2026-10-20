import { describe, expect, it } from "vitest";
import { groupPhrases, groupWork, outcome, resultLines, stepLine } from "./activity.js";

/** @param {string} name @param {Record<string, unknown>} args */
const tool = (name, args) => /** @type {const} */ ({ kind: "tool", name, args, result: "", isError: false, images: [] });

describe("step lines", () => {
    it("say what each tool did", () => {
        expect(stepLine(tool("run_ts", { code: "\n  const x = 1\nreturn x" }))).toEqual({ verb: "Ran code", subject: "const x = 1", code: true });
        expect(stepLine(tool("file_edit", { path: "app/main.js" }))).toEqual({ verb: "Edited", subject: "app/main.js", code: true });
        expect(stepLine(tool("test_app", { actions: [{}, {}], live: true })).subject).toBe("in the preview · 2 steps");
        expect(stepLine(tool("sessions", { action: "ask", name: "scout", task: "Find it.\nMore." }))).toEqual({ verb: "Asked scout", subject: "Find it.", code: false });
        expect(stepLine(tool("sessions", { action: "ask", resume: "scout", task: "Again" })).verb).toBe("Asked scout again");
        expect(stepLine(tool("mystery", {})).verb).toBe("Used mystery");
    });
});

describe("group lines", () => {
    it("count each kind in the order it first came, files once each", () => {
        const tools = [
            tool("run_ts", { code: "1" }),
            tool("file_write", { path: "a" }),
            tool("run_ts", { code: "2" }),
            tool("file_write", { path: "a" }),
            tool("file_write", { path: "b" }),
        ];
        expect(groupPhrases(tools)).toEqual([
            { verb: "Ran", rest: "code 2 times" },
            { verb: "wrote", rest: "2 files" },
        ]);
        expect(groupPhrases([tool("sessions", { action: "ask" }), tool("sessions", { action: "ask" })])).toEqual([{ verb: "Asked", rest: "2 delegates" }]);
    });
});

describe("grouping a turn", () => {
    const think = (/** @type {string} */ text) => /** @type {const} */ ({ kind: "thinking", text });
    const say = (/** @type {string} */ text) => /** @type {const} */ ({ kind: "text", text });

    it("gathers tools and the thinking around them, leaving prose alone", () => {
        const items = [think("plan"), tool("run_ts", {}), think("hm"), tool("terminal", {}), say("Done."), think("after")];
        expect(groupWork(items).map((g) => (g.kind === "work" ? g.entries.map((e) => e.kind) : g.kind))).toEqual([
            ["thinking", "tool", "thinking", "tool"],
            "text",
            "thinking",
        ]);
    });

    it("keeps thinking at a streaming turn's tail standing alone", () => {
        const items = [tool("run_ts", {}), think("now")];
        expect(groupWork(items).length).toBe(1);
        expect(groupWork(items, { streaming: true }).map((g) => g.kind)).toEqual(["work", "thinking"]);
    });
});

describe("how a call ended", () => {
    /** @param {string} name @param {string} result @param {boolean} isError */
    const ended = (name, result, isError) => ({ ...tool(name, {}), result, isError });
    const mixed = "name: media\n----\nls: cannot access '/workspace/app'\n[exit code 2]";

    it("tells a command that exited non-zero from one that failed", () => {
        expect(outcome(ended("terminal", "hi", false))).toEqual({ kind: "ok" });
        expect(outcome(ended("terminal", mixed, true))).toEqual({ kind: "exit", code: 2 });
        expect(outcome(ended("terminal", "[exit code 1]", true))).toEqual({ kind: "exit", code: 1 });
        expect(outcome(ended("terminal", "[exit code 2]\n[stderr]\nparse error: line 1: '&' runs in the background", true))).toEqual({ kind: "failed" });
        expect(outcome(ended("terminal", "[exit code 127]\n[stderr]\nnope: command not found", true))).toEqual({ kind: "failed" });
        expect(outcome(ended("terminal", "terminal: invalid arguments: command", true))).toEqual({ kind: "failed" });
        expect(outcome(ended("run_ts", "[error]\nTypeError: x", true))).toEqual({ kind: "failed" });
    });

    it("colours only the lines that say something went wrong", () => {
        expect(resultLines(ended("terminal", `${mixed}\n[stderr]\nls: cannot access '/workspace/app'`, true))).toEqual([
            { text: "name: media", tone: "plain" },
            { text: "----", tone: "plain" },
            { text: "ls: cannot access '/workspace/app'", tone: "plain" },
            { text: "[exit code 2]", tone: "warn" },
            { text: "[stderr]", tone: "mark" },
            { text: "ls: cannot access '/workspace/app'", tone: "warn" },
        ]);
        expect(resultLines(ended("run_ts", "started\n[error]\nTypeError: x\n[hint: check x]", true)).map((l) => l.tone)).toEqual([
            "plain",
            "mark",
            "bad",
            "mark",
        ]);
        expect(resultLines(ended("run_ts", "[returned]\n42", false)).map((l) => l.tone)).toEqual(["mark", "plain"]);
        expect(resultLines(ended("terminal", "lots\n[exit code 1]\n[stderr]\noops\n[output truncated]", true)).map((l) => l.tone)).toEqual([
            "plain",
            "warn",
            "mark",
            "warn",
            "mark",
        ]);
        // a failure with no marks is wholly the failure
        expect(resultLines(ended("file_edit", "edit failed: no match", true))).toEqual([{ text: "edit failed: no match", tone: "bad" }]);
    });

    it("reads the world's exit mark, not one the command printed", () => {
        const printed = "[exit code 0]\n[exit code 127]\nmore\n[exit code 1]\n[stderr]\nfalse: exited with code 1";
        expect(outcome(ended("terminal", printed, true))).toEqual({ kind: "exit", code: 1 });
        expect(resultLines(ended("terminal", printed, true)).map((l) => l.tone)).toEqual(["plain", "plain", "plain", "warn", "mark", "warn"]);
        // the world marks an exit only when the call errored
        expect(resultLines(ended("terminal", "[exit code 3]", false))).toEqual([{ text: "[exit code 3]", tone: "plain" }]);
    });
});
