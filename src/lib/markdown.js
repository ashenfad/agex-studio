/**
 * Markdown rendering for chat messages.
 *
 * Wraps `marked` with a preprocessor that inserts blank lines before block
 * elements (lists, headings, fenced code) when the source only has a single
 * newline. This matches the forgiving behavior users expect in chat UIs.
 * The inside of a fenced code block is left as written.
 *
 * Mermaid code blocks are rendered as placeholders, which
 * renderMermaidBlocks() (mermaid.js) draws once they're in the page.
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
 * relative to `base`, a folder in the workspace (`notes/plan.md`,
 * `./plan.md`, `../data.csv`). A query or fragment on it is dropped, and
 * %-escapes are decoded (`my%20plan.md`).
 *
 * @param {string} href
 * @param {string} [base] the folder a relative path starts from
 * @returns {{ path: string | null } | null}
 */
function resolveLink(href, base = WORKSPACE) {
    let path = String(href ?? "").trim();
    if (path === "" || path.startsWith("#") || path.startsWith("//")) return null;
    if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return null;
    if (path.startsWith("/")) {
        if (path !== WORKSPACE && !/^\/workspace[/?#]/.test(path)) return null;
        path = path.slice(WORKSPACE.length);
    } else {
        // from the base's folder, within the workspace
        path = `${base.slice(WORKSPACE.length)}/${path}`;
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

/**
 * The file a rendered link's `data-ws-path` opens, relative to
 * /workspace as the file viewer takes it; null for a value the renderer
 * wouldn't have written. Raw HTML in a reply can carry the attribute
 * too (`<a data-ws-path="/workspace/../../x">`), so only a value that is
 * already a normalized workspace path is trusted.
 *
 * @param {string | null} attribute
 * @returns {string | null}
 */
export function fileLinkTarget(attribute) {
    const path = workspacePath(attribute ?? "");
    if (path === null || path !== attribute) return null;
    return path.slice(WORKSPACE.length + 1);
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
/**
 * The folder workspace links resolve against in the markdown being
 * rendered now (`renderMarkdown`'s `linkBase`); null renders every link
 * as an ordinary one, for a place with no file viewer to open.
 * @type {string | null}
 */
let linkBase = null;

/** @param {import("marked").Tokens.Link} token */
renderer.link = function (token) {
    const { href, title, tokens } = token;
    const target = linkBase === null ? null : resolveLink(href, linkBase);
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

/** Ensure blank lines before block elements so marked recognizes them.
 *  @param {string} text */
function spaceBlocks(text) {
    return text
        .replace(/([^\n])\n([ \t]*[-*+] )/g, "$1\n\n$2") // unordered lists
        .replace(/([^\n])\n([ \t]*\d+[.)] )/g, "$1\n\n$2") // ordered lists
        .replace(/([^\n])\n(#{1,6} )/g, "$1\n\n$2") // headings
        .replace(/([^\n])\n(```)/g, "$1\n\n$2"); // fenced code blocks
}

/** A fenced code block's opening line: up to three spaces, then three
 *  or more backticks (with no backtick in the info string after them)
 *  or three or more tildes. */
const FENCE_OPEN = /^ {0,3}(?:(`{3,})[^`]*|(~{3,}).*)$/;

/**
 * `text` with blank lines before its block elements (`spaceBlocks`),
 * but only outside fenced code: a code block's lines (a comment's `#`,
 * a YAML list's `-`) are kept byte for byte. A fence closes on a line
 * of the same character, at least as long, with nothing after it but
 * whitespace; one never closed runs to the end of the text.
 *
 * @param {string} text
 */
function prepare(text) {
    const lines = text.split("\n");
    /** @type {string[]} */
    const out = [];
    // Markdown outside the fences, from a closing fence's line through
    // the next opening fence's line, so the blank line goes in before
    // an opening fence and after a closing one as it would without them.
    /** @type {string[]} */
    let prose = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i++];
        prose.push(line);
        const open = line.match(FENCE_OPEN);
        if (open === null) continue;
        out.push(spaceBlocks(prose.join("\n")));
        prose = [];
        const fence = open[1] ?? open[2];
        const close = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t\\r]*$`);
        while (i < lines.length && !close.test(lines[i])) out.push(lines[i++]);
        // the closing fence, which opens nothing
        if (i < lines.length) prose.push(lines[i++]);
    }
    if (prose.length > 0) out.push(spaceBlocks(prose.join("\n")));
    return out.join("\n");
}

/** Parse markdown to HTML with forgiving block handling.
 *
 * `breaks` defaults to true (chat-style: single source newlines
 * become visible <br> tags, matching what users intuit when they
 * hit Enter in a chat input). Pass `{ breaks: false }` for
 * documentation contexts where the markdown source is hand-
 * wrapped for editor readability and shouldn't render those
 * wraps as visual breaks. Per-call options are merged onto the
 * module-level defaults set via `marked.setOptions`.
 *
 * `linkBase`, a folder in the workspace, makes links to workspace files
 * (`/workspace/notes/plan.md`, or relative to that folder) render as
 * file links (`data-ws-path`) for the caller to open: a reply's base is
 * /workspace, a file's is its own folder. Without one, every link is an
 * ordinary link.
 *
 * @param {string} text
 * @param {{ breaks?: boolean, linkBase?: string | null }} [opts] */
export function renderMarkdown(text, { breaks = true, linkBase: base = null } = {}) {
    // parsing is synchronous: the base holds for this text alone
    linkBase = base;
    try {
        return sanitize(marked.parse(prepare(text), { breaks }));
    } finally {
        linkBase = null;
    }
}

/** Parse markdown to inline HTML — no block elements (paragraphs,
 *  lists, headings, fenced code). Suitable for places that must
 *  stay on a single line, like table cells. The shared custom
 *  renderer above still applies, so inline `code` renders the same as
 *  elsewhere; links stay ordinary ones, as with no `linkBase`.
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
