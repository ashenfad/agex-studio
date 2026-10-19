/**
 * Mermaid diagrams: the `<pre class="mermaid">` blocks the Markdown
 * renderer leaves for a ```mermaid fence, drawn as SVG once they're in
 * the page. Mermaid itself loads from the CDN on the first diagram.
 */

import { loadModule, MERMAID_URL } from "./cdn.js";

/** Load Mermaid and initialize it: dark, and `strict`, since a
 *  diagram's source can come from an imported session (no HTML labels,
 *  no click handlers, sanitized text). A failed load is forgotten, so
 *  the next render tries again. */
function loadMermaid() {
    return loadModule(MERMAID_URL, (mod) => {
        mod.default.initialize({
            startOnLoad: false,
            securityLevel: "strict",
            theme: "dark",
            fontFamily: "system-ui, -apple-system, sans-serif",
        });
        return mod.default;
    });
}

/** The SVG each diagram source drew as, the latest last: a block of
 *  the same source drawn again (the live turn's reply giving way to the
 *  stored one, a session reopened) takes it, and Mermaid isn't asked
 *  twice. @type {Map<string, string>} */
const drawn = new Map();
const DRAWN_MAX = 50;

/** @param {string} source @param {string} svg */
function remember(source, svg) {
    drawn.delete(source);
    drawn.set(source, svg);
    if (drawn.size > DRAWN_MAX) drawn.delete(drawn.keys().next().value ?? "");
}

const SELECTOR = "pre.mermaid:not([data-processed])";

/** The undrawn blocks in `container`, or the container itself when
 *  it's one. @param {Element} container */
function undrawn(container) {
    return container.matches(SELECTOR) ? [container] : [...container.querySelectorAll(SELECTOR)];
}

/**
 * Draw at once, with no Mermaid, each block in `container` whose source
 * was drawn before: called as the blocks come into the page, so a
 * diagram shown again is in place, at its size, from its first frame.
 *
 * @param {Element} container
 */
export function redrawKnown(container) {
    for (const block of undrawn(container)) {
        const svg = drawn.get(block.textContent ?? "");
        if (svg === undefined) continue;
        block.innerHTML = svg;
        block.setAttribute("data-processed", "true");
    }
}

/** HTML text escape for element content. @param {string} s */
function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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
    redrawKnown(container);
    const blocks = undrawn(container);
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
        const known = drawn.get(code);
        if (known !== undefined) {
            // drawn while Mermaid was loading, or by another block's render
            block.innerHTML = known;
            block.setAttribute("data-processed", "true");
            continue;
        }
        try {
            const { svg } = await mermaid.render(id, code);
            remember(code, svg);
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
