// @vitest-environment jsdom
// DOMPurify needs a DOM to sanitize against — and specifically jsdom,
// not happy-dom: under happy-dom 20.x DOMPurify reports isSupported
// but mis-sanitizes (drops <strong>, passes <script> through), so the
// sanitization tests below would silently test the wrong thing.
import { describe, it, expect } from "vitest";
import { renderMarkdown, renderMarkdownInline, renderTableCell, workspacePath } from "./markdown.js";

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

    // ---- workspace file links ----------------------------------

    it("renders a /workspace path as a file link", () => {
        const html = renderMarkdown("[the plan](/workspace/notes/plan.md)");
        expect(html).toContain('class="ws-file"');
        expect(html).toContain('data-ws-path="/workspace/notes/plan.md"');
        expect(html).toContain('href="#"');
        expect(html).toContain(">the plan</a>");
    });

    it("resolves a relative path against /workspace", () => {
        expect(renderMarkdown("[p](notes/plan.md)")).toContain('data-ws-path="/workspace/notes/plan.md"');
        expect(renderMarkdown("[p](./notes/plan.md)")).toContain('data-ws-path="/workspace/notes/plan.md"');
    });

    it("renders the link's inline markdown", () => {
        const html = renderMarkdown("[**the** `plan`](notes/plan.md)");
        expect(html).toContain("<strong>the</strong>");
        expect(html).toContain("<code>plan</code>");
    });

    it("renders a path that climbs out of /workspace as text alone", () => {
        for (const href of ["../etc/passwd", "/workspace/../etc/passwd", "notes/../../x"]) {
            const html = renderMarkdown(`[secret](${href})`);
            expect(html).not.toContain("<a");
            expect(html).not.toContain("data-ws-path");
            expect(html).toContain("secret");
        }
    });

    it("leaves URLs, fragments and other root paths as ordinary anchors", () => {
        const cases = {
            "https://example.com/a.md": 'href="https://example.com/a.md"',
            "http://example.com": 'href="http://example.com"',
            "mailto:someone@example.com": 'href="mailto:someone@example.com"',
            "#section": 'href="#section"',
            "//example.com/a.md": 'href="//example.com/a.md"',
            "/help": 'href="/help"',
            "/workspaces/x.md": 'href="/workspaces/x.md"',
        };
        for (const [href, expected] of Object.entries(cases)) {
            const html = renderMarkdown(`[x](${href})`);
            expect(html, href).toContain(expected);
            expect(html, href).not.toContain("ws-file");
            expect(html, href).not.toContain("data-ws-path");
        }
    });

    it("escapes a path with special characters in the attribute", () => {
        const html = renderMarkdown('[bad](<weird"name<x>.md>)');
        const doc = new DOMParser().parseFromString(html, "text/html");
        const a = doc.querySelector("a.ws-file");
        expect(a?.getAttribute("data-ws-path")).toBe('/workspace/weird"name<x>.md');
        expect(doc.querySelectorAll("a").length).toBe(1);
    });

    it("supports several file links inline alongside prose", () => {
        const html = renderMarkdown("Saved [a](a.png) and [b](/workspace/b.png) — done.");
        expect(html).toContain('data-ws-path="/workspace/a.png"');
        expect(html).toContain('data-ws-path="/workspace/b.png"');
        expect(html).toContain("Saved ");
        expect(html).toContain(" — done.");
    });
});

describe("workspacePath", () => {
    it("normalizes a path under /workspace", () => {
        expect(workspacePath("/workspace/notes/plan.md")).toBe("/workspace/notes/plan.md");
        expect(workspacePath("notes//./plan.md")).toBe("/workspace/notes/plan.md");
        expect(workspacePath("notes/old/../plan.md")).toBe("/workspace/notes/plan.md");
        expect(workspacePath("my%20plan.md")).toBe("/workspace/my plan.md");
        expect(workspacePath("notes/plan.md#intro")).toBe("/workspace/notes/plan.md");
    });

    it("names no file for a URL, an escape, or /workspace itself", () => {
        for (const href of ["https://x.y", "mailto:a@b.c", "#top", "//x.y/a", "/help", "", "..", "../x", "/workspace", "/workspace/", "%E0%A4%A"]) {
            expect(workspacePath(href), href).toBeNull();
        }
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

    it("renders workspace file links", () => {
        const html = renderMarkdownInline("[open](docs/doc.pdf)");
        expect(html).toContain('class="ws-file"');
        expect(html).toContain('data-ws-path="/workspace/docs/doc.pdf"');
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

    it("keeps benign markup: file links, callouts, code, emphasis", () => {
        const html = renderMarkdown(
            "> [!NOTE]\n> heads up\n\n**bold** [f](/workspace/a.png) `code`"
        );
        expect(html).toContain('class="callout callout-note"');
        expect(html).toContain('data-ws-path="/workspace/a.png"');
        expect(html).toContain("<strong>bold</strong>");
        expect(html).toContain("<code>code</code>");
    });

    it("strips script vectors from a file link's text and title", () => {
        const html = renderMarkdown('[<img src=x onerror=alert(1)>](notes/a.md "x\\" onclick=\\"alert(1)")');
        const doc = new DOMParser().parseFromString(html, "text/html");
        const a = doc.querySelector("a.ws-file");
        expect(a?.getAttribute("data-ws-path")).toBe("/workspace/notes/a.md");
        // The quote in the title stays inside it, as text.
        expect(a?.getAttribute("onclick")).toBeNull();
        expect(a?.getAttribute("title")).toBe('x" onclick="alert(1)');
        expect(doc.querySelector("img")?.getAttribute("onerror")).toBeNull();
    });

    it("keeps data-ws-path on a raw anchor but strips its script vectors", () => {
        const html = renderMarkdown('<a class="ws-file" data-ws-path="/workspace/a.md" href="javascript:alert(1)" onclick="alert(1)">x</a>');
        expect(html).toContain('data-ws-path="/workspace/a.md"');
        expect(html).not.toContain("javascript:");
        expect(html).not.toContain("onclick");
    });

    it("sanitizes renderMarkdownInline output too", () => {
        const html = renderMarkdownInline('<img src="x" onerror="alert(1)">');
        expect(html).not.toContain("onerror");
    });
});

describe("renderTableCell", () => {
    it("renders a string as inline markdown, sanitized", () => {
        expect(renderTableCell("**up**")).toContain("<strong>up</strong>");
        expect(renderTableCell("<img src=x onerror=alert(1)>")).not.toContain("onerror");
    });

    it("escapes anything else, with objects and arrays as JSON", () => {
        const html = renderTableCell(["<img src=x onerror=alert(1)>"]);
        expect(html).not.toContain("<img");
        expect(html).toBe("[&#34;&#60;img src=x onerror=alert(1)&#62;&#34;]");
        expect(renderTableCell({ a: 1 })).toBe("{&#34;a&#34;:1}");
        expect(renderTableCell(42)).toBe("42");
        expect(renderTableCell(null)).toBe("");
    });
});
