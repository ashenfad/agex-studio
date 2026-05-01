import { describe, it, expect } from "vitest";
import { renderMarkdown } from "./markdown.js";

describe("renderMarkdown", () => {
    it("renders basic text", () => {
        const html = renderMarkdown("hello world");
        expect(html).toContain("hello world");
    });

    it("renders bold and italic", () => {
        const html = renderMarkdown("**bold** and *italic*");
        expect(html).toContain("<strong>bold</strong>");
        expect(html).toContain("<em>italic</em>");
    });

    it("renders inline code", () => {
        const html = renderMarkdown("use `foo()` here");
        expect(html).toContain("<code>foo()</code>");
    });

    it("renders fenced code blocks", () => {
        const html = renderMarkdown("text\n```python\nprint(1)\n```");
        expect(html).toContain("<pre>");
        expect(html).toContain("print(1)");
    });

    it("renders links", () => {
        const html = renderMarkdown("[click](http://example.com)");
        expect(html).toContain('href="http://example.com"');
        expect(html).toContain("click");
    });
});

describe("prepare (via renderMarkdown)", () => {
    it("inserts blank line before unordered list after text", () => {
        const html = renderMarkdown("text\n- item1\n- item2");
        expect(html).toContain("<ul>");
        expect(html).toContain("<li>");
    });

    it("inserts blank line before ordered list after text", () => {
        const html = renderMarkdown("text\n1. first\n2. second");
        expect(html).toContain("<ol>");
        expect(html).toContain("<li>");
    });

    it("inserts blank line before heading after text", () => {
        const html = renderMarkdown("text\n## Heading");
        expect(html).toContain("<h2");
        expect(html).toContain("Heading");
    });

    it("inserts blank line before fenced code after text", () => {
        const html = renderMarkdown("text\n```\ncode\n```");
        expect(html).toContain("<pre>");
        expect(html).toContain("code");
    });

    it("renders mermaid blocks as pre.mermaid", () => {
        const html = renderMarkdown("```mermaid\ngraph TD\n```");
        expect(html).toContain('<pre class="mermaid">');
        expect(html).toContain("graph TD");
    });

    // ---- vfs: scheme link rendering ----------------------------

    it("renders [label](vfs:path) as a vfs-download anchor", () => {
        const html = renderMarkdown("[chart](vfs:output.png)");
        expect(html).toContain('class="vfs-download"');
        expect(html).toContain('data-vfs-path="output.png"');
        expect(html).toContain(">chart</a>");
    });

    it("preserves slashes in nested vfs paths", () => {
        const html = renderMarkdown("[r](vfs:reports/2026/q1.pdf)");
        expect(html).toContain('data-vfs-path="reports/2026/q1.pdf"');
    });

    it("escapes vfs paths with special characters", () => {
        // Path containing characters that would break attribute syntax —
        // encodeURIComponent prevents them from escaping the attribute
        // value.  The encoded form lands in data-vfs-path; the click
        // handler decodes back before passing to downloadFile.
        const html = renderMarkdown('[bad](vfs:weird"name<x>.png)');
        // Quotes and angle brackets are URL-encoded, not raw.
        expect(html).toContain("data-vfs-path=");
        expect(html).toContain("%22"); // quote
        expect(html).toContain("%3C"); // <
        expect(html).toContain("%3E"); // >
        expect(html).toContain('class="vfs-download"');
    });

    it("leaves http(s) links as ordinary anchors", () => {
        const html = renderMarkdown("[home](https://example.com)");
        expect(html).toContain('href="https://example.com"');
        expect(html).not.toContain("vfs-download");
    });

    it("leaves relative links as ordinary anchors", () => {
        const html = renderMarkdown("[help](/help)");
        expect(html).toContain('href="/help"');
        expect(html).not.toContain("vfs-download");
    });

    it("supports multiple vfs links inline alongside prose", () => {
        const html = renderMarkdown(
            "Saved [a](vfs:a.png) and [b](vfs:b.png) — done."
        );
        expect(html).toContain('data-vfs-path="a.png"');
        expect(html).toContain('data-vfs-path="b.png"');
        // Surrounding prose stays intact
        expect(html).toContain("Saved ");
        expect(html).toContain(" and ");
        expect(html).toContain(" — done.");
    });
});
