import { Inbox, renderNotes } from "@agex-ts/world";
import { describe, expect, it } from "vitest";
import { attachmentsOf, notesIn, sharesOf, withAttachments, withShares, wordsOf } from "./notes.js";

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

describe("tabs a message shares", () => {
    const shares = [
        { tab: 9, title: 'Inbox "3" ] [new', url: "https://mail.example/inbox", domain: "mail.example", acts: true },
        { tab: 4, title: "Order", url: "https://shop.example/o?id=1", domain: "shop.example", acts: false },
    ];

    it("are named first, a line each, after the files attached, and read back whole", () => {
        const message = withAttachments(withShares("Summarize this", shares), ["/workspace/uploads/a.pdf"]);
        expect(message).toBe(
            '[attached: ["/workspace/uploads/a.pdf"]]\n' +
                '[shared tab 9: "Inbox \\"3\\" ] [new" · https://mail.example/inbox; you may act in it while it\'s on mail.example]\n' +
                "[shared tab 4: \"Order\" · https://shop.example/o?id=1; read only while it's on shop.example]\n" +
                "Summarize this",
        );
        const { paths, text } = attachmentsOf(message);
        expect(paths).toEqual(["/workspace/uploads/a.pdf"]);
        expect(sharesOf(text)).toEqual({ shares, text: "Summarize this" });
        expect(wordsOf(message)).toBe("Summarize this");
    });

    it("leave a message that names none as it is", () => {
        expect(withShares("hi", [])).toBe("hi");
        expect(sharesOf("[shared tab x: nope]\nhi")).toEqual({ shares: [], text: "[shared tab x: nope]\nhi" });
    });
});
