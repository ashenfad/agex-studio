import { describe, expect, it } from "vitest";
import { Browser, topOf } from "./browser.js";
import { ExtensionError } from "./browser-extension.svelte.js";
import { BrowserAsks } from "./browser-asks.svelte.js";
import { browserTool, checkAction, refusalText, stepText } from "./browser-tool.js";

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

const outline = { version: 4, url: "https://www.hyatt.com/search", title: "Hyatt", blocker: null, refs: [{ ref: 1, kind: "button", name: "Book" }, { ref: 2, kind: "link", name: "Next" }], text: "# Results\n[1] button \"Book\" [2] link \"Next\"" };

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

    it("acts on the outline version the caller names, and refuses without one", async () => {
        const { ext, browser } = setup();
        await expect(browser.act("s1.d1", 7, "click", undefined, 1)).rejects.toMatchObject({ code: "stale" });
        await browser.act("s1.d1", 7, "click", 4, 1);
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
        expect(checkAction({ close: false })).toEqual({ error: "close: true, {close: true}" });
        expect(checkAction({ tabs: "yes" })).toEqual({ error: "tabs: true, {tabs: true}" });
        expect(checkAction({ press: 3 })).toEqual({ error: 'press: the key, {press: 12, key: "Enter"}' });
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

    it("presses a key on a ref, on the latest read", async () => {
        const { tool, ext } = setup({ press: { url: "https://www.hyatt.com/search", title: "Hyatt" } });
        const out = await tool.call({ tab: 7, actions: [{ read: true }, { press: 2, key: "Enter" }] });
        expect(out.text.split("\n").at(-1)).toBe("2. press [2] Enter: done, still at https://www.hyatt.com/search");
        expect(ext.calls.at(-1)).toEqual({ op: "press", args: { session: "s1", tab: 7, version: 4, ref: 2, key: "Enter" } });
    });

    it("acts on a ref named by name, found in the agent's latest read", async () => {
        const calendar = {
            ...outline,
            text: "## January 2027\n[1] button \"24\"\n## February 2027\n[2] button \"23\" [3] button \"24\"",
            refs: [{ ref: 1, kind: "button", name: "24" }, { ref: 2, kind: "button", name: "23" }, { ref: 3, kind: "button", name: "24" }],
        };
        const { tool, ext } = setup({ read: calendar });
        const out = await tool.call({ tab: 7, actions: [{ read: true }, { click: { name: "24", after: "February 2027" } }] });
        expect(out.text.split("\n").at(-1)).toBe('2. click [3] "24": done, still at https://www.hyatt.com/search');
        expect(ext.calls.at(-1)?.args).toMatchObject({ version: 4, ref: 3 });

        const none = await tool.call({ tab: 7, actions: [{ click: { name: "31", after: "February 2027" } }] });
        expect(none).toMatchObject({ isError: true, text: '1. click failed: no ref named "31" (after "February 2027") in your latest read of tab 7: read it again, or name the ref by its number' });
        const unread = await tool.call({ tab: 8, actions: [{ click: { name: "24" } }] });
        expect(unread.text).toBe("1. click failed: tab 8 hasn't been read here yet: read it, then name a ref");
        expect(checkAction({ click: { name: "" } })).toMatchObject({ error: expect.stringMatching(/or one by name/) });
        expect(checkAction({ type: { name: "Where", kind: "textbox" }, text: "Lisbon" })).toMatchObject({ kind: "type" });
    });

    it("gives a screenshot as an image", async () => {
        const out = await setup({ screenshot: { mime: "image/jpeg", data: "AAAA" } }).tool.call({ tab: 7, actions: [{ screenshot: true }] });
        expect(out.images).toEqual([{ data: "AAAA", format: "jpeg" }]);
        expect(out.text).toBe("1. screenshot tab 7: image 1");
    });

    it("says when the page goes on below, and when it never settled", async () => {
        const out = await setup({ read: { ...outline, below: 3.5, settled: false } }).tool.call({ tab: 7, actions: [{ read: { settle: true } }] });
        expect(out.text).toMatch(/the page goes on 3\.5 screenfuls below: a list there may load more as it's scrolled \(scroll: "bottom"\)/);
        expect(out.text).toMatch(/the page was still changing when this was read/);
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

describe("each agent's own outline", () => {
    it("is what its actions name, though a delegate read the tab since", async () => {
        let version = 0;
        const { ext } = setup({ read: () => ({ ...outline, version: ++version }) });
        const browser = new Browser(/** @type {any} */ (ext));
        const parent = browserTool({ name: "p1" }, { browser });
        const child = browserTool({ name: "p1.d1", delegate: true }, { browser });
        await parent.call({ tab: 7, actions: [{ read: true }] });
        await child.call({ tab: 7, actions: [{ read: true }] });
        await parent.call({ tab: 7, actions: [{ click: 1 }] });
        expect(ext.calls.filter((c) => c.op === "click").map((c) => c.args.version)).toEqual([1]);
    });
});

describe("refusals, for an agent and for a delegate", () => {
    it("send the agent to request_sites, and a delegate to its answer", () => {
        const e = new ExtensionError("not-granted", "no grant for ihg.com");
        expect(refusalText(e, false)).toMatch(/Ask for it with request_sites/);
        expect(refusalText(e, true)).toMatch(/say in your answer which domain you need/);
    });

    it("stop a delegate at a committing step, for the person's yes", () => {
        const e = new ExtensionError("confirm", '[6] button "Reserve" reads as a step that commits ("Reserve")');
        expect(refusalText(e, true)).toMatch(/Stop here, and say in your answer what you were about to do/);
    });
});

/** Wait for a card to open. */
const opened = () => new Promise((r) => setTimeout(r, 0));

/** An extension refusing a click as committing until it's confirmed. */
const committing = () => ({
    tabs: [{ id: 7, url: "https://www.hyatt.com/book", title: "Book", working: true }],
    click: (/** @type {any} */ args) =>
        args.confirmed ? { url: "https://www.hyatt.com/booked", title: "Booked", navigated: true } : new ExtensionError("confirm", '[1] button "Book" reads as a step that commits ("Book")'),
});

describe("a committing step", () => {
    it("asks the person, and is taken on their yes", async () => {
        const { ext } = setup(committing());
        const asks = new BrowserAsks();
        const t = browserTool({ name: "s1" }, { browser: new Browser(/** @type {any} */ (ext)), asks });
        const pending = t.call({ tab: 7, actions: [{ read: true }, { click: 1 }] });
        await opened();
        expect(asks.openConfirm("s1")).toMatchObject({ kind: "confirm", tab: 7, title: "Book", url: "https://www.hyatt.com/book", step: 'Click button "Book"' });
        asks.answer("s1", true);
        const out = await pending;
        expect(out.isError).toBe(false);
        expect(out.text).toMatch(/2\. click \[1\]: the person confirmed it\n2\. click \[1\]: went to Booked/);
        expect(ext.calls.filter((c) => c.op === "click").map((c) => c.args.confirmed)).toEqual([undefined, true]);
    });

    it("isn't taken on their no, and stops the call there", async () => {
        const { ext } = setup(committing());
        const asks = new BrowserAsks();
        const t = browserTool({ name: "s1" }, { browser: new Browser(/** @type {any} */ (ext)), asks });
        const pending = t.call({ tab: 7, actions: [{ read: true }, { click: 1 }, { read: true }] });
        await opened();
        asks.answer("s1", false);
        const out = await pending;
        expect(out.isError).toBe(false);
        expect(out.text).toMatch(/the person said no to it .* Don't take it another way/);
        expect(ext.calls.filter((c) => c.op === "click")).toHaveLength(1);
        expect(ext.calls.filter((c) => c.op === "read")).toHaveLength(1);
    });

    it("gives the card back when the turn ends first", async () => {
        const { ext } = setup(committing());
        const asks = new BrowserAsks();
        const t = browserTool({ name: "s1" }, { browser: new Browser(/** @type {any} */ (ext)), asks });
        const stop = new AbortController();
        const pending = t.call({ tab: 7, actions: [{ read: true }, { click: 1 }] }, { signal: stop.signal });
        await opened();
        stop.abort();
        expect((await pending).text).toMatch(/click failed: the turn ended before the person answered$/);
        expect(asks.openConfirm("s1")).toBeUndefined();
    });
});

describe("a committing step, as the person reads it", () => {
    it("is a click, a key on a control, or Enter in a field that submits its form", () => {
        expect(stepText('[5] button "Reserve" reads as a step that commits ("Reserve")')).toBe('Click button "Reserve"');
        expect(stepText('Space on [5] button "Reserve" reads as a step that commits ("Reserve")')).toBe('Press Space on button "Reserve"');
        expect(stepText('Enter in [3] input "Card name", submitting its form by "Pay now", reads as a step that commits ("Pay")')).toBe(
            'Press Enter in input "Card name", submitting its form by "Pay now"',
        );
    });
});

describe("scrolling and settling", () => {
    it("scrolls with the wheel, and reads after the page settles", async () => {
        const { tool, ext } = setup({ scroll: { top: 2000, below: 0 } });
        const out = await tool.call({ tab: 7, actions: [{ scroll: "bottom" }, { read: { settle: true } }] });
        expect(out.text).toMatch(/^1\. scroll tab 7: at the bottom\. Read it again to see what loaded\./);
        expect(ext.calls.find((c) => c.op === "scroll")?.args).toEqual({ session: "s1", tab: 7, to: "bottom" });
        expect(ext.calls.find((c) => c.op === "read")?.args).toMatchObject({ settle: true });
    });

    it("refuses a scroll that isn't down or to the bottom", () => {
        expect(checkAction({ scroll: "up" })).toEqual({ error: 'scroll: "down" (a screenful) or "bottom"' });
        expect(checkAction({ scroll: true })).toEqual({ kind: "scroll", a: { scroll: true } });
    });
});

describe("a browser the person stopped", () => {
    /** An extension stopped until it's resumed. */
    const stoppedUntilResumed = () => {
        let stopped = true;
        return {
            resume: () => ((stopped = false), null),
            read: () => (stopped ? new ExtensionError("stopped", "Chrome's debugging bar was cancelled, which stops the agent's work in every tab (not one tab), until the person lets it go on") : outline),
        };
    };

    it("asks the person whether to go on, and on their word goes on with the step", async () => {
        const { ext } = setup(stoppedUntilResumed());
        const asks = new BrowserAsks();
        const pending = browserTool({ name: "g1" }, { browser: new Browser(/** @type {any} */ (ext)), asks }).call({ tab: 7, actions: [{ read: true }] });
        await opened();
        expect(asks.openGoOn("g1")).toMatchObject({ kind: "go-on" });
        asks.answer("g1", true);
        const out = await pending;
        expect(out.isError).toBe(false);
        expect(out.text).toMatch(/^1\. read: the person let you go on \(Chrome's debugging bar had been cancelled\)\n1\. read tab 7 \(outline 4/);
        expect(ext.calls.map((c) => c.op)).toEqual(["read", "resume", "read"]);
    });

    it("stops the call when they keep it stopped", async () => {
        const { ext } = setup(stoppedUntilResumed());
        const asks = new BrowserAsks();
        const pending = browserTool({ name: "g2" }, { browser: new Browser(/** @type {any} */ (ext)), asks }).call({ tab: 7, actions: [{ read: true }, { click: 1 }] });
        await opened();
        asks.answer("g2", false);
        const out = await pending;
        expect(out).toMatchObject({ isError: false });
        expect(out.text).toMatch(/the person keeps the browser stopped\. Don't use it until they say so/);
        expect(ext.calls.map((c) => c.op)).toEqual(["read"]);
    });

    it("stops a delegate, to say so in its answer", async () => {
        const out = await setup(stoppedUntilResumed(), true).tool.call({ tab: 7, actions: [{ read: true }] });
        expect(out.isError).toBe(true);
        expect(out.text).toMatch(/not one tab\), until the person lets it go on\. Stop here, and say in your answer that the browser was stopped/);
    });
});

describe("a handoff", () => {
    it("brings the tab to the front, and waits for the person's Done", async () => {
        const { ext } = setup({ tabs: [{ id: 7, url: "https://www.hyatt.com/", title: "Hyatt", working: false }], show: null });
        const asks = new BrowserAsks();
        const t = browserTool({ name: "s1" }, { browser: new Browser(/** @type {any} */ (ext)), asks });
        const pending = t.call({ tab: 7, actions: [{ handoff: "solve the CAPTCHA" }] });
        await opened();
        expect(asks.openHandoff("s1")).toMatchObject({ kind: "handoff", what: "solve the CAPTCHA", tab: 7, title: "Hyatt" });
        expect(ext.calls.map((c) => c.op)).toContain("show");
        asks.answer("s1", true);
        expect((await pending).text).toBe("1. handoff tab 7: the person says it's done. Read the tab again before acting in it.");
    });

    it("fails the step, with no card, when the tab can't be shown", async () => {
        const { ext } = setup({ tabs: [], show: new ExtensionError("not-found", "tab 7 isn't one of this session's") });
        const asks = new BrowserAsks();
        const out = await browserTool({ name: "s1" }, { browser: new Browser(/** @type {any} */ (ext)), asks }).call({ tab: 7, actions: [{ handoff: "log in" }] });
        expect(out).toMatchObject({ isError: true, text: "1. handoff failed: tab 7 isn't one of this session's. {tabs: true} lists the session's tabs." });
        expect(asks.asks.asking).toEqual({});
    });

    it("makes the agent read the tab again after it", async () => {
        const { ext } = setup({ tabs: [], show: null });
        const asks = new BrowserAsks();
        const t = browserTool({ name: "h1" }, { browser: new Browser(/** @type {any} */ (ext)), asks });
        const pending = t.call({ tab: 7, actions: [{ read: true }, { handoff: "log in" }, { click: 1 }] });
        await opened();
        asks.answer("h1", true);
        expect((await pending).text).toMatch(/3\. click failed: tab 7 hasn't been read here yet; read it first$/);
    });

    it("is refused to a delegate", async () => {
        const out = await setup({}, true).tool.call({ tab: 7, actions: [{ handoff: "log in" }] });
        expect(out.isError).toBe(true);
        expect(out.text).toMatch(/^a delegate can't hand a tab to the person/);
    });
});
