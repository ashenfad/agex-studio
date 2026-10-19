import { describe, expect, it } from "vitest";
import { keepUnchanged } from "./runs.js";

/** @param {string} runId @param {string[]} ids @param {string} [status] */
const run = (runId, ids, status = "completed") =>
    /** @type {import("agex-ts").Run} */ (/** @type {unknown} */ ({ runId, status, messages: ids.map((id) => ({ id, role: "assistant", parts: [] })) }));

describe("keepUnchanged", () => {
    it("keeps the object of a run that hasn't changed", () => {
        const a = run("a", ["1", "2"]);
        const b = run("b", ["3"]);
        const out = keepUnchanged([a, b], [run("a", ["1", "2"]), run("b", ["3"])]);
        expect(out[0]).toBe(a);
        expect(out[1]).toBe(b);
    });

    it("takes the new one for a run that grew, changed status, or is new", () => {
        const a = run("a", ["1"], "running");
        const grown = run("a", ["1", "2"], "running");
        expect(keepUnchanged([a], [grown])[0]).toBe(grown);
        const ended = run("a", ["1"], "completed");
        expect(keepUnchanged([a], [ended])[0]).toBe(ended);
        const c = run("c", ["9"]);
        expect(keepUnchanged([a], [run("a", ["1"], "running"), c])).toEqual([a, c]);
    });

    it("drops a run no longer in the record (an undo)", () => {
        const a = run("a", ["1"]);
        expect(keepUnchanged([a, run("b", ["2"])], [run("a", ["1"])])).toEqual([a]);
    });
});
