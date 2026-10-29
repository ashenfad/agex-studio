import { beforeEach, describe, expect, it, vi } from "vitest";
import { KeyRequests } from "./key-requests.svelte.js";
import { checkRequest, requestSecretTool } from "./request-secret.js";
import { Vault, VaultError } from "./vault.svelte.js";

beforeEach(() => {
    const items = new Map();
    vi.stubGlobal("localStorage", {
        getItem: (/** @type {string} */ k) => items.get(k) ?? null,
        setItem: (/** @type {string} */ k, /** @type {string} */ v) => items.set(k, String(v)),
        removeItem: (/** @type {string} */ k) => items.delete(k),
    });
});

const STRIPE = "https://api.stripe.com";
const FAKE = "sk_test_fake_0123456789";
const args = { name: "STRIPE_KEY", origins: [STRIPE], why: "to list your prices" };

/** A vault with one Stripe key, its requests, and the tool for session s1. */
function setup() {
    const vault = new Vault();
    const id = vault.add({ label: "Stripe (personal)", value: FAKE, origins: [STRIPE] });
    const requests = new KeyRequests(vault);
    const tool = requestSecretTool({ name: "s1" }, { vault, requests });
    return { vault, id, requests, tool };
}

/** Wait for the question to open. */
const opened = () => new Promise((r) => setTimeout(r, 0));

describe("request_secret's arguments", () => {
    it("are a name, https origins and a why, each thing wrong said", () => {
        expect(checkRequest({ ...args, origins: ["https://API.stripe.com/"] })).toEqual({ want: { ...args, origins: [STRIPE] }, errors: [] });
        expect(checkRequest({ name: "stripe", origins: ["http://api.stripe.com"], why: " " }).errors).toEqual([
            'name: "stripe" must be upper-case letters, digits and _, starting with a letter, like "STRIPE"',
            'origin 1: "http://api.stripe.com" is http:; a key goes over https: only ("https://api.stripe.com")',
            "why: say in a sentence what the key is for; the person reads it",
        ]);
        expect(checkRequest({ name: "K", origins: [], why: "x" }).errors).toEqual(['origins: name where the key goes, like ["https://api.stripe.com"]']);
    });

    it("can't name one of the session's variables", () => {
        expect(checkRequest({ ...args, name: "API_URL" }, { variables: ["API_URL"] }).errors).toEqual([
            "name: API_URL is one of this session's variables (public configuration); a name is a key or a variable, not both, so pick another",
        ]);
        expect(checkRequest(args, { variables: ["API_URL"] }).errors).toEqual([]);
    });
});

describe("request_secret", () => {
    it("grants what the person picks to the session's agent, for the origins asked, and names it only", async () => {
        const { vault, id, requests, tool } = setup();
        const pending = tool.call(args);
        await opened();
        expect(requests.asking.s1).toMatchObject(args);
        requests.answer("s1", id);
        const out = await pending;
        expect(out.isError).toBe(false);
        expect(out.text).toMatch(/^The person granted STRIPE_KEY\. Use it as \$STRIPE_KEY in curl/);
        expect(out.text).not.toContain(FAKE);
        expect(vault.agentGrantsOf("s1")).toEqual({ STRIPE_KEY: { entry: id, origins: [STRIPE] } });
        expect(vault.agentSecrets("s1").STRIPE_KEY.value).toBe(FAKE);
        expect(requests.asking).toEqual({});
    });

    it("answers Not now so the turn goes on, granting nothing", async () => {
        const { vault, requests, tool } = setup();
        const pending = tool.call(args);
        await opened();
        requests.answer("s1", null);
        const out = await pending;
        expect([out.isError, out.text]).toEqual([false, expect.stringMatching(/^The person chose not to give STRIPE_KEY now/)]);
        expect(vault.agentGrants).toEqual({});
    });

    it("doesn't ask for a key the agent has already for those origins", async () => {
        const { vault, id, requests, tool } = setup();
        vault.setAgentName(id, "STRIPE_KEY");
        const out = await tool.call(args);
        expect(out.text).toMatch(/^You have STRIPE_KEY already\./);
        expect(requests.asking).toEqual({});
    });

    it("refuses a variable's name, unless a key under it already won", async () => {
        const { vault, id, requests } = setup();
        const tool = requestSecretTool({ name: "s1" }, { vault, requests, variables: () => ({ STRIPE_KEY: "pk" }) });
        expect((await tool.call(args)).text).toMatch(/^name: STRIPE_KEY is one of this session's variables/);
        vault.setAgentName(id, "STRIPE_KEY");
        expect((await tool.call(args)).text).toMatch(/^You have STRIPE_KEY already\./);
        expect(requests.asking).toEqual({});
    });

    it("keeps the question open when the vault refuses the grant", async () => {
        const { vault, requests, tool } = setup();
        const narrow = vault.add({ label: "Other", value: "sk_test_fake_other", origins: ["https://files.stripe.com"] });
        void tool.call(args);
        await opened();
        expect(() => requests.answer("s1", narrow)).toThrow(VaultError);
        expect(requests.asking.s1).toBeDefined();
    });

    it("takes the question back when the turn ends", async () => {
        const { requests, tool } = setup();
        const stop = new AbortController();
        const pending = tool.call(args, { signal: stop.signal });
        await opened();
        stop.abort();
        expect(await pending).toEqual({ text: "the turn ended before the person answered", images: [], isError: true });
        expect(requests.asking).toEqual({});
    });

    it("refuses a second request while one waits, and bad arguments without asking", async () => {
        const { requests, tool } = setup();
        void tool.call(args);
        await opened();
        expect(await tool.call({ ...args, name: "OTHER_KEY" })).toEqual({ text: "another key request of this session's is waiting on the person", images: [], isError: true });
        expect((await tool.call({ ...args, name: "x" })).isError).toBe(true);
        expect(Object.keys(requests.asking)).toEqual(["s1"]);
    });

    it("is refused to a delegate, telling it to name the key in its answer", async () => {
        const { requests } = setup();
        const tool = requestSecretTool({ name: "s1.helper", delegate: true }, { requests });
        const out = await tool.call(args);
        expect(out.isError).toBe(true);
        expect(out.text).toMatch(/^a delegate can't ask the person for a key.*say in your answer that you need STRIPE_KEY, with the origins it goes to and why/);
        expect(requests.asking).toEqual({});
    });
});
