/**
 * A capture (`walk.js`) rebuilt as a document, to run a filter's
 * selectors and operators on away from the live page.
 */

/**
 * The capture's HTML as a document, its declarative shadow roots attached
 * (`DOMParser` would leave them as templates). The document has no
 * browsing context: no script in it runs and nothing it names is fetched,
 * as long as its nodes stay out of a live document.
 *
 * @param {string} html a capture's `html`
 * @returns {Document}
 */
export function rebuildCapture(html) {
    return Document.parseHTMLUnsafe(html);
}

// elements laid out as blocks by default, for an element layout didn't annotate
const BLOCK = new Set([
    "address", "article", "aside", "blockquote", "caption", "dd", "details", "dialog", "div", "dl",
    "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
    "header", "hgroup", "hr", "legend", "li", "main", "menu", "nav", "ol", "option", "p", "pre",
    "section", "summary", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]);

/**
 * The text a person saw in `el` when it was captured: its text nodes in
 * the order they're drawn (a shadow root's in its host's place, a slot's
 * assigned nodes in the slot's, or its own when none are), skipping every
 * subtree marked `data-agex-hidden`. Whitespace is collapsed, and each
 * element drawn as a block (`data-agex-block`; one with no box recorded,
 * when it is a block by default: a `div`, a `li`) and each `<br>` breaks
 * a line, so words in neighbouring blocks don't run together.
 *
 * What a filter's `hasText` is matched against on a capture, as
 * `innerText` is on the live page.
 *
 * @param {Element | Document | DocumentFragment} el
 * @returns {string}
 */
export function capturedVisibleText(el) {
    /** @type {string[]} */
    const parts = [];
    /** @param {Node} node */
    const walk = (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
            parts.push((node.textContent ?? "").replace(/\s+/g, " "));
            return;
        }
        if (node.nodeType === Node.DOCUMENT_NODE) {
            const root = /** @type {Document} */ (node).documentElement;
            if (root) walk(root);
            return;
        }
        if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
            for (const c of node.childNodes) walk(c);
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const e = /** @type {Element} */ (node);
        const tag = e.localName;
        if (tag === "br") {
            parts.push("\n");
            return;
        }
        if (e.hasAttribute("data-agex-hidden")) return;
        const block = e.hasAttribute("data-agex-block") || (!e.hasAttribute("data-agex-box") && BLOCK.has(tag));
        if (block) parts.push("\n");
        const children = e.shadowRoot
            ? e.shadowRoot.childNodes
            : tag === "slot" && /** @type {HTMLSlotElement} */ (e).assignedNodes().length > 0
              ? /** @type {HTMLSlotElement} */ (e).assignedNodes()
              : e.childNodes;
        for (const c of children) walk(c);
        if (block) parts.push("\n");
    };
    walk(el);
    return parts
        .join("")
        .replace(/ *\n[\n ]*/g, "\n")
        .replace(/ {2,}/g, " ")
        .trim();
}
