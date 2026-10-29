import { beforeEach, describe, expect, it, vi } from "vitest";
import { Asks } from "./asks.svelte.js";
import { KeyRequests } from "./key-requests.svelte.js";
import { checkRequest, requestSitesTool } from "./request-sites.js";
import { SiteRequests } from "./site-requests.svelte.js";
import { Vault } from "./vault.svelte.js";

beforeEach(() => {
    const items = new Map();
    vi.stubGlobal("localStorage", {
        getItem: (/** @type {string} */ k) => items.get(k) ?? null,
        setItem: (/** @type {string} */ k, /** @type {string} */ v) => items.set(k, String(v)),
        removeItem: (/** @type {string} */ k) => items.delete(k),
    });
});

const args = { domains: ["marriott.com", "hyatt.com"], why: "to compare hotels in Lisbon for December 3 to 6" };

/** A vault, the page's asks, its requests for sites, and the tool for session s1. */
function setup() {
    const vault = new Vault();
    const asks = new Asks();
    const requests = new SiteRequests(vault, asks);
    const tool = requestSitesTool({ name: "s1" }, { vault, requests });
    return { vault, asks, requests, tool };
}

/** Wait for the question to open. */
const opened = () => new Promise((r) => setTimeout(r, 0));

describe("request_sites's arguments", () => {
    it("are domains and a why, each thing wrong said", () => {
        expect(checkRequest({ domains: ["https://www.Marriott.com/x"], why: " why " })).toEqual({ want: { domains: ["marriott.com"], why: "why" }, errors: [] });
        expect(checkRequest({ domains: ["com"], why: "" }).errors).toEqual([
            'domains: "com" isn\'t a domain; name one like "marriott.com"',
            "why: say in a sentence what the sites are for; the person reads it",
        ]);
        expect(checkRequest({ domains: [], why: "x" }).errors).toEqual(['domains: name the sites, like ["marriott.com", "hyatt.com"]']);
    });
});

describe("request_sites", () => {
    it("grants the sites the person allows to the session's agent", async () => {
        const { vault, requests, tool } = setup();
        const pending = tool.call(args);
        await opened();
        expect(requests.open("s1")).toMatchObject({ kind: "sites", ...args });
        requests.answer("s1", ["marriott.com", "hyatt.com"]);
        const out = await pending;
        expect(out.isError).toBe(false);
        expect(out.text).toBe("The person allowed marriott.com, hyatt.com (each with its subdomains) for this session.");
        expect(vault.sitesOf("s1")).toEqual(["marriott.com", "hyatt.com"]);
    });

    it("says which the person left out", async () => {
        const { vault, requests, tool } = setup();
        const pending = tool.call(args);
        await opened();
        requests.answer("s1", ["hyatt.com", "ihg.com"]); // one never asked for is ignored
        expect((await pending).text).toMatch(/allowed hyatt\.com .* Not marriott\.com: leave those out, or say why you need them\.$/);
        expect(vault.sitesOf("s1")).toEqual(["hyatt.com"]);
    });

    it("answers Not now as a result, granting nothing", async () => {
        const { vault, requests, tool } = setup();
        const pending = tool.call(args);
        await opened();
        requests.answer("s1", []);
        const out = await pending;
        expect(out).toMatchObject({ isError: false });
        expect(out.text).toMatch(/^The person chose not to allow marriott\.com, hyatt\.com now/);
        expect(vault.sitesOf("s1")).toEqual([]);
    });

    it("asks only for what the agent doesn't have, and not at all when it has them", async () => {
        const { vault, requests, tool } = setup();
        vault.grantSites("s1", ["marriott.com"]);
        const pending = tool.call(args);
        await opened();
        expect(requests.open("s1")?.domains).toEqual(["hyatt.com"]);
        requests.answer("s1", ["hyatt.com"]);
        await pending;
        expect(await tool.call({ domains: ["www.hyatt.com", "book.marriott.com"], why: "x" })).toMatchObject({ isError: false, text: "You may open hyatt.com, book.marriott.com already (each with its subdomains)." });
    });

    it("waits its turn behind a key request: one card at a time", async () => {
        const { vault, asks, tool } = setup();
        const keys = new KeyRequests(vault, asks);
        void keys.ask("s1", { name: "K", origins: ["https://api.example.com"], why: "x" }).catch(() => {});
        await opened();
        expect(await tool.call(args)).toEqual({ text: "a key request of this session's is waiting on the person", images: [], isError: true });
    });

    it("refuses a delegate, saying to name the sites in its answer", async () => {
        const { vault } = setup();
        const out = await requestSitesTool({ name: "s1.d1", delegate: true }, { vault }).call(args);
        expect(out.isError).toBe(true);
        expect(out.text).toMatch(/you need marriott\.com, hyatt\.com opened and why/);
    });

    it("gives the request back when the turn ends first", async () => {
        const { requests, tool } = setup();
        const stop = new AbortController();
        const pending = tool.call(args, { signal: stop.signal });
        await opened();
        stop.abort();
        expect(await pending).toMatchObject({ text: "the turn ended before the person answered", isError: true });
        expect(requests.open("s1")).toBeUndefined();
    });
});
