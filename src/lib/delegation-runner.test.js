import { Memory } from "@agex-ts/kvgit/backends/memory";
import { Store } from "@agex-ts/world";
import { Agent, ScriptedProvider } from "agex-ts";
import { describe, expect, it } from "vitest";
import { StudioRunner } from "./delegation.svelte.js";

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
