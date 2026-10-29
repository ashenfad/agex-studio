import { describe, expect, it } from "vitest";
import { Browser, topOf } from "./browser.js";
import { ExtensionError } from "./browser-extension.svelte.js";
import { browserTool, checkAction, refusalText } from "./browser-tool.js";

/**
 * An extension found, answering each op from `answers` (a value, or a
 * function of the args; an ExtensionError thrown as a refusal), and
 * keeping what it was asked.
 *
 * @param {Record<string, any>} answers
 */
function fakeExtension(answers) {
    /** @type {{ op: string, args: any }[]} */
    const calls = [];
    return {
        status: "found",
        calls,
        async call(/** @type {string} */ op, /** @type {any} */ args) {
            calls.push({ op, args });
            const a = answers[op];
            const value = typeof a === "function" ? a(args) : a;
            if (value instanceof ExtensionError) throw value;
            return value;
        },
    };
}

const outline = { version: 4, url: "https://www.hyatt.com/search", title: "Hyatt", blocker: null, refs: 2, text: "# Results\n[1] button \"Book\" [2] link \"Next\"" };

/** The tool over a fake extension, for session s1 (or a delegate of it). */
function setup(answers = {}, delegate = false) {
    const ext = fakeExtension({ open: { tab: 7 }, read: outline, click: { url: "https://www.hyatt.com/search", title: "Hyatt" }, ...answers });
    const browser = new Browser(/** @type {any} */ (ext));
    const tool = browserTool({ name: delegate ? "s1.d1" : "s1", delegate }, { browser });
    return { ext, browser, tool };
}

describe("the browser service", () => {
    it("works in the top session's tabs, for a delegate too", () => {
        expect(topOf("s1.d1.d2")).toBe("s1");
    });

    it("acts on the latest outline read of the tab, and refuses before any read", async () => {
        const { ext, browser } = setup();
        await expect(browser.act("s1.d1", 7, "click", 1)).rejects.toMatchObject({ code: "stale" });
        await browser.read("s1.d1", 7);
        await browser.act("s1.d1", 7, "click", 1);
        expect(ext.calls.at(-1)).toEqual({ op: "click", args: { session: "s1", tab: 7, version: 4, ref: 1 } });
    });
});

describe("browser's actions", () => {
    it("are one thing each, checked before anything runs", () => {
        expect(checkAction({ read: true })).toEqual({ kind: "read", a: { read: true } });
        expect(checkAction({ open: "ftp://x" })).toEqual({ error: "open: an http or https URL" });
        expect(checkAction({ click: 0 })).toMatchObject({ error: expect.stringMatching(/^click: a ref/) });
        expect(checkAction({ type: 3 })).toMatchObject({ error: expect.stringMatching(/^type: the text/) });
        expect(checkAction({ read: true, click: 2 })).toMatchObject({ error: expect.stringMatching(/^an action does one thing/) });
        expect(checkAction("read")).toEqual({ error: "an action is a plain object, like {read: true}" });
    });
});

describe("the browser tool", () => {
    it("opens a tab, reads it, and acts on it, saying what each step did", async () => {
        const { tool } = setup();
        const out = await tool.call({ actions: [{ open: "https://www.hyatt.com/search?location=Lisbon" }, { read: true }, { click: 1 }] });
        expect(out.isError).toBe(false);
        expect(out.text).toBe(
            [
                "1. open https://www.hyatt.com/search?location=Lisbon: tab 7",
                "2. read tab 7 (outline 4, 2 refs): Hyatt · https://www.hyatt.com/search",
                outline.text,
                "3. click [1]: done, still at https://www.hyatt.com/search",
            ].join("\n"),
        );
    });

    it("stops at the first step that fails, with the ones before it", async () => {
        const { tool, ext } = setup({ goto: new ExtensionError("not-granted", "this session holds no grant for www.ihg.com") });
        const out = await tool.call({ tab: 7, actions: [{ read: true }, { goto: "https://www.ihg.com/" }, { read: true }] });
        expect(out.isError).toBe(true);
        expect(out.text.split("\n").at(-1)).toBe("2. goto failed: this session holds no grant for www.ihg.com. Ask for it with request_sites (the domain, and why), then try again.");
        expect(ext.calls.filter((c) => c.op === "read")).toHaveLength(1);
    });

    it("refuses a step without a tab to work in", async () => {
        const out = await setup().tool.call({ actions: [{ read: true }] });
        expect(out).toMatchObject({ isError: true, text: "1. read failed: no tab: name one (tab: id) or open one first" });
    });

    it("gives a screenshot as an image", async () => {
        const out = await setup({ screenshot: { mime: "image/jpeg", data: "AAAA" } }).tool.call({ tab: 7, actions: [{ screenshot: true }] });
        expect(out.images).toEqual([{ data: "AAAA", format: "jpeg" }]);
        expect(out.text).toBe("1. screenshot tab 7: image 1");
    });

    it("says what a read found: a CAPTCHA, a load stopped, text cut", async () => {
        const out = await setup({ read: { ...outline, blocker: "captcha", blocked: { url: "https://x.example/", at: 1 }, cut: 90000 } }).tool.call({ tab: 7, actions: [{ read: true }] });
        expect(out.text).toMatch(/the page is a CAPTCHA, not the site/);
        expect(out.text).toMatch(/the browser stopped this load: https:\/\/x\.example\/ is on a domain you weren't allowed/);
        expect(out.text).toMatch(/cut at \d+ of 90000 characters/);
    });

    it("lists the session's tabs", async () => {
        const out = await setup({ tabs: [{ id: 7, url: "https://www.hyatt.com/", title: "Hyatt", working: true }] }).tool.call({ actions: [{ tabs: true }] });
        expect(out.text).toBe("1. tabs:\n   tab 7: Hyatt · https://www.hyatt.com/ (working in it)");
    });
});

describe("refusals, for an agent and for a delegate", () => {
    it("send the agent to request_sites, and a delegate to its answer", () => {
        const e = new ExtensionError("not-granted", "no grant for ihg.com");
        expect(refusalText(e, false)).toMatch(/Ask for it with request_sites/);
        expect(refusalText(e, true)).toMatch(/say in your answer which domain you need/);
    });

    it("stop at a committing step, for the person's yes", () => {
        const e = new ExtensionError("confirm", '[6] button "Reserve" reads as a step that commits ("Reserve")');
        expect(refusalText(e, false)).toMatch(/it needs the person's yes\. Tell them what you were about to do, and stop\.$/);
        expect(refusalText(e, true)).toMatch(/Stop here, and say in your answer what you were about to do/);
    });
});
