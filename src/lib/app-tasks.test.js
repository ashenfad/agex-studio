import { describe, expect, it } from "vitest";
import { checkSpec } from "./app-tasks.svelte.js";

describe("an app's task spec", () => {
    it("takes a name, instructions, and JSON Schemas", () => {
        const spec = { name: "summarize", instructions: "Summarize it.", params: { text: { type: "string" } }, returns: { type: "string" } };
        expect(checkSpec(spec)).toBe(spec);
        expect(checkSpec({ name: "go", instructions: "Do it." })).toMatchObject({ name: "go" });
    });

    it("refuses what isn't one, naming what is wrong", () => {
        expect(() => checkSpec("summarize")).toThrow("give it { name, instructions, params, returns }");
        expect(() => checkSpec({ name: "two words", instructions: "x" })).toThrow("name is an identifier");
        expect(() => checkSpec({ name: "t", instructions: " " })).toThrow("agex.task t: say what to do");
        expect(() => checkSpec({ name: "t", instructions: "x", params: ["text"] })).toThrow("params map each input");
        expect(() => checkSpec({ name: "t", instructions: "x", params: { text: "string" } })).toThrow("params.text is a JSON Schema");
        expect(() => checkSpec({ name: "t", instructions: "x", returns: "string" })).toThrow("returns is a JSON Schema");
    });
});
