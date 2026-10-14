import { describe, expect, it } from "vitest";
import { groupPhrases, groupWork, stepLine } from "./activity.js";

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
