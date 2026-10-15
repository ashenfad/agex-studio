// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { _setImporterForTesting } from "./cdn.js";
import { mermaidErrorLine, mermaidFallback, redrawKnown, renderMermaidBlocks } from "./mermaid.js";

afterEach(() => _setImporterForTesting(null));

describe("mermaid fallback", () => {
    it("shows the source and a short error line, both escaped", () => {
        const html = mermaidFallback("graph TD\n  A --> <img src=x onerror=alert(1)>", new Error("Parse error on line 2:\nA --> <b\n---^\nExpecting 'NODE', got 'TAGSTART'"));
        expect(html).not.toContain("<img");
        expect(html).not.toContain("<b");
        expect(html).toContain('<code class="mermaid-source">graph TD\n  A --&gt; &lt;img src=x onerror=alert(1)&gt;</code>');
        expect(html).toContain("<span class=\"mermaid-error\">Diagram didn't render: Parse error on line 2: unexpected 'TAGSTART'</span>");
    });

    it("cuts a long error to one readable line", () => {
        expect(mermaidErrorLine(new Error("x".repeat(500)))).toHaveLength(200);
        expect(mermaidErrorLine(new Error("one line"))).toBe("one line");
        expect(mermaidErrorLine("a\n\nb\nc")).toBe("a c");
        expect(mermaidErrorLine(new Error(""))).toBe("unknown error");
    });
});

describe("renderMermaidBlocks", () => {
    /** A container holding one block per source. @param {string[]} sources */
    function page(...sources) {
        const div = document.createElement("div");
        for (const s of sources) {
            const pre = document.createElement("pre");
            pre.className = "mermaid";
            pre.textContent = s;
            div.append(pre);
        }
        return div;
    }

    function fakeMermaid() {
        return {
            initialize: vi.fn(),
            render: vi.fn(async (_id, code) => {
                if (code.includes("bad")) throw new Error("Parse error on line 1:\nbad");
                return { svg: `<svg data-src="${code}"></svg>` };
            }),
        };
    }

    it("draws each block, initializing Mermaid once", async () => {
        const mermaid = fakeMermaid();
        const importer = vi.fn(async () => ({ default: mermaid }));
        _setImporterForTesting(importer);
        const div = page("graph TD", "graph LR");
        await renderMermaidBlocks(div);
        await renderMermaidBlocks(page("graph BT"));
        expect(div.querySelectorAll("svg")).toHaveLength(2);
        expect([...div.querySelectorAll("pre")].every((p) => p.hasAttribute("data-processed"))).toBe(true);
        expect(importer).toHaveBeenCalledTimes(1);
        expect(mermaid.initialize).toHaveBeenCalledTimes(1);
        expect(mermaid.initialize.mock.calls[0][0]).toMatchObject({ securityLevel: "strict" });
    });

    it("draws a source once: a block of it shown again takes that drawing at once", async () => {
        const mermaid = fakeMermaid();
        _setImporterForTesting(async () => ({ default: mermaid }));
        await renderMermaidBlocks(page("flowchart TD; P-->Q"));
        expect(mermaid.render).toHaveBeenCalledTimes(1);
        // the same diagram in a block new to the page: drawn before any await
        const again = page("flowchart TD; P-->Q", "flowchart TD; R-->S");
        redrawKnown(again);
        const [known, other] = again.querySelectorAll("pre");
        expect(known.querySelector("svg")?.getAttribute("data-src")).toBe("flowchart TD; P-->Q");
        expect(known.hasAttribute("data-processed")).toBe(true);
        expect(other.hasAttribute("data-processed")).toBe(false);
        await renderMermaidBlocks(again);
        expect(mermaid.render).toHaveBeenCalledTimes(2);
        expect(mermaid.render.mock.calls[1][1]).toBe("flowchart TD; R-->S");
    });

    it("doesn't keep a diagram that failed", async () => {
        const mermaid = fakeMermaid();
        _setImporterForTesting(async () => ({ default: mermaid }));
        await renderMermaidBlocks(page("bad again"));
        const again = page("bad again");
        redrawKnown(again);
        expect(again.querySelector("pre")?.hasAttribute("data-processed")).toBe(false);
    });

    it("keeps a block's source and says why when it doesn't parse", async () => {
        _setImporterForTesting(async () => ({ default: fakeMermaid() }));
        const div = page("bad graph");
        await renderMermaidBlocks(div);
        const pre = /** @type {Element} */ (div.querySelector("pre"));
        expect(pre.classList.contains("mermaid-failed")).toBe(true);
        expect(pre.querySelector(".mermaid-source")?.textContent).toBe("bad graph");
    });

    it("says Mermaid couldn't load, and tries again for the next diagram", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const importer = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ default: fakeMermaid() });
        _setImporterForTesting(importer);
        const first = page("graph RL");
        await renderMermaidBlocks(first);
        expect(first.querySelector(".mermaid-error")?.textContent).toBe("Diagram didn't render: Mermaid couldn't load.");
        const second = page("graph RL");
        await renderMermaidBlocks(second);
        expect(second.querySelector("svg")).not.toBeNull();
        expect(importer).toHaveBeenCalledTimes(2);
        warn.mockRestore();
    });
});
