import { Memory } from "@agex-ts/kvgit/backends/memory";
import { Store } from "@agex-ts/world";
import { Agent, ScriptedProvider } from "agex-ts";
import { describe, expect, it } from "vitest";
import { StudioRunner, openings, turnSoFar } from "./delegation.svelte.js";

describe("a delegate's agent", () => {
    it("is built for the delegate's own session, which names its model's affinity key", async () => {
        const store = await Store.open(new Memory());
        const ws = await store.open("main");
        /** @type {unknown[]} */
        const asked = [];
        const runner = new StudioRunner(ws, {
            agent: (opts) => {
                asked.push(opts);
                const done = { kind: "model", text: "done", thinking: "", tool_calls: [], fail: "", input_tokens: 0 };
                return new Agent({ model: new ScriptedProvider([/** @type {any} */ (done)]) });
            },
            tools: () => [],
            observe: () => undefined,
            toolOptions: () => ({ vision: false, codePrimer: "" }),
        });
        expect(await runner.run("main.scout", "look around", { signal: new AbortController().signal })).toBe("done");
        expect(asked).toEqual([{ delegate: true, session: "main.scout" }]);
        await ws.close();
    });
});

describe("a delegate's turn as it runs", () => {
    it("is kept, each event before the view open on it gets it, and dropped when the turn ends", async () => {
        const store = await Store.open(new Memory());
        const ws = await store.open("main");
        const step = (/** @type {Record<string, unknown>} */ o) => ({ kind: "model", text: "", thinking: "", tool_calls: [], fail: "", input_tokens: 0, ...o });
        const steps = [step({ thinking: "Look.", text: "Looking.", tool_calls: [{ name: "terminal", args: { command: "echo hi" } }] }), step({ text: "done" })];
        /** @type {string[]} */
        const late = [];
        /** @type {string[]} */
        let kept = [];
        /** What a view opened once the turn ended would find to replay. @type {unknown[]} */
        const after = [];
        const runner = new StudioRunner(ws, {
            agent: () => new Agent({ model: new ScriptedProvider(/** @type {any} */ (steps)) }),
            tools: () => [],
            observe: () => ({
                begin: () => undefined,
                opened: () => undefined,
                observe: (event) => {
                    // what a view opened now would replay ends with this event
                    const last = turnSoFar["main.scout"]?.at(-1);
                    if (last?.kind !== event.kind || ("text" in event && !(/** @type {any} */ (last).text.endsWith(event.text)))) late.push(event.kind);
                    kept = (turnSoFar["main.scout"] ?? []).map((e) => e.kind);
                },
                observed: async () => {
                    after.push(turnSoFar["main.scout"], openings["main.scout"]);
                },
            }),
            toolOptions: () => ({ vision: false, codePrimer: "" }),
        });
        expect(await runner.run("main.scout", "look around", { signal: new AbortController().signal })).toBe("done");
        expect(late).toEqual([]);
        expect(kept).toEqual(expect.arrayContaining(["ThinkingDelta", "TextDelta", "ToolStarted", "ToolEnded"]));
        expect(kept.indexOf("ToolStarted")).toBeLessThan(kept.indexOf("ToolEnded"));
        // a delegate between turns (waiting on its own delegates) has no turn to replay
        expect(after).toEqual([undefined, undefined]);
        expect(turnSoFar["main.scout"]).toBeUndefined();
        expect(openings["main.scout"]).toBeUndefined();
        await ws.close();
    });
});
