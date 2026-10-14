import { Inbox, renderNotes } from "@agex-ts/world";
import { describe, expect, it } from "vitest";
import { attachmentsOf, notesIn, withAttachments } from "./notes.js";

describe("attachments", () => {
    it("go first, for the agent, and come back off for the chat", () => {
        const text = withAttachments("Chart it.", ["/workspace/uploads/a.csv", "/workspace/uploads/b.png"]);
        expect(text).toBe('[attached: ["/workspace/uploads/a.csv","/workspace/uploads/b.png"]]\nChart it.');
        expect(attachmentsOf(text)).toEqual({ paths: ["/workspace/uploads/a.csv", "/workspace/uploads/b.png"], text: "Chart it." });
        expect(withAttachments("Hi", [])).toBe("Hi");
        expect(attachmentsOf("Hi [attached: x]")).toEqual({ paths: [], text: "Hi [attached: x]" });
        expect(attachmentsOf("[attached: not json]\nHi")).toEqual({ paths: [], text: "[attached: not json]\nHi" });
    });

    it("read back names with commas, brackets and line breaks whole", () => {
        const odd = ["/workspace/uploads/Smith, Jane.csv", "/workspace/uploads/a]b [c].txt", "/workspace/uploads/two\nlines.md"];
        const text = withAttachments("Merge these.\n[attached: no]", odd);
        expect(text.split("\n")[0]?.startsWith("[attached: [")).toBe(true);
        expect(attachmentsOf(text)).toEqual({ paths: odd, text: "Merge these.\n[attached: no]" });
    });
});

describe("notes delivered with a result", () => {
    it("come apart from the result, the person's and the mechanism's", () => {
        const inbox = new Inbox();
        inbox.put("Use blue, not red.\n\nAnd bigger.");
        inbox.put("Found three facts.", { kind: "mechanism", label: "delegate lead.scout" });
        const result = `wrote app/main.js${renderNotes(inbox.drain())}`;
        expect(notesIn(result)).toEqual({
            bare: "wrote app/main.js",
            notes: [
                { kind: "principal", label: "", text: "Use blue, not red.\n\nAnd bigger." },
                { kind: "mechanism", label: "delegate lead.scout", text: "Found three facts." },
            ],
        });
    });

    it("leave a result without any as it is", () => {
        expect(notesIn("ok\n---- inbox ----\nnot a block")).toEqual({ bare: "ok\n---- inbox ----\nnot a block", notes: [] });
    });
});
