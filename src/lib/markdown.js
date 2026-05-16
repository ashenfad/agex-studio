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

// Custom renderer:
// - mermaid code blocks → <pre class="mermaid"> for client-side rendering
// - vfs: scheme links   → <a class="vfs-download"> for inline file
//                         downloads from the agent's VFS.  See the click
//                         handler in vfs-download.js.
const renderer = new marked.Renderer();
const origCode = renderer.code.bind(renderer);
const origLink = renderer.link.bind(renderer);
renderer.code = function ({ text, lang }) {
    if (lang === "mermaid") {
        return `<pre class="mermaid">${text}</pre>`;
    }
    return origCode({ text, lang });
};
renderer.link = function (token) {
    const { href, title, text } = token;
    if (href && href.startsWith("vfs:")) {
        const path = href.slice(4);
        // Round-trip through encodeURIComponent so attribute escaping
        // can't be broken by paths containing quotes or angle brackets.
        // Slashes are preserved for human readability (paths look like
        // paths in DOM inspectors).
        const safePath = encodeURIComponent(path).replace(/%2F/g, "/");
        const titleAttr = title ? ` title="${escapeAttr(title)}"` : "";
        return `<a class="vfs-download" data-vfs-path="${safePath}" href="#"${titleAttr}>${text}</a>`;
    }
    // Pass the full token through — marked's default renderer reads
    // ``tokens`` to re-parse inline content, not just ``text``.
    return origLink(token);
};
marked.setOptions({ renderer });

/** Minimal HTML attribute escape. */
function escapeAttr(s) {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;");
}

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

/** Parse markdown to inline HTML — no block elements (paragraphs,
 *  lists, headings, fenced code). Suitable for places that must
 *  stay on a single line, like table cells. The shared custom
 *  renderer above still applies, so inline `code` and `vfs:` links
 *  render the same as elsewhere.
 *
 *  Newlines in the source are flattened to spaces before parsing
 *  because `breaks: true` (which we want in chat) would otherwise
 *  insert `<br>` and grow a cell vertically — a problem for the
 *  table's fixed ROW_HEIGHT virtualization. */
export function renderMarkdownInline(text) {
    const flat = String(text).replace(/\s*\n\s*/g, " ");
    return marked.parseInline(flat);
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
