/**
 * Markdown rendering for chat messages.
 *
 * Wraps `marked` with a preprocessor that inserts blank lines before block
 * elements (lists, headings, fenced code) when the source only has a single
 * newline. This matches the forgiving behavior users expect in chat UIs.
 *
 * Mermaid code blocks are rendered as placeholders, then initialized
 * client-side via renderMermaidBlocks().
 */

import { marked } from "marked";

marked.setOptions({ breaks: true });

// Custom renderer: emit mermaid blocks as <pre class="mermaid"> instead of <pre><code>
const renderer = new marked.Renderer();
const origCode = renderer.code.bind(renderer);
renderer.code = function ({ text, lang }) {
    if (lang === "mermaid") {
        return `<pre class="mermaid">${text}</pre>`;
    }
    return origCode({ text, lang });
};
marked.setOptions({ renderer });

/** Ensure blank lines before block elements so marked recognizes them. */
function prepare(text) {
    return text
        .replace(/([^\n])\n([ \t]*[-*+] )/g, "$1\n\n$2") // unordered lists
        .replace(/([^\n])\n([ \t]*\d+[.)] )/g, "$1\n\n$2") // ordered lists
        .replace(/([^\n])\n(#{1,6} )/g, "$1\n\n$2") // headings
        .replace(/([^\n])\n(```)/g, "$1\n\n$2"); // fenced code blocks
}

/** Parse markdown to HTML with forgiving block handling. */
export function renderMarkdown(text) {
    return marked.parse(prepare(text));
}

const MERMAID_CDN = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
let mermaidPromise = null;

/** Lazily load mermaid from CDN and initialize with dark theme. */
function loadMermaid() {
    if (!mermaidPromise) {
        mermaidPromise = import(/* @vite-ignore */ MERMAID_CDN).then((mod) => {
            mod.default.initialize({
                startOnLoad: false,
                theme: "dark",
                fontFamily: "system-ui, -apple-system, sans-serif",
            });
            return mod.default;
        });
    }
    return mermaidPromise;
}

/**
 * Find and render all <pre class="mermaid"> blocks inside a container.
 * Uses mermaid.render() with textContent to avoid HTML-entity escaping
 * issues (marked escapes `"` → `&quot;`, `>` → `&gt;` which breaks mermaid parsing).
 * @param {HTMLElement} container
 */
export async function renderMermaidBlocks(container) {
    if (!container) return;
    const blocks = container.querySelectorAll("pre.mermaid:not([data-processed])");
    if (blocks.length === 0) return;

    const mermaid = await loadMermaid();
    for (const block of blocks) {
        const code = block.textContent;
        try {
            const id = `mermaid-${Math.random().toString(36).slice(2)}`;
            const { svg } = await mermaid.render(id, code);
            block.innerHTML = svg;
            block.setAttribute("data-processed", "true");
        } catch (e) {
            console.warn("Mermaid render error:", e);
            block.setAttribute("data-processed", "true");
        }
    }
}
