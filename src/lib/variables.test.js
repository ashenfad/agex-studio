import { Memory } from "@agex-ts/kvgit/backends/memory";
import { Store } from "@agex-ts/world";
import { afterEach, describe, expect, it } from "vitest";
import {
    MAX_VARIABLES,
    VALUE_MAX,
    VARIABLES_KEY,
    applyVariables,
    forgetLiveVariables,
    liveVariables,
    putLiveVariables,
    variableNameRefusal,
    variablesOf,
    withoutKeys,
} from "./variables.js";

afterEach(() => {
    forgetLiveVariables("s1");
});

describe("a variable's name", () => {
    it("is letters, digits and _, not starting with a digit", () => {
        expect(variableNameRefusal("API_URL")).toBeNull();
        expect(variableNameRefusal("mapStyle")).toBeNull();
        expect(variableNameRefusal("1X")).toMatch(/letters, digits and _/);
        expect(variableNameRefusal("A-B")).toMatch(/letters, digits and _/);
        expect(variableNameRefusal("A".repeat(65))).toMatch(/64 characters/);
    });
});

describe("a plane record's variables", () => {
    it("are its string values under good names, the rest left out", () => {
        expect(variablesOf({ API_URL: "https://a.test", N: 1, "A-B": "x" })).toEqual({ API_URL: "https://a.test" });
        expect(variablesOf(null)).toEqual({});
        expect(variablesOf(["x"])).toEqual({});
    });

    it("are held to the limits setting them is, though written elsewhere", () => {
        expect(variablesOf({ BIG: "x".repeat(VALUE_MAX + 1), OK: "x" })).toEqual({ OK: "x" });
        const many = Object.fromEntries(Array.from({ length: MAX_VARIABLES + 5 }, (_, i) => [`V${i}`, "x"]));
        const kept = variablesOf(many);
        expect(Object.keys(kept)).toHaveLength(MAX_VARIABLES);
        expect(kept.V0).toBe("x");
    });
});

describe("changing variables", () => {
    it("sets, replaces and removes", () => {
        const { next } = applyVariables({ A: "1", B: "2" }, { A: "one", B: null, C: "3" });
        expect(next).toEqual({ A: "one", C: "3" });
    });

    it("changes nothing when anything is wrong, each thing said", () => {
        const taken = { STRIPE_KEY: "one of this session's keys" };
        const { next, errors } = applyVariables({}, { OK: "x", "A-B": "x", N: 1, STRIPE_KEY: "pk", BIG: "x".repeat(VALUE_MAX + 1) }, { taken });
        expect(next).toBeNull();
        expect(errors).toEqual([
            "A-B: a name is letters, digits and _, not starting with a digit (like API_URL)",
            "N: a value is a string (null removes it)",
            "STRIPE_KEY: one of this session's keys; a name is a key or a variable, not both",
            `BIG: keep a value to ${VALUE_MAX} bytes or fewer; variables are configuration, not data`,
        ]);
    });

    it("counts a value's bytes, not its characters", () => {
        expect(applyVariables({}, { E: "é".repeat(VALUE_MAX / 2) }).errors).toEqual([]);
        expect(applyVariables({}, { E: "é".repeat(VALUE_MAX / 2 + 1) }).errors).toHaveLength(1);
    });

    it(`keeps a session to ${MAX_VARIABLES} of them`, () => {
        const full = Object.fromEntries(Array.from({ length: MAX_VARIABLES }, (_, i) => [`V${i}`, "x"]));
        expect(applyVariables(full, { V0: "y" }).errors).toEqual([]);
        expect(applyVariables(full, { MORE: "y" }).errors).toEqual([`a session has at most ${MAX_VARIABLES} variables`]);
        expect(applyVariables(full, { MORE: "y", V0: null }).errors).toEqual([]);
    });

    it("takes any name the pattern allows, Object's own members' too", () => {
        const { next, errors } = applyVariables({}, JSON.parse('{"toString":"a","constructor":"b","__proto__":"c"}'));
        expect(errors).toEqual([]);
        expect(Object.keys(next ?? {})).toEqual(["toString", "constructor", "__proto__"]);
        expect(Object.getPrototypeOf(next)).toBe(Object.prototype);
        expect(withoutKeys(/** @type {Record<string, string>} */ (next), {})).toEqual(next);
    });

    it("removes a name it can't set, so a bad one already there can go", () => {
        expect(applyVariables({}, { "A-B": null }).next).toEqual({});
    });
});

describe("live variables", () => {
    it("are the top session's, for its delegates too", () => {
        putLiveVariables("s1", { API_URL: "https://a.test" });
        expect(liveVariables("s1")).toEqual({ API_URL: "https://a.test" });
        expect(liveVariables("s1.d1.d2")).toEqual({ API_URL: "https://a.test" });
        expect(liveVariables("s2")).toEqual({});
        forgetLiveVariables("s1");
        expect(liveVariables("s1.d1")).toEqual({});
    });

    it("leave out a name a key has: the key wins", () => {
        expect(withoutKeys({ A: "1", TOKEN: "public" }, { TOKEN: { value: "k", origins: [] } })).toEqual({ A: "1" });
    });

    it("reach a world opened with them at its next call, and travel with its plane", async () => {
        const store = await Store.open(new Memory());
        const keys = /** @type {Record<string, { value: string, origins: string[] }>} */ ({});
        const profile = {
            secrets: () => keys,
            variables: () => withoutKeys(liveVariables("s1"), keys),
        };
        const ws = await store.open("s1", { profile });
        expect((await ws.terminal('echo "${API_URL:-none}"')).stdout).toBe("none\n");
        putLiveVariables("s1", { API_URL: "https://a.test", TOKEN: "public" });
        expect((await ws.terminal('echo "$API_URL"')).stdout).toBe("https://a.test\n");

        // a key made available under a variable's name wins
        keys.TOKEN = { value: "sk_test_fake_0123456789", origins: ["https://api.test"] };
        expect((await ws.terminal('echo "$TOKEN"')).stdout).toBe("${TOKEN}\n");

        // kept on the plane: a fork has them, and a checkout rewinds them
        ws.plane("studio").set(VARIABLES_KEY, { API_URL: "https://a.test" });
        await ws.autoCommit({ tool: "studio.variables" });
        const before = ws.head;
        ws.plane("studio").set(VARIABLES_KEY, { API_URL: "https://b.test" });
        await ws.autoCommit({ tool: "studio.variables" });
        const child = await ws.fork("s2", { inherit: "full" });
        expect(variablesOf(await child.plane("studio").get(VARIABLES_KEY))).toEqual({ API_URL: "https://b.test" });
        await ws.checkout(before);
        expect(variablesOf(await ws.plane("studio").get(VARIABLES_KEY))).toEqual({ API_URL: "https://a.test" });
        await child.close();
        await ws.close();
    });
});
