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
});
