// @vitest-environment jsdom
// DOMPurify needs a DOM to sanitize against — and specifically jsdom,
// not happy-dom: under happy-dom 20.x DOMPurify reports isSupported
// but mis-sanitizes (drops <strong>, passes <script> through), so the
// sanitization tests below would silently test the wrong thing.
import { describe, it, expect } from "vitest";
import { renderMarkdown, renderMarkdownInline } from "./markdown.js";

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

describe("renderMarkdownInline", () => {
    it("renders inline emphasis without a wrapping paragraph", () => {
        const html = renderMarkdownInline("**bold** and *italic*");
        expect(html).toContain("<strong>bold</strong>");
        expect(html).toContain("<em>italic</em>");
        // Inline mode → no <p> wrapper (block-mode would add one).
        expect(html).not.toContain("<p>");
    });

    it("renders inline code", () => {
        const html = renderMarkdownInline("use `foo()` here");
        expect(html).toContain("<code>foo()</code>");
    });

    it("renders links (with vfs: handling intact)", () => {
        const html = renderMarkdownInline("[open](vfs:doc.pdf)");
        expect(html).toContain('class="vfs-download"');
        expect(html).toContain('data-vfs-path="doc.pdf"');
    });

    it("does NOT produce block elements (no paragraphs, no headings, no lists)", () => {
        // Block-shaped source — parseInline refuses to expand block
        // structures even when the markdown asks for them.
        const html = renderMarkdownInline("# heading\n- item 1\n- item 2");
        expect(html).not.toContain("<h1>");
        expect(html).not.toContain("<ul>");
        expect(html).not.toContain("<li>");
    });

    it("flattens embedded newlines to spaces (keeps cells single-line)", () => {
        // With `breaks: true`, a raw single-line render would inject
        // `<br>`. The preprocessor strips newlines so table cells
        // stay one line tall — important for fixed-row-height
        // virtualization in DataTable.
        const html = renderMarkdownInline("first\nsecond");
        expect(html).not.toContain("<br");
        expect(html).toContain("first second");
    });

    it("coerces non-string inputs via String()", () => {
        // Defensive — DataTable filters non-strings before calling,
        // but the helper itself should handle accidental misuse.
        expect(renderMarkdownInline(42)).toContain("42");
    });
});

describe("sanitization", () => {
    // Markdown reaching these renderers can come from an imported
    // session bundle (gist link) — VFS files, chapter summaries, and
    // chat history are all attacker-controlled in that path, and the
    // output lands in {@html} on the origin holding API keys. These
    // tests pin the DOMPurify pass that closes that hole.

    it("strips <script> tags", () => {
        const html = renderMarkdown('hello <script>alert(1)</script> world');
        expect(html).not.toContain("<script");
        expect(html).toContain("hello");
        expect(html).toContain("world");
    });

    it("strips event-handler attributes", () => {
        const html = renderMarkdown('<img src="x" onerror="alert(1)">');
        expect(html).not.toContain("onerror");
    });

    it("strips javascript: hrefs from markdown links", () => {
        const html = renderMarkdown("[click](javascript:alert(1))");
        expect(html).not.toContain("javascript:");
    });

    it("strips javascript: hrefs from raw anchors", () => {
        const html = renderMarkdown('<a href="javascript:alert(1)">x</a>');
        expect(html).not.toContain("javascript:");
    });

    it("strips iframes and embeds", () => {
        const html = renderMarkdown(
            '<iframe src="https://evil.example"></iframe><embed src="x">'
        );
        expect(html).not.toContain("<iframe");
        expect(html).not.toContain("<embed");
    });

    it("entity-escapes mermaid source instead of injecting it", () => {
        const html = renderMarkdown(
            '```mermaid\n</pre><img src=x onerror=alert(1)>\n```'
        );
        // No live tag — the payload survives only as escaped text
        // ("onerror" as inert text content is fine; an <img> element
        // carrying it is not).
        expect(html).not.toContain("<img");
        expect(html).toContain('<pre class="mermaid">');
        // The source survives as escaped text (textContent decodes it
        // back for mermaid.render).
        expect(html).toContain("&lt;/pre&gt;&lt;img src=x onerror=alert(1)&gt;");
    });

    it("keeps benign markup: vfs links, callouts, code, emphasis", () => {
        const html = renderMarkdown(
            "> [!NOTE]\n> heads up\n\n**bold** [f](vfs:a.png) `code`"
        );
        expect(html).toContain('class="callout callout-note"');
        expect(html).toContain('data-vfs-path="a.png"');
        expect(html).toContain("<strong>bold</strong>");
        expect(html).toContain("<code>code</code>");
    });

    it("sanitizes renderMarkdownInline output too", () => {
        const html = renderMarkdownInline('<img src="x" onerror="alert(1)">');
        expect(html).not.toContain("onerror");
    });
});
