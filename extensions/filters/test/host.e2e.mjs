// The agent inside the extension: a scripted turn in a session runs code
// in the sandbox's kernel, its store kept by the offscreen document, and
// the agent's code can reach no network.
//
//     pnpm filters:test

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { build } from "../build.mjs";
import { launch } from "./harness.mjs";

/** A scripted model's reply. */
const step = (text, calls = []) => ({ kind: "model", text, thinking: "", tool_calls: calls, fail: "", input_tokens: 0 });
const runTs = (code) => ({ name: "run_ts", args: { code } });

describe("the agent in the extension", () => {
    /** @type {Awaited<ReturnType<typeof launch>>} */
    let browser;
    /** @type {import("playwright").Page} */
    let page;
    /** An op of the worker's, from a page of the extension's. */
    const op = async (name, args = {}) => {
        const reply = await page.evaluate((msg) => chrome.runtime.sendMessage(msg), { op: name, ...args });
        if (reply?.error !== undefined) throw new Error(reply.error);
        return reply?.value;
    };
    before(async () => {
        browser = await launch(await build("dev"));
        page = await browser.context.newPage();
        await page.goto(`chrome-extension://${browser.id}/manifest.json`);
    });
    after(() => browser?.close());

    it("runs a turn's code in the sandbox's kernel, and keeps what it wrote", async () => {
        const out = await op("scripted", {
            site: "example.com",
            prompt: "try the kernel",
            steps: [
                step("", [runTs("const xs: number[] = [1, 2, 3, 4]\nconsole.log('sum', xs.reduce((a, b) => a + b, 0))\nawait fs.write('notes.txt', 'kept')")]),
                step("Done."),
            ],
        });
        assert.equal(out.status, "completed");
        assert.equal(out.text, "Done.");
        assert.deepEqual(out.tools.map((t) => [t.name, t.isError, t.result.trim()]), [["run_ts", false, "sum 10"]]);
        assert.equal(await op("read", { site: "example.com", path: "notes.txt" }), "kept");
    });

    it("lets the agent's code reach no network", async () => {
        const out = await op("scripted", {
            site: "example.com",
            prompt: "try the network",
            steps: [step("", [runTs("const r = await fetch('https://example.com/')\nconsole.log(r.status)")]), step("Done.")],
        });
        assert.equal(out.tools[0].isError, true, out.tools[0].result);
        assert.match(out.tools[0].result, /fetch|Content Security Policy|connect/i);
    });

    it("takes the model's failure across the wall as it was: one worth resuming interrupts the turn", async () => {
        const out = await op("scripted", { site: "example.org", prompt: "fail", steps: [{ ...step(""), fail: "provider" }] });
        assert.equal(out.status, "interrupted");
    });

    it("runs one turn at a time, whatever the site", async () => {
        const slow = "await new Promise((ok) => setTimeout(ok, 1500))\nconsole.log('slow')";
        const [a, b] = await Promise.all([
            op("scripted", { site: "a.example", prompt: "first", steps: [step("", [runTs(slow)]), step("a")] }),
            op("scripted", { site: "b.example", prompt: "second", steps: [step("b")] }),
        ]);
        // each turn's own script, though the second was asked while the first ran
        assert.equal(a.text, "a");
        assert.equal(b.text, "b");
    });

    it("keeps its sessions when the offscreen document closes", async () => {
        await op("restart");
        assert.deepEqual(await op("sites"), ["a.example", "b.example", "example.com", "example.org"]);
        assert.equal(await op("runs", { site: "example.com" }), 2);
        assert.equal(await op("read", { site: "example.com", path: "notes.txt" }), "kept");
    });
});
