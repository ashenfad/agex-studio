import { describe, it, expect } from "vitest";
import { highlightCode, highlightPython } from "./highlight.js";

describe("highlightCode", () => {
    it("highlights Python files", () => {
        const html = highlightCode("def foo():\n    pass", "app.py");
        expect(html).toContain("class=");
        expect(html).toContain("foo");
    });

    it("highlights JavaScript files", () => {
        const html = highlightCode("const x = 1;", "index.js");
        expect(html).toContain("class=");
    });

    it("highlights .mjs as JavaScript", () => {
        const html = highlightCode("export default 1;", "mod.mjs");
        expect(html).toContain("class=");
    });

    it("highlights TypeScript files", () => {
        const html = highlightCode("const x: number = 1;", "app.ts");
        expect(html).toContain("class=");
    });

    it("highlights JSON files", () => {
        const html = highlightCode('{"key": "value"}', "data.json");
        expect(html).toContain("class=");
    });

    it("highlights HTML as XML", () => {
        const html = highlightCode("<div>hi</div>", "index.html");
        expect(html).toContain("class=");
    });

    it("highlights CSS files", () => {
        const html = highlightCode("body { color: red; }", "style.css");
        expect(html).toContain("class=");
    });

    it("highlights YAML files", () => {
        const html = highlightCode("key: value", "config.yml");
        expect(html).toContain("class=");
    });

    it("highlights Markdown files", () => {
        const html = highlightCode("# Heading", "readme.md");
        expect(html).toContain("class=");
    });

    it("highlights shell scripts", () => {
        const html = highlightCode("echo hello", "run.sh");
        expect(html).toContain("class=");
    });

    it("highlights SQL files", () => {
        const html = highlightCode("SELECT * FROM t;", "query.sql");
        expect(html).toContain("class=");
    });

    it("escapes HTML for unknown extensions", () => {
        const html = highlightCode("<b>test</b> & 'x'", "file.xyz");
        expect(html).toContain("&lt;b&gt;");
        expect(html).toContain("&amp;");
        expect(html).not.toContain("<b>");
    });

    it("escapes HTML when path has no extension", () => {
        const html = highlightCode("<div>", "Makefile");
        expect(html).toContain("&lt;div&gt;");
    });

    it("handles missing path", () => {
        const html = highlightCode("<tag>", undefined);
        expect(html).toContain("&lt;tag&gt;");
    });
});

describe("highlightPython", () => {
    it("highlights Python code", () => {
        const html = highlightPython("import os\nos.getcwd()");
        expect(html).toContain("class=");
        expect(html).toContain("import");
    });
});
