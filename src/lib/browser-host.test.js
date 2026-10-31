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
        await host.click(9, 2, 3);
        expect(ext.calls.map((c) => [c.op, c.args.session, c.args.version])).toEqual([
            ["open", "s1", undefined],
            ["read", "s1", undefined],
            ["click", "s1", 2],
        ]);
    });

    it("refuses an action from a tab object not read yet", async () => {
        const host = new BrowserHost("s1", new Browser(/** @type {any} */ (fakeExtension({}))));
        await expect(host.click(9, undefined, 3)).rejects.toThrow(/hasn't been read here yet; read it first \(stale\)/);
    });

    it("throws a refusal as an error saying what code can do about it", async () => {
        const ext = fakeExtension({ open: new ExtensionError("not-granted", "this session holds no grant for ihg.com") });
        const host = new BrowserHost("s1", new Browser(/** @type {any} */ (ext)));
        await expect(host.open("https://www.ihg.com/")).rejects.toThrow(/no grant for ihg\.com \(not-granted\): code can't ask for a site; return this, and the agent asks with request_sites/);
    });

    it("sends code back to the agent when the browser was stopped", () => {
        expect(codeError(new ExtensionError("stopped", "Chrome's debugging bar was cancelled")).message).toMatch(/\(stopped\): code can't ask; return this, and the agent's next browser tool call asks the person whether to go on/);
    });

    it("never takes a committing step from code", () => {
        expect(codeError(new ExtensionError("confirm", '[1] button "Book" reads as a step that commits ("Book")')).message).toMatch(/\(confirm\): code never takes a step that commits/);
        expect(codeError(new ExtensionError("read-only", "tab 9 is the person's, shared to read")).message).toMatch(/\(read-only\): a tab the person shared is only read; return this/);
        expect(codeError(new ExtensionError("moved", "tab 9 was shared on mail.example")).message).toMatch(/\(moved\): return this, and the agent tells the person/);
    });
});

describe("the browser stub", () => {
    /** The stub over a remote that records its calls. */
    function stubbed() {
        /** @type {any[]} */
        const calls = [];
        const answers = /** @type {Record<string, any>} */ ({ open: { id: 4 }, tabs: [{ id: 4, url: "u", title: "t", working: false }], read: { version: 6 } });
        const remote = new Proxy({}, { get: (_, method) => async (/** @type {any[]} */ ...args) => (calls.push([method, ...args]), answers[String(method)] ?? null) });
        // eslint-disable-next-line no-eval
        const make = (0, eval)(STUB);
        return { code: make(remote), calls };
    }

    it("gives code tabs whose methods call the host with their id", async () => {
        const { code, calls } = stubbed();
        const tab = await code.open("https://www.hyatt.com/");
        expect(tab.id).toBe(4);
        await tab.click(1); // before any read: the host refuses it, read first
        await tab.read();
        await tab.type(2, "Lisbon", { submit: true });
        await tab.waitFor("Rates", { timeout: 5000 });
        await tab.waitFor({ selector: ".rates" });
        await tab.scroll("bottom");
        await tab.press(3, "Enter");
        await tab.read({ settle: true });
        expect(calls).toEqual([
            ["open", "https://www.hyatt.com/"],
            ["click", 4, undefined, 1],
            ["read", 4, undefined],
            ["type", 4, 6, 2, "Lisbon", { submit: true }],
            ["waitFor", 4, { text: "Rates", timeout: 5000 }],
            ["waitFor", 4, { selector: ".rates" }],
            ["scroll", 4, "bottom"],
            ["press", 4, 6, 3, "Enter"],
            ["read", 4, { settle: true }],
        ]);
    });

    it("finds a page's refs by name, of a kind, after some text", async () => {
        const page = {
            version: 6,
            url: "https://www.google.com/travel/flights",
            text: 'From $583 [1] button "Select flight" [2] link "Details"\nFrom $706 [3] button "Select flight" [4] link "Details"\nFrom $990 [5] button "Select flight"',
            refs: [1, 2, 3, 4, 5].map((ref) => ({ ref, kind: ref % 2 ? "button" : "link", name: ref % 2 ? "Select flight" : "Details" })),
        };
        const remote = { read: async () => page };
        // eslint-disable-next-line no-eval
        const p = await (0, eval)(STUB)(remote).tab(4).read();
        expect(p.find("select FLIGHT")).toBe(1);
        expect(p.find("Select flight", { after: "$706" })).toBe(3);
        expect(p.findAll("Select flight", { after: "$706" })).toEqual([3, 5]);
        expect(p.findAll(/^Det/, { kind: "link" })).toEqual([2, 4]);
        expect(p.findAll("Details", { kind: "button" })).toEqual([]);
        expect(p.findAll("Details", { after: "nowhere" })).toEqual([]);
        expect(() => p.find("Book", { after: "$706" })).toThrow('no ref named "Book" (after "$706") in https://www.google.com/travel/flights');
    });

    it("finds refs in the order the text shows them, not the refs' order", async () => {
        // a consent notice first in the page, read after it
        const page = {
            version: 2,
            url: "https://hotel.example/trips",
            text: '# Trips\n[2] button "Manage booking"\n(a cookie or consent notice, over the page:)\n[1] button "Manage choices"',
            refs: [{ ref: 1, kind: "button", name: "Manage choices" }, { ref: 2, kind: "button", name: "Manage booking" }, { ref: 3, kind: "button", name: "Manage more" }],
        };
        const remote = { read: async () => page };
        // eslint-disable-next-line no-eval
        const p = await (0, eval)(STUB)(remote).tab(2).read();
        expect(p.find("Manage", { after: "Trips" })).toBe(2);
        // ref 3, cut from the text, comes last
        expect(p.findAll("Manage")).toEqual([2, 1, 3]);
    });

    it("lists the tabs as tabs, with what the host says of each", async () => {
        const { code } = stubbed();
        const [tab] = await code.tabs();
        expect(tab).toMatchObject({ id: 4, url: "u", title: "t", working: false });
        expect(typeof tab.click).toBe("function");
    });
});
