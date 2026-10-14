import { Inbox, renderNotes } from "@agex-ts/world";
import { describe, expect, it } from "vitest";
import { withAttachments } from "./notes.js";
import { cleanTitle, generateTitle, personTurns, titleDue, transcriptText } from "./titles.js";

let ids = 0;
/** @param {string} role @param {any[]} parts */
const msg = (role, parts) => ({ id: `m${ids++}`, role, parts });
const text = (/** @type {string} */ t) => ({ kind: "text", text: t });
/** @param {any[]} messages */
const run = (messages) => /** @type {any} */ ({ format: 1, runId: `r${ids++}`, status: "completed", messages });

describe("the transcript a name is read from", () => {
    it("says what the person asked, what the agent said, and each tool call", () => {
        const inbox = new Inbox();
        inbox.put("Make it blue.");
        const runs = [
            run([
                msg("user", [text(withAttachments("Chart the sales", ["/workspace/uploads/sales.csv"]))]),
                msg("assistant", [text("Looking."), { kind: "tool_call", callId: "c1", name: "run_ts", args: { code: "load()" } }]),
                msg("tool", [{ kind: "tool_result", callId: "c1", content: `ok${renderNotes(inbox.drain())}`, isError: false, images: [] }]),
                msg("assistant", [text("Done.")]),
            ]),
        ];
        expect(transcriptText(runs)).toBe(
            ['user: Chart the sales (attached: sales.csv)', "assistant: Looking.", '[tool] run_ts {"code":"load()"}', "user: Make it blue.", "assistant: Done."].join("\n"),
        );
    });

    it("keeps the tail, from a whole line", () => {
        const runs = [run([msg("user", [text("a".repeat(50))]), msg("assistant", [text("b".repeat(50))])])];
        expect(transcriptText(runs, 70)).toBe(`assistant: ${"b".repeat(50)}`);
    });
});

describe("when the model names a session", () => {
    it("counts the person's turns, not the ones answers woke", () => {
        const woken = "---- inbox ----\n[delegate lead.a — answered]\nDone.\n---- /inbox:40 ----";
        const runs = [run([msg("user", [text("Go")])]), run([msg("user", [text(woken)])])];
        expect(personTurns(runs)).toBe(1);
    });

    it("after the first exchange, every five turns after, and never once the person named it", () => {
        expect(titleDue(null, 0)).toBe(false);
        expect(titleDue(null, 1)).toBe(true);
        expect(titleDue({ titledAt: 1 }, 5)).toBe(false);
        expect(titleDue({ titledAt: 1 }, 6)).toBe(true);
        expect(titleDue({ named: true }, 9)).toBe(false);
    });
});

describe("a name", () => {
    it("is one clean line, bounded", () => {
        expect(cleanTitle('  "Revenue\n dashboard."  ')).toBe("Revenue dashboard");
        expect(cleanTitle("Title: CSV import fixes")).toBe("CSV import fixes");
        expect(cleanTitle("   ")).toBeNull();
        expect(cleanTitle(7)).toBeNull();
        expect(cleanTitle("x".repeat(80))?.length).toBe(60);
    });

    it("comes from one model call over the transcript", async () => {
        /** @type {any} */
        let asked = null;
        const model = {
            doGenerate: async (/** @type {any} */ call) => {
                asked = call;
                return { content: [{ type: "reasoning", text: "hmm" }, { type: "text", text: "Sales chart." }] };
            },
        };
        expect(await generateTitle(model, "user: Chart the sales")).toBe("Sales chart");
        expect(asked.prompt[0].role).toBe("system");
        expect(asked.prompt[1].content[0].text).toBe("user: Chart the sales");
    });
});
