/**
 * Unit tests for `subtasks.js` — the dependency-injected sub-task
 * manager. A fake `createAgent` stands in for agex-ts so we can drive
 * success / fail / cancel paths and assert on persistence, recording,
 * and teardown without a real worker or LLM.
 */

import { describe, expect, it, vi } from "vitest";

import {
    createSubtaskManager,
    subtaskEventsInWindow,
    summarizeValue,
    STATE_KEY_SPECS,
    STATE_KEY_INVOCATIONS,
} from "./subtasks.js";

/**
 * Build a manager with a controllable fake agex-ts surface.
 * `behaviors[name]` shapes how a sub-task resolves:
 *   { result, throw, iterations }
 */
function makeManager(behaviors = {}) {
    const state = new Map();
    const disposed = [];
    const created = [];
    // Auto-incrementing clock so durationMs is deterministic and
    // timestamps are valid, distinct ISO strings.
    let clock = 1_700_000_000_000;

    const deps = {
        createAgent: vi.fn(async (cfg) => {
            const agent = {
                cfg,
                fns: [],
                fn(_impl, opts) {
                    this.fns.push(opts && opts.name);
                    return this;
                },
                task(_def) {
                    this.lastTaskDef = _def;
                    return async (argsJson, callOpts) => {
                        const b = behaviors[cfg.name] || {};
                        const iters = b.iterations ?? 1;
                        for (let i = 0; i < iters; i++) {
                            callOpts?.onEvent?.({ type: "action" });
                        }
                        if (callOpts?.signal?.aborted) {
                            throw new Error("aborted by signal");
                        }
                        if (b.throw) throw b.throw;
                        return "result" in b ? b.result : `ok:${argsJson}`;
                    };
                },
                async dispose() {
                    disposed.push(cfg.name);
                },
            };
            created.push(agent);
            return agent;
        }),
        workerRuntime: vi.fn(() => ({ kind: "fake-runtime" })),
        workerUrl: "worker.js",
        getLlm: () => ({ id: "parent-llm" }),
        registerSubAgentFns: vi.fn((a) => a.fn(() => {}, { name: "search" })),
        getParentMaxIterations: () => 40,
        onInvocationStart: vi.fn(),
        onInvocationComplete: vi.fn(),
        readState: async (k) => state.get(k),
        writeState: (k, v) => {
            state.set(k, v);
        },
        now: () => {
            const t = clock;
            clock += 10;
            return t;
        },
    };

    const mgr = createSubtaskManager(deps);
    return { mgr, deps, state, disposed, created };
}

// --------------------------------------------------------------------------
// defineTask
// --------------------------------------------------------------------------

describe("defineTask", () => {
    it("registers a named spec and persists the registry blob", async () => {
        const { mgr, state } = makeManager();
        const name = await mgr.defineTask({
            name: "pick-move",
            primer: "Play tic-tac-toe as O.",
            description: "Pick a move.",
            inputs: "3x3 board",
            output: "{x,y}",
            maxIterations: 5,
        });
        expect(name).toBe("pick-move");
        const blob = state.get(STATE_KEY_SPECS);
        expect(blob["pick-move"]).toEqual({
            primer: "Play tic-tac-toe as O.",
            description: "Pick a move.",
            inputs: "3x3 board",
            output: "{x,y}",
            maxIterations: 5,
        });
    });

    it("auto-generates a name when omitted and avoids collisions", async () => {
        const { mgr } = makeManager();
        const a = await mgr.defineTask({ primer: "p", description: "d" });
        const b = await mgr.defineTask({ primer: "p", description: "d" });
        expect(a).toBe("subtask:1");
        expect(b).toBe("subtask:2");
        expect(a).not.toBe(b);
    });

    it("rejects missing primer / description", async () => {
        const { mgr } = makeManager();
        await expect(mgr.defineTask({ description: "d" })).rejects.toThrow(/primer/);
        await expect(mgr.defineTask({ primer: "p" })).rejects.toThrow(/description/);
        await expect(mgr.defineTask({ primer: "  ", description: "d" })).rejects.toThrow(
            /primer/,
        );
    });

    it("drops a non-positive / non-integer maxIterations", async () => {
        const { mgr, state } = makeManager();
        await mgr.defineTask({ name: "t", primer: "p", description: "d", maxIterations: 0 });
        expect(state.get(STATE_KEY_SPECS).t.maxIterations).toBeUndefined();
    });

    it("stores a prose output and a JSON-schema output, rejects other types", async () => {
        const { mgr, state } = makeManager();
        await mgr.defineTask({
            name: "prose",
            primer: "p",
            description: "d",
            output: "a { x, y } pair",
        });
        const schema = {
            type: "object",
            properties: { x: { type: "integer" } },
            required: ["x"],
        };
        await mgr.defineTask({ name: "typed", primer: "p", description: "d", output: schema });
        expect(state.get(STATE_KEY_SPECS).prose.output).toBe("a { x, y } pair");
        expect(state.get(STATE_KEY_SPECS).typed.output).toEqual(schema);
        await expect(
            mgr.defineTask({ name: "bad", primer: "p", description: "d", output: 42 }),
        ).rejects.toThrow(/JSON Schema/);
    });
});

// --------------------------------------------------------------------------
// invokeTask
// --------------------------------------------------------------------------

describe("invokeTask", () => {
    it("spawns a sub-agent on its own runtime, runs, returns, disposes", async () => {
        const { mgr, deps, disposed } = makeManager({
            "pick-move": { result: { x: 1, y: 2 }, iterations: 3 },
        });
        await mgr.defineTask({ name: "pick-move", primer: "p", description: "d" });
        const result = await mgr.invokeTask("pick-move", { board: [] });

        expect(result).toEqual({ x: 1, y: 2 });
        // Fresh runtime per invocation (separate worker ⇒ parallelism).
        expect(deps.workerRuntime).toHaveBeenCalledWith({
            workerUrl: "worker.js",
            timeoutMs: 30_000,
        });
        // Shared parent llm, ephemeral live state, isolated memory fs.
        const cfg = deps.createAgent.mock.calls[0][0];
        expect(cfg.llm).toEqual({ id: "parent-llm" });
        expect(cfg.state).toEqual({ type: "live" });
        expect(cfg.fs).toEqual({ type: "memory" });
        expect(cfg.maxIterations).toBe(10); // default
        // Curated fns registered; sub-agent disposed.
        expect(deps.registerSubAgentFns).toHaveBeenCalledTimes(1);
        expect(disposed).toEqual(["pick-move"]);
    });

    it("wires a JSON-schema output into the sub-agent task (validated + described)", async () => {
        const { mgr, created } = makeManager({ t: { result: { x: 1 } } });
        const schema = {
            type: "object",
            properties: { x: { type: "integer" } },
            required: ["x"],
        };
        await mgr.defineTask({ name: "t", primer: "p", description: "d", output: schema });
        await mgr.invokeTask("t", null);
        const def = created[0].lastTaskDef;
        // Standard Schema for runtime validation...
        expect(def.output && def.output["~standard"]).toBeTruthy();
        // ...and the raw JSON schema for the sub-agent's prompt.
        expect(def.outputJsonSchema).toEqual(schema);
        // The wired validator actually rejects a bad shape.
        expect(def.output["~standard"].validate({ y: 2 }).issues).toBeDefined();
        expect(def.output["~standard"].validate({ x: 5 }).issues).toBeUndefined();
    });

    it("wires a prose output as outputDescription (no validation)", async () => {
        const { mgr, created } = makeManager({ t: { result: 1 } });
        await mgr.defineTask({ name: "t", primer: "p", description: "d", output: "an integer" });
        await mgr.invokeTask("t", null);
        const def = created[0].lastTaskDef;
        expect(def.outputDescription).toBe("an integer");
        expect(def.output).toBeUndefined();
        expect(def.outputJsonSchema).toBeUndefined();
    });

    it("honors a per-task maxIterations override", async () => {
        const { mgr, deps } = makeManager({ t: { result: 1 } });
        await mgr.defineTask({ name: "t", primer: "p", description: "d", maxIterations: 3 });
        await mgr.invokeTask("t", null);
        expect(deps.createAgent.mock.calls[0][0].maxIterations).toBe(3);
    });

    it("inherits the parent's maxIterations when maxIterations: 'inherit'", async () => {
        const { mgr, deps, state } = makeManager({ t: { result: 1 } });
        const name = await mgr.defineTask({
            name: "t",
            primer: "p",
            description: "d",
            maxIterations: "inherit",
        });
        expect(name).toBe("t");
        // Persisted as the sentinel, not a resolved number — so it
        // tracks the parent if the parent's cap later changes.
        expect(state.get(STATE_KEY_SPECS).t.maxIterations).toBe("inherit");
        await mgr.invokeTask("t", null);
        expect(deps.createAgent.mock.calls[0][0].maxIterations).toBe(40);
    });

    it("records a success invocation with iteration count + duration", async () => {
        const { mgr, state } = makeManager({
            "pick-move": { result: { x: 1, y: 2 }, iterations: 3 },
        });
        await mgr.defineTask({ name: "pick-move", primer: "p", description: "d" });
        await mgr.invokeTask("pick-move", { board: [1] });

        const recs = state.get(STATE_KEY_INVOCATIONS);
        expect(recs).toHaveLength(1);
        expect(recs[0]).toMatchObject({
            name: "pick-move",
            status: "success",
            iterations: 3,
            agentName: "chat",
        });
        expect(recs[0].args).toEqual({ board: [1] });
        expect(recs[0].resultSummary).toContain("x");
        expect(recs[0].durationMs).toBeGreaterThanOrEqual(0);
        expect(typeof recs[0].timestamp).toBe("string");
        expect(Number.isNaN(Date.parse(recs[0].timestamp))).toBe(false);
    });

    it("does NOT record when record:false (iframe-initiated)", async () => {
        const { mgr, state, disposed } = makeManager({ t: { result: 1 } });
        await mgr.defineTask({ name: "t", primer: "p", description: "d" });
        await mgr.invokeTask("t", null, { record: false, source: "iframe" });
        expect(state.get(STATE_KEY_INVOCATIONS)).toBeUndefined();
        expect(disposed).toEqual(["t"]); // still torn down
    });

    it("throws for an unknown sub-task name", async () => {
        const { mgr } = makeManager();
        await expect(mgr.invokeTask("nope", {})).rejects.toThrow(/no sub-task named "nope"/);
    });

    it("records fail status and rethrows on sub-task failure", async () => {
        const failErr = Object.assign(new Error("boom"), { name: "TaskFailError" });
        const { mgr, state, disposed } = makeManager({ t: { throw: failErr } });
        await mgr.defineTask({ name: "t", primer: "p", description: "d" });
        await expect(mgr.invokeTask("t", {})).rejects.toThrow("boom");
        const recs = state.get(STATE_KEY_INVOCATIONS);
        expect(recs[0]).toMatchObject({ status: "fail", error: "boom" });
        expect(recs[0].resultSummary).toBeUndefined();
        expect(disposed).toEqual(["t"]); // disposed even on failure
    });

    it("fires live start/complete callbacks for parent-initiated calls", async () => {
        const { mgr, deps } = makeManager({
            "pick-move": { result: { x: 1 }, iterations: 2 },
        });
        await mgr.defineTask({ name: "pick-move", primer: "p", description: "d" });
        await mgr.invokeTask("pick-move", { board: [] });

        expect(deps.onInvocationStart).toHaveBeenCalledTimes(1);
        const start = deps.onInvocationStart.mock.calls[0][0];
        expect(start).toMatchObject({ name: "pick-move", argsSummary: expect.any(String) });
        expect(typeof start.id).toBe("string");

        expect(deps.onInvocationComplete).toHaveBeenCalledTimes(1);
        const end = deps.onInvocationComplete.mock.calls[0][0];
        // Same id ties start → complete; record matches what's persisted.
        expect(end.id).toBe(start.id);
        expect(end.record).toMatchObject({ name: "pick-move", status: "success", iterations: 2 });
    });

    it("fires complete with fail status, and start still fires, on failure", async () => {
        const { mgr, deps } = makeManager({ t: { throw: new Error("boom") } });
        await mgr.defineTask({ name: "t", primer: "p", description: "d" });
        await expect(mgr.invokeTask("t", {})).rejects.toThrow("boom");
        expect(deps.onInvocationStart).toHaveBeenCalledTimes(1);
        expect(deps.onInvocationComplete.mock.calls[0][0].record.status).toBe("fail");
    });

    it("does NOT fire live callbacks for iframe-initiated calls", async () => {
        const { mgr, deps } = makeManager({ t: { result: 1 } });
        await mgr.defineTask({ name: "t", primer: "p", description: "d" });
        await mgr.invokeTask("t", null, { record: false, source: "iframe" });
        expect(deps.onInvocationStart).not.toHaveBeenCalled();
        expect(deps.onInvocationComplete).not.toHaveBeenCalled();
    });

    it("classifies an aborted signal as cancelled", async () => {
        const { mgr, state } = makeManager({ t: { result: 1 } });
        await mgr.defineTask({ name: "t", primer: "p", description: "d" });
        const ac = new AbortController();
        ac.abort();
        await expect(mgr.invokeTask("t", {}, { signal: ac.signal })).rejects.toThrow();
        expect(state.get(STATE_KEY_INVOCATIONS)[0].status).toBe("cancelled");
    });

    it("rejects non-JSON-serializable args before spawning", async () => {
        const { mgr, deps } = makeManager();
        await mgr.defineTask({ name: "t", primer: "p", description: "d" });
        const circular = {};
        circular.self = circular;
        await expect(mgr.invokeTask("t", circular)).rejects.toThrow(/not JSON-serializable/);
        expect(deps.createAgent).not.toHaveBeenCalled();
    });

    it("caps iframe-initiated invocations per session", async () => {
        const { mgr } = makeManager({ t: { result: 1 } });
        await mgr.defineTask({ name: "t", primer: "p", description: "d" });
        // Cap is 200; drive just past it. Worker-initiated calls don't count.
        for (let i = 0; i < 200; i++) {
            await mgr.invokeTask("t", null, { record: false, source: "iframe" });
        }
        await expect(
            mgr.invokeTask("t", null, { record: false, source: "iframe" }),
        ).rejects.toThrow(/per-session limit/);
        // Worker-initiated still works after the iframe cap is hit.
        await expect(mgr.invokeTask("t", null)).resolves.toBe(1);
    });

    it("does not reset the iframe cap on rehydrate (it's per page-session)", async () => {
        const { mgr, state } = makeManager({ t: { result: 1 } });
        state.set(STATE_KEY_SPECS, { t: { primer: "p", description: "d" } });
        await mgr.rehydrate();
        // Exhaust the cap...
        for (let i = 0; i < 200; i++) {
            await mgr.invokeTask("t", null, { record: false, source: "iframe" });
        }
        // ...then a rehydrate (e.g. a chat-side undo / session reload)
        // must NOT clear the counter.
        await mgr.rehydrate();
        await expect(
            mgr.invokeTask("t", null, { record: false, source: "iframe" }),
        ).rejects.toThrow(/per-session limit/);
    });
});

// --------------------------------------------------------------------------
// rehydrate
// --------------------------------------------------------------------------

describe("rehydrate", () => {
    it("repopulates specs + invocations from persisted state", async () => {
        const { mgr, state } = makeManager({ saved: { result: 1 } });
        state.set(STATE_KEY_SPECS, {
            saved: { primer: "p", description: "d", maxIterations: 7 },
        });
        state.set(STATE_KEY_INVOCATIONS, [
            { name: "saved", status: "success", timestamp: "2026-05-30T00:00:00.000Z" },
        ]);
        await mgr.rehydrate();
        expect(mgr.has("saved")).toBe(true);
        expect(mgr.getInvocations()).toHaveLength(1);
        // Rehydrated spec is invocable.
        await expect(mgr.invokeTask("saved", {})).resolves.toBe(1);
    });

    it("clears prior branch state so a switch doesn't leak specs", async () => {
        const { mgr, state } = makeManager();
        await mgr.defineTask({ name: "ghost", primer: "p", description: "d" });
        expect(mgr.has("ghost")).toBe(true);
        // Simulate switching to a branch with no persisted specs.
        state.delete(STATE_KEY_SPECS);
        await mgr.rehydrate();
        expect(mgr.has("ghost")).toBe(false);
    });

    it("auto-name counter avoids collisions with rehydrated names", async () => {
        const { mgr, state } = makeManager();
        state.set(STATE_KEY_SPECS, { "subtask:1": { primer: "p", description: "d" } });
        await mgr.rehydrate();
        const name = await mgr.defineTask({ primer: "p", description: "d" });
        expect(name).not.toBe("subtask:1");
        expect(mgr.has(name)).toBe(true);
    });
});

// --------------------------------------------------------------------------
// pure helpers
// --------------------------------------------------------------------------

describe("subtaskEventsInWindow", () => {
    const recs = [
        { name: "a", timestamp: "2026-05-30T00:00:01.000Z" },
        { name: "b", timestamp: "2026-05-30T00:00:03.000Z" },
        { name: "c", timestamp: "2026-05-30T00:00:05.000Z" },
    ];

    it("filters to the window, sorts chronologically, tags type:subtask", () => {
        const start = Date.parse("2026-05-30T00:00:00.000Z");
        const end = Date.parse("2026-05-30T00:00:04.000Z");
        const out = subtaskEventsInWindow(recs, start, end);
        expect(out.map((e) => e.name)).toEqual(["a", "b"]);
        expect(out.every((e) => e.type === "subtask")).toBe(true);
    });

    it("returns everything for an open window", () => {
        const out = subtaskEventsInWindow(recs, -Infinity, Infinity);
        expect(out).toHaveLength(3);
    });

    it("returns empty when nothing falls in the window", () => {
        const out = subtaskEventsInWindow(recs, 0, 1);
        expect(out).toEqual([]);
    });
});

describe("summarizeValue", () => {
    it("stringifies and collapses whitespace", () => {
        expect(summarizeValue({ a: 1 })).toBe('{"a":1}');
        expect(summarizeValue("hi\n  there")).toBe("hi there");
    });

    it("truncates with an ellipsis past the cap", () => {
        const out = summarizeValue("x".repeat(200), 10);
        expect(out.length).toBe(10);
        expect(out.endsWith("…")).toBe(true);
    });
});
