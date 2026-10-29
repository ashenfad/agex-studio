import { describe, expect, it, vi } from "vitest";
import { setVariablesTool } from "./set-variables.js";

describe("set_variables", () => {
    it("sets and removes through the session, saying what it did", async () => {
        const setVariables = vi.fn(async () => []);
        const tool = setVariablesTool({ name: "s1", setVariables });
        const out = await tool.call({ variables: { API_URL: "https://a.test", OLD: null } });
        expect(setVariables).toHaveBeenCalledWith({ API_URL: "https://a.test", OLD: null });
        expect(out.isError).toBe(false);
        expect(out.text).toMatch(/^Set API_URL; removed OLD\. The app's page has them as window\.env/);
    });

    it("reports what the session refused, having changed nothing", async () => {
        const tool = setVariablesTool({ name: "s1", setVariables: async () => ["STRIPE_KEY: one of this session's keys; a name is a key or a variable, not both"] });
        const out = await tool.call({ variables: { STRIPE_KEY: "pk" } });
        expect(out).toMatchObject({ isError: true, text: "Nothing was changed:\nSTRIPE_KEY: one of this session's keys; a name is a key or a variable, not both" });
    });

    it("wants an object naming at least one", async () => {
        const setVariables = vi.fn(async () => []);
        const tool = setVariablesTool({ name: "s1", setVariables });
        expect((await tool.call({ variables: "API_URL=x" })).text).toMatch(/^variables: an object of NAME to value/);
        expect((await tool.call({ variables: {} })).text).toBe("variables: name at least one to set or remove");
        expect(setVariables).not.toHaveBeenCalled();
    });

    it("refuses a delegate, telling it to name them in its answer", async () => {
        const setVariables = vi.fn(async () => []);
        const out = await setVariablesTool({ name: "s1.d1", delegate: true, setVariables }).call({ variables: { API_URL: "x" } });
        expect(out.isError).toBe(true);
        expect(out.text).toMatch(/^a delegate can't set variables: .* say in your answer which to set \(API_URL\) and to what/);
        expect(setVariables).not.toHaveBeenCalled();
    });
});
