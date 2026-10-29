import { describe, expect, it } from "vitest";
import { Browser } from "./browser.js";
import { ExtensionError } from "./browser-extension.svelte.js";
import { BrowserHost, STUB, codeError } from "./browser-host.js";

/** An extension found that answers each op from `answers`, keeping what it was asked. */
function fakeExtension(/** @type {Record<string, any>} */ answers) {
    /** @type {{ op: string, args: any }[]} */
    const calls = [];
    return {
        status: "found",
        calls,
        async call(/** @type {string} */ op, /** @type {any} */ args) {
            calls.push({ op, args });
            const a = typeof answers[op] === "function" ? answers[op](args) : answers[op];
            if (a instanceof ExtensionError) throw a;
            return a;
        },
    };
}

describe("the browser host", () => {
    it("works in the calling session's top session's tabs, each action on the latest read", async () => {
        const ext = fakeExtension({ open: { tab: 9 }, read: { version: 2, text: "" }, click: { url: "u", title: "t" } });
        const host = new BrowserHost("s1.d1", new Browser(/** @type {any} */ (ext)));
        expect(await host.open("https://www.hyatt.com/")).toEqual({ id: 9 });
        await host.read(9);
        await host.click(9, 3);
        expect(ext.calls.map((c) => [c.op, c.args.session, c.args.version])).toEqual([
            ["open", "s1", undefined],
            ["read", "s1", undefined],
            ["click", "s1", 2],
        ]);
    });

    it("throws a refusal as an error saying what code can do about it", async () => {
        const ext = fakeExtension({ open: new ExtensionError("not-granted", "this session holds no grant for ihg.com") });
        const host = new BrowserHost("s1", new Browser(/** @type {any} */ (ext)));
        await expect(host.open("https://www.ihg.com/")).rejects.toThrow(/no grant for ihg\.com \(not-granted\): code can't ask for a site; return this, and the agent asks with request_sites/);
    });

    it("never takes a committing step from code", () => {
        expect(codeError(new ExtensionError("confirm", '[1] button "Book" reads as a step that commits ("Book")')).message).toMatch(/\(confirm\): code never takes a step that commits/);
    });
});

describe("the browser stub", () => {
    /** The stub over a remote that records its calls. */
    function stubbed() {
        /** @type {any[]} */
        const calls = [];
        const remote = new Proxy({}, { get: (_, method) => async (/** @type {any[]} */ ...args) => (calls.push([method, ...args]), method === "open" ? { id: 4 } : method === "tabs" ? [{ id: 4, url: "u", title: "t", working: false }] : null) });
        // eslint-disable-next-line no-eval
        const make = (0, eval)(STUB);
        return { code: make(remote), calls };
    }

    it("gives code tabs whose methods call the host with their id", async () => {
        const { code, calls } = stubbed();
        const tab = await code.open("https://www.hyatt.com/");
        expect(tab.id).toBe(4);
        await tab.read();
        await tab.type(2, "Lisbon", { submit: true });
        await tab.waitFor("Rates", { timeout: 5000 });
        await tab.waitFor({ selector: ".rates" });
        expect(calls).toEqual([
            ["open", "https://www.hyatt.com/"],
            ["read", 4, undefined],
            ["type", 4, 2, "Lisbon", { submit: true }],
            ["waitFor", 4, { text: "Rates", timeout: 5000 }],
            ["waitFor", 4, { selector: ".rates" }],
        ]);
    });

    it("lists the tabs as tabs, with what the host says of each", async () => {
        const { code } = stubbed();
        const [tab] = await code.tabs();
        expect(tab).toMatchObject({ id: 4, url: "u", title: "t", working: false });
        expect(typeof tab.click).toBe("function");
    });
});
