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

/** Mermaid, pinned to an exact release: the loader runs what's at this
 *  URL on the studio's origin, so it never floats to a newer one. */
const MERMAID_CDN = "https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.esm.min.mjs";
/** @type {Promise<any> | null} */
let mermaidPromise = null;

/** Lazily load mermaid from the CDN and initialize it: dark, and
 *  `strict`, since a diagram's source can come from an imported
 *  session (no HTML labels, no click handlers, sanitized text). A
 *  failed load is forgotten, so the next render tries again. */
function loadMermaid() {
    if (!mermaidPromise) {
        mermaidPromise = import(/* @vite-ignore */ MERMAID_CDN).then(
            (mod) => {
                mod.default.initialize({
                    startOnLoad: false,
                    securityLevel: "strict",
                    theme: "dark",
                    fontFamily: "system-ui, -apple-system, sans-serif",
                });
                return mod.default;
            },
            (e) => {
                mermaidPromise = null;
                throw e;
            },
        );
    }
    return mermaidPromise;
}

/**
 * The short line a failed diagram shows under its source: a parse
 * error's first line (where) and last (what it met), the parser's
 * list of the tokens it expected dropped, cut to a readable length.
 *
 * @param {unknown} e
 */
export function mermaidErrorLine(e) {
    const message = e instanceof Error ? e.message : String(e ?? "");
    const lines = message.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    const last = (lines.at(-1) ?? "").replace(/^Expecting .*, got (.+)$/, "unexpected $1");
    const line = lines.length > 1 ? `${lines[0]} ${last}` : (lines[0] ?? "unknown error");
    return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/**
 * What a diagram that didn't render shows instead: its source, as
 * text, and a line saying why, both escaped.
 *
 * @param {string} source
 * @param {unknown} error
 */
export function mermaidFallback(source, error) {
    return (
        `<code class="mermaid-source">${escapeHtml(source)}</code>` +
        `<span class="mermaid-error">Diagram didn't render: ${escapeHtml(mermaidErrorLine(error))}</span>`
    );
}

/**
 * Find and render all <pre class="mermaid"> blocks inside a container
 * (or the container itself, when it's one).
 * Uses mermaid.render() with textContent to avoid HTML-entity escaping
 * issues (marked escapes `"` → `&quot;`, `>` → `&gt;` which breaks mermaid parsing).
 * A block that doesn't render (a parse error, or Mermaid not loading)
 * keeps its source and says why.
 * @param {Element} container
 */
export async function renderMermaidBlocks(container) {
    if (!container) return;
    const selector = "pre.mermaid:not([data-processed])";
    const blocks = container.matches(selector) ? [container] : [...container.querySelectorAll(selector)];
    if (blocks.length === 0) return;

    /** @type {any} */
    let mermaid;
    try {
        mermaid = await loadMermaid();
    } catch (e) {
        console.warn("Mermaid didn't load:", e);
        for (const block of blocks) {
            // another render of this container may have got here first
            if (!block.hasAttribute("data-processed")) fail(block, block.textContent ?? "", new Error("Mermaid couldn't load."));
        }
        return;
    }
    for (const block of blocks) {
        if (block.hasAttribute("data-processed")) continue;
        const code = block.textContent ?? "";
        const id = `mermaid-${Math.random().toString(36).slice(2)}`;
        try {
            const { svg } = await mermaid.render(id, code);
            block.innerHTML = svg;
            block.setAttribute("data-processed", "true");
        } catch (e) {
            // A failed render can leave its scratch element in <body>.
            document.getElementById(`d${id}`)?.remove();
            document.getElementById(id)?.remove();
            fail(block, code, e);
        }
    }
}

/** @param {Element} block @param {string} source @param {unknown} error */
function fail(block, source, error) {
    block.innerHTML = mermaidFallback(source, error);
    block.classList.add("mermaid-failed");
    block.setAttribute("data-processed", "true");
}
