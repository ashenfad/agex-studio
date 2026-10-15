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
import DOMPurify from "dompurify";

marked.setOptions({ breaks: true });

/**
 * Sanitize rendered HTML before it reaches `{@html}`.
 *
 * Chat messages, VFS files, and chapter summaries all flow through
 * here — and all of them can arrive from an *imported* session
 * bundle (gist links), so the markdown source is untrusted. marked
 * passes raw HTML through by default; DOMPurify strips script
 * vectors (event handlers, javascript: URLs, <script>) while
 * keeping the tags our renderers emit. `data-ws-path` survives
 * via DOMPurify's default data-* allowance; explicit ADD_ATTR
 * guards against that default ever being turned off.
 */
function sanitize(html) {
    return DOMPurify.sanitize(html, { ADD_ATTR: ["data-ws-path"] });
}

/** The workspace's root, which file links resolve against. */
const WORKSPACE = "/workspace";

/**
 * What a link's href points at: null for a URL (a scheme like
 * `https:` or `mailto:`, a protocol-relative `//host/…`, a fragment
 * `#…`, a root path outside /workspace), which renders as an ordinary
 * link; otherwise a path in the workspace, `{ path }` with the file's
 * normalized absolute path, or `{ path: null }` when it names no file
 * there (a `..` that climbs above /workspace, /workspace itself).
 *
 * A path is absolute under /workspace (`/workspace/notes/plan.md`) or
 * relative to it (`notes/plan.md`, `./notes/plan.md`). A query or
 * fragment on it is dropped, and %-escapes are decoded (`my%20plan.md`).
 *
 * @param {string} href
 * @returns {{ path: string | null } | null}
 */
function resolveLink(href) {
    let path = String(href ?? "").trim();
    if (path === "" || path.startsWith("#") || path.startsWith("//")) return null;
    if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return null;
    if (path.startsWith("/")) {
        if (path !== WORKSPACE && !/^\/workspace[/?#]/.test(path)) return null;
        path = path.slice(WORKSPACE.length);
    }
    path = path.replace(/[?#].*$/, "");
    try {
        path = decodeURIComponent(path);
    } catch {
        return { path: null };
    }
    /** @type {string[]} */
    const parts = [];
    for (const part of path.split("/")) {
        if (part === "" || part === ".") continue;
        if (part === "..") {
            if (parts.length === 0) return { path: null };
            parts.pop();
        } else parts.push(part);
    }
    return { path: parts.length === 0 ? null : `${WORKSPACE}/${parts.join("/")}` };
}

/**
 * The workspace file a link's href names, as a normalized absolute
 * path (`/workspace/notes/plan.md`), or null when it names none.
 *
 * @param {string} href
 */
export function workspacePath(href) {
    return resolveLink(href)?.path ?? null;
}

// Custom renderer:
// - mermaid code blocks → <pre class="mermaid"> for client-side rendering
// - a link to a workspace file → <a class="ws-file" data-ws-path="…">,
//   which a host with the session at hand (ReplyText) opens in the
//   file viewer on click; an href that tries to leave /workspace
//   renders as its text alone.
const renderer = new marked.Renderer();
const origCode = renderer.code.bind(renderer);
const origLink = renderer.link.bind(renderer);
const origBlockquote = renderer.blockquote.bind(renderer);

// GitHub-flavored callouts: `> [!NOTE]` (or TIP / WARNING / etc.) at
// the start of a blockquote rewrites to a tinted callout div with a
// small typed label. Matches GitHub's own rendering so prose authored
// with that syntax in mind ports cleanly. Body content inside the
// callout is normal markdown — lists, links, code spans all work.
const CALLOUT_LABELS = {
    note: "Note",
    tip: "Tip",
    warning: "Warning",
    caution: "Caution",
    important: "Important",
};

/** @param {{ text: string, lang?: string }} token */
renderer.code = function ({ text, lang }) {
    if (lang === "mermaid") {
        // Entity-escape the diagram source: interpolating it raw is
        // an HTML injection vector. renderMermaidBlocks() reads the
        // block back via textContent, which decodes the entities, so
        // mermaid still sees the original source.
        return `<pre class="mermaid">${escapeHtml(text)}</pre>`;
    }
    return origCode({ text, lang });
};
renderer.blockquote = function (token) {
    const first = token.tokens?.[0];
    const firstText = first?.tokens?.[0];
    if (firstText?.type === "text" && typeof firstText.text === "string") {
        const match = firstText.text.match(/^\[!(\w+)\]\s*\n?/);
        if (match) {
            const type = match[1].toLowerCase();
            if (CALLOUT_LABELS[type]) {
                // Strip the marker from the first text token so the
                // body renders without it; then render via the original
                // blockquote handler and unwrap the outer blockquote
                // tags. The token mutation is local to this render
                // pass (marked builds fresh tokens each parse).
                firstText.text = firstText.text.replace(
                    /^\[!\w+\]\s*\n?/,
                    "",
                );
                firstText.raw = firstText.text;
                const rendered = origBlockquote(token);
                const body = rendered
                    .replace(/^\s*<blockquote>\s*/, "")
                    .replace(/\s*<\/blockquote>\s*$/, "");
                return (
                    `<div class="callout callout-${type}">` +
                    `<div class="callout-label">${CALLOUT_LABELS[type]}</div>` +
                    body +
                    `</div>`
                );
            }
        }
    }
    return origBlockquote(token);
};
/** @param {import("marked").Tokens.Link} token */
renderer.link = function (token) {
    const { href, title, tokens } = token;
    const target = resolveLink(href);
    if (target !== null) {
        const { path } = target;
        const inner = this.parser.parseInline(tokens);
        if (path === null) return inner;
        // Escaped as an attribute, so a path holding quotes or angle
        // brackets can't break out; getAttribute hands back the path.
        const titleAttr = ` title="${escapeAttr(title || path)}"`;
        return `<a class="ws-file" data-ws-path="${escapeAttr(path)}" href="#"${titleAttr}>${inner}</a>`;
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
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

/** Full HTML text escape for element content. */
function escapeHtml(s) {
    return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/** Ensure blank lines before block elements so marked recognizes them. */
function prepare(text) {
    return text
        .replace(/([^\n])\n([ \t]*[-*+] )/g, "$1\n\n$2") // unordered lists
        .replace(/([^\n])\n([ \t]*\d+[.)] )/g, "$1\n\n$2") // ordered lists
        .replace(/([^\n])\n(#{1,6} )/g, "$1\n\n$2") // headings
        .replace(/([^\n])\n(```)/g, "$1\n\n$2"); // fenced code blocks
}

/** Parse markdown to HTML with forgiving block handling.
 *
 * `breaks` defaults to true (chat-style: single source newlines
 * become visible <br> tags, matching what users intuit when they
 * hit Enter in a chat input). Pass `{ breaks: false }` for
 * documentation contexts where the markdown source is hand-
 * wrapped for editor readability and shouldn't render those
 * wraps as visual breaks. Per-call options are merged onto the
 * module-level defaults set via `marked.setOptions`. */
export function renderMarkdown(text, { breaks = true } = {}) {
    return sanitize(marked.parse(prepare(text), { breaks }));
}

/** Parse markdown to inline HTML — no block elements (paragraphs,
 *  lists, headings, fenced code). Suitable for places that must
 *  stay on a single line, like table cells. The shared custom
 *  renderer above still applies, so inline `code` and workspace links
 *  render the same as elsewhere.
 *
 *  Newlines in the source are flattened to spaces before parsing
 *  because `breaks: true` (which we want in chat) would otherwise
 *  insert `<br>` and grow a cell vertically — a problem for the
 *  table's fixed ROW_HEIGHT virtualization. */
export function renderMarkdownInline(text) {
    const flat = String(text).replace(/\s*\n\s*/g, " ");
    return sanitize(marked.parseInline(flat));
}

/**
 * A table cell as HTML. A string gets inline markdown, so `**bold**`,
 * `` `code` ``, `*italic*` and `[links](url)` render (sanitized);
 * anything else is text, escaped, with an object or array shown as
 * JSON; null and undefined are empty. Block-level markdown isn't
 * possible — parseInline won't produce paragraphs, lists or headings —
 * which keeps rows one height for the table's virtualization.
 *
 * @param {unknown} cell
 */
export function renderTableCell(cell) {
    if (cell == null) return "";
    if (typeof cell === "string") return renderMarkdownInline(cell);
    const text = typeof cell === "object" ? JSON.stringify(cell) : String(cell);
    return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
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
