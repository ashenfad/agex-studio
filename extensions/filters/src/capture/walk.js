/**
 * A page as the person sees it, kept to test filters on away from it: its
 * DOM serialized after rendering, each element annotated with what layout
 * knew of it, so a check that needs a box or visibility works on the
 * rebuilt page (`rebuild.js`), which has no styles and no layout.
 *
 * `capturePage` runs in the page, in the extension's isolated world, so it
 * is self-contained: it is sent as its source text, and closes over
 * nothing in this module.
 *
 * The capture's HTML, and the annotations a reader may rely on:
 *
 * - Elements with their attributes, and text. Comments are left out, and
 *   so is the page's code and styling: scripts, `<noscript>`, `<style>`,
 *   stylesheet and preload `<link>`s, `<template>`s and event handler
 *   attributes (`onclick`). A `data:` URL longer than a kilobyte keeps its
 *   type and loses its payload (`data:image/png;base64,`).
 * - An `<iframe>` is kept as an element, its `src` with it; what it shows
 *   isn't captured.
 * - Every open shadow root, nested ones too, as a declarative one: a
 *   `<template shadowrootmode="open">` as its host's first child, then the
 *   host's light DOM, which its slots take once rebuilt. A closed root is
 *   written the same way (open, in the capture) where the walk can reach
 *   it: from an extension's content script, through
 *   `chrome.dom.openOrClosedShadowRoot`; from a page's own script it
 *   can't, and the root is absent, its host's light DOM kept.
 * - `data-agex-box="left top width height"` on each element that renders
 *   a box: CSS pixels, in page coordinates (the viewport's plus its
 *   scroll), rounded.
 * - `data-agex-hidden` (empty) on each element that renders nothing a
 *   person could see: not rendered (`display: none`, inside one, a light
 *   child no slot takes), fully transparent (`opacity: 0`), or rendering
 *   no visible box, no visible text and no visible descendant
 *   (`visibility: hidden`, zero size). A hidden element's subtree may
 *   carry no annotations. An element that shows only for a descendant
 *   (`visibility: visible` under `visibility: hidden`) isn't hidden, and
 *   its own text, which doesn't show, is left out. An element that renders
 *   no box of its own, its children drawn in its place (`display:
 *   contents`, a slot), carries neither, and its children carry their
 *   own.
 * - `data-agex-block` (empty) beside a box, when layout drew the element
 *   as a block (a `div`; a `span` that is a flex item, or positioned out
 *   of the flow): its text is a line of its own, as `innerText` reads it.
 * - `data-agex-cut="n"` on an element whose last `n` children were cut to
 *   keep the capture within `maxBytes`.
 * - Attributes named `data-agex-…` that the page had are left out: a
 *   page can't forge an annotation.
 *
 * Visible text isn't annotated: a reader derives it from the text nodes,
 * skipping hidden subtrees, a block's text a line of its own
 * (`capturedVisibleText`).
 */

/**
 * @typedef {{
 *   html: string,
 *   url: string,
 *   title: string,
 *   host: string,
 *   viewport: { width: number, height: number, scrollX: number, scrollY: number },
 *   bytes: number,
 *   cut?: number,
 * }} Capture
 *   `host`: the page's host name, without a port.
 *   `bytes`: the HTML's size in UTF-8.
 *   `cut`: the bytes left out to keep within `maxBytes`, when any were.
 */

/**
 * Capture the page in front, within `maxBytes` of HTML. Over that, first
 * each attribute value longer than a kilobyte keeps only its first (a
 * JSON blob, an SVG path); then the latest content goes: the tail of each
 * long run of like siblings (a feed's later posts), latest run first,
 * down to its first few; then, if still over, the end of the body, whole
 * subtrees at a time, keeping the elements that held them; then the end
 * of the head, and of the root. The HTML is always within `maxBytes`, as
 * long as that holds the root's own tags.
 *
 * @param {{ maxBytes?: number }} [options]
 * @returns {Capture | { error: string }} the capture, or why the walk failed
 */
export function capturePage({ maxBytes = 2_000_000 } = {}) {
    // an exception in the page reaches no one (the extension gets nothing back), so it
    // comes back as the capture's `error` instead
    try {
        const HTML_NS = "http://www.w3.org/1999/xhtml";
        /**
         * An element's closed shadow root, where the walk can reach one: from an
         * extension's content script (`chrome.dom`), and only on an HTML element,
         * which is all that API takes (an SVG icon would throw).
         *
         * @param {Element} el
         * @returns {ShadowRoot | null}
         */
        const closedRoot = (el) => {
            const dom = /** @type {any} */ (globalThis).chrome?.dom;
            if (typeof dom?.openOrClosedShadowRoot !== "function" || !(el instanceof HTMLElement)) return null;
            try {
                return dom.openOrClosedShadowRoot(el) ?? null;
            } catch {
                return null;
            }
        };
        const VOID = new Set([
            "area", "base", "basefont", "bgsound", "br", "col", "embed", "frame", "hr", "img",
            "input", "keygen", "link", "meta", "param", "source", "track", "wbr",
        ]);
        // the page's code and styling, and what is only parsed when scripting is off
        const DROP = new Set(["script", "noscript", "style", "template"]);
        const RESOURCE_LINK = /(^|\s)(stylesheet|preload|modulepreload|prefetch)(\s|$)/i;
        // kept as elements without their content: another document's (a frame's), or text the
        // parser doesn't decode (raw text), which escaping would change
        const EMPTY = new Set(["iframe", "frame", "xmp", "noembed", "noframes", "plaintext"]);
        // the parser drops a newline that starts these, so one that the text starts with is doubled
        const LEADING_NEWLINE = new Set(["pre", "textarea", "listing"]);
        const LONG_DATA_URL = 1024;
        // what a capture over its size keeps of an attribute's value
        const LONG_ATTRIBUTE = 1024;
        // a run of like siblings: this many or more of one tag under one parent
        const RUN = 8;
        // what a cut run keeps of its head
        const KEEP = 5;
        // what a `data-agex-cut` costs, at most
        const MARKER_BYTES = 24;

        const encoder = new TextEncoder();
        const ASCII = /^[\x00-\x7f]*$/;
        /** UTF-8 bytes @param {string} s */
        const size = (s) => (ASCII.test(s) ? s.length : encoder.encode(s).length);
        /** @type {Record<string, string>} */
        const ENTITY = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", " ": "&nbsp;" };
        /** @param {string} s */
        const escapeText = (s) => s.replace(/[&<> ]/g, (c) => ENTITY[c]);
        /** @param {string} s */
        const escapeAttr = (s) => s.replace(/[&<>" ]/g, (c) => ENTITY[c]);

        /**
         * An element as it will be written: its tags, and its children as
         * pieces and escaped text. `start` and `end` bound its subtree in
         * document order.
         * @typedef {{
         *   open: string, close: string, kids: (Piece | string)[], bytes: number,
         *   parent: Piece | null, start: number, end: number, gone: boolean, cut: number,
         * }} Piece
         */
        /** @typedef {{ parent: Piece, members: Piece[], start: number, end: number }} Run */

        /** whether a person sees something of `node`, a slot's assigned node @param {Node} node */
        const drawn = (node) => {
            if (node.nodeType === Node.TEXT_NODE) return /\S/.test(node.textContent ?? "");
            if (node.nodeType !== Node.ELEMENT_NODE) return false;
            const el = /** @type {Element} */ (node);
            return el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) || getComputedStyle(el).display === "contents";
        };

        /** @type {Run[]} */
        const runs = [];
        let order = 0;
        // the longest attribute value written whole
        let attributeCap = Infinity;

        /** @param {Element} el */
        const attributes = (el) => {
            let out = "";
            for (const a of el.attributes) {
                const lower = a.name.toLowerCase();
                if (lower.startsWith("data-agex-")) continue;
                if (lower.startsWith("on") && lower in el) continue;
                let value = a.value;
                if (value.length > LONG_DATA_URL && /^\s*data:/i.test(value)) value = value.slice(0, value.indexOf(",") + 1);
                else if (value.length > attributeCap) value = value.slice(0, attributeCap);
                out += ` ${a.name}="${escapeAttr(value)}"`;
            }
            return out;
        };

        /**
         * Write `node` under `parent`, with annotations unless `plain` (inside
         * a hidden subtree). Returns the piece or text written, if any, and
         * whether a person sees anything of it.
         *
         * @param {Node} node
         * @param {Piece} parent
         * @param {boolean} plain
         * @param {boolean} textShows text directly under `parent` is visible
         * @returns {[Piece | string | null, boolean]}
         */
        const write = (node, parent, plain, textShows) => {
            if (node.nodeType === Node.TEXT_NODE) {
                const t = node.textContent ?? "";
                return [escapeText(t), !plain && textShows && /\S/.test(t)];
            }
            if (node.nodeType !== Node.ELEMENT_NODE) return [null, false];
            const el = /** @type {Element} */ (node);
            const tag = el.localName;
            const lower = tag.toLowerCase();
            if (DROP.has(lower)) return [null, false];
            if (lower === "link" && RESOURCE_LINK.test(el.getAttribute("rel") ?? "")) return [null, false];

            /** @type {Piece} */
            const piece = { open: "", close: "", kids: [], bytes: 0, parent, start: order++, end: 0, gone: false, cut: 0 };
            let hidden = false;
            let box = "";
            let block = false;
            let shows = false;
            let kidTextShows = false;
            // a zero-size box whose overflow is clipped: nothing in it shows
            let clips = false;
            // draws no box of its own, and its children do: never marked hidden itself
            let contents = false;
            if (!plain) {
                const style = getComputedStyle(el);
                const rendered = el.checkVisibility();
                if (rendered && Number(style.opacity) === 0) {
                    // fully transparent: nothing in it shows
                    hidden = true;
                } else if (rendered) {
                    const r = el.getBoundingClientRect();
                    const visible = style.visibility === "visible";
                    shows = visible && r.width > 0 && r.height > 0;
                    kidTextShows = visible;
                    clips = (r.width === 0 && style.overflowX !== "visible") || (r.height === 0 && style.overflowY !== "visible");
                    box = `${Math.round(r.left + scrollX)} ${Math.round(r.top + scrollY)} ${Math.round(r.width)} ${Math.round(r.height)}`;
                    block = !style.display.startsWith("inline") || style.position === "absolute" || style.position === "fixed";
                } else {
                    if (style.display === "contents") {
                        contents = true;
                        kidTextShows = style.visibility === "visible";
                        // a slot that takes nodes shows them, written with the host's light DOM, in
                        // place of its own children
                        if (el instanceof HTMLSlotElement) shows = el.assignedNodes({ flatten: true }).some(drawn);
                    } else {
                        // not rendered: display none, inside one, or a light child no slot takes
                        hidden = true;
                    }
                }
            }
            const below = plain || hidden;

            const html = el.namespaceURI === HTML_NS;
            /** @type {Piece | null} */
            let template = null;
            if (!(html && (VOID.has(lower) || EMPTY.has(lower)))) {
                const root = el.shadowRoot ?? closedRoot(el);
                if (root) {
                    const flags = [
                        root.delegatesFocus && " shadowrootdelegatesfocus",
                        root.clonable && " shadowrootclonable",
                        root.serializable && " shadowrootserializable",
                    ].filter(Boolean).join("");
                    template = {
                        open: `<template shadowrootmode="open"${flags}>`, close: "</template>", kids: [], bytes: 0,
                        parent: piece, start: order++, end: 0, gone: false, cut: 0,
                    };
                    // the shadow tree is drawn in its host's box, as the host's own children are
                    for (const c of root.childNodes) {
                        const [k, s] = write(c, template, below, kidTextShows);
                        if (k !== null) template.kids.push(k);
                        shows ||= s;
                    }
                    template.end = order;
                    piece.kids.push(template);
                }
                for (const c of el.childNodes) {
                    const [k, s] = write(c, piece, below, kidTextShows);
                    if (k !== null) piece.kids.push(k);
                    shows ||= s;
                }
            }
            if (clips) shows = false;
            if (!below && !shows && !contents) hidden = true;
            piece.end = order;
            if (!below && !hidden && !kidTextShows) {
                // shown only for a descendant that is (`visibility: visible` under `hidden`): its own
                // text doesn't show, so it isn't written, where a reader would take it for shown
                /** @param {Piece} p */
                const shownOnly = (p) => {
                    p.kids = p.kids.filter((k) => typeof k !== "string" || !/\S/.test(k));
                };
                shownOnly(piece);
                if (template) shownOnly(template);
            }
            if (template) finish(template);

            const marks = plain ? "" : hidden ? " data-agex-hidden" : box ? ` data-agex-box="${box}"${block ? " data-agex-block" : ""}` : "";
            const first = piece.kids[0];
            const newline = LEADING_NEWLINE.has(lower) && typeof first === "string" && first.startsWith("\n") ? "\n" : "";
            piece.open = `<${tag}${attributes(el)}${marks}>${newline}`;
            piece.close = html && VOID.has(lower) ? "" : `</${tag}>`;
            finish(piece);
            return [piece, !hidden && shows];
        };

        /** Size `piece`, and note its runs of like siblings. @param {Piece} piece */
        const finish = (piece) => {
            let bytes = size(piece.open) + size(piece.close);
            /** @type {Map<string, Piece[]>} */
            const byTag = new Map();
            for (const k of piece.kids) {
                if (typeof k === "string") {
                    bytes += size(k);
                    continue;
                }
                bytes += k.bytes;
                const tag = /^<([^\s>]+)/.exec(k.open)?.[1] ?? "";
                const like = byTag.get(tag);
                if (like) like.push(k);
                else byTag.set(tag, [k]);
            }
            piece.bytes = bytes;
            if (piece.open.startsWith("<head")) return;
            for (const members of byTag.values()) {
                if (members.length >= RUN) runs.push({ parent: piece, members, start: members[0].start, end: members[members.length - 1].end });
            }
        };

        /** The page written whole, its runs noted. @returns {Piece} */
        const writePage = () => {
            runs.length = 0;
            order = 0;
            /** @type {Piece} */
            const top = { open: "", close: "", kids: [], bytes: 0, parent: null, start: order++, end: 0, gone: false, cut: 0 };
            const doc = document.documentElement;
            const [root] = doc ? write(doc, top, false, true) : [null];
            return root !== null && typeof root !== "string" ? root : top;
        };
        // a page in quirks mode is rebuilt in quirks mode, where class and id selectors ignore case
        const doctype = document.compatMode === "CSS1Compat" ? "<!DOCTYPE html>" : "";
        let html = writePage();
        const full = size(doctype) + html.bytes;
        if (full > maxBytes) {
            // over, long attribute values go first (a JSON blob, an SVG path): written again, cut short
            attributeCap = LONG_ATTRIBUTE;
            html = writePage();
        }

        /** @param {Piece} p */
        const alive = (p) => {
            for (let a = /** @type {Piece | null} */ (p); a; a = a.parent) if (a.gone) return false;
            return true;
        };
        /** @param {Piece} p */
        const resize = (p) => {
            let bytes = size(p.open) + size(p.close) + (p.cut > 0 ? MARKER_BYTES : 0);
            for (const k of p.kids) bytes += typeof k === "string" ? size(k) : k.gone ? 0 : resize(k);
            p.bytes = bytes;
            return bytes;
        };
        /** Leave out at least `need` bytes from the end of `p`'s content, a whole child where one does.
         *  @param {Piece} p @param {number} need @returns {number} the bytes left out */
        const trim = (p, need) => {
            let dropped = 0;
            while (p.kids.length > 0 && dropped < need) {
                const k = /** @type {Piece | string} */ (p.kids[p.kids.length - 1]);
                if (typeof k !== "string" && k.gone) {
                    p.kids.pop();
                    continue;
                }
                const bytes = typeof k === "string" ? size(k) : k.bytes;
                if (typeof k === "string" || bytes <= need - dropped) {
                    p.kids.pop();
                    if (typeof k !== "string") {
                        k.gone = true;
                        if (p.cut++ === 0) dropped -= MARKER_BYTES;
                    }
                    dropped += bytes;
                    continue;
                }
                const inside = trim(k, need - dropped);
                dropped += inside;
                // a child left empty goes too
                if (k.kids.length === 0) {
                    p.kids.pop();
                    k.gone = true;
                    if (p.cut++ === 0) dropped -= MARKER_BYTES;
                    dropped += bytes - inside;
                }
                break;
            }
            return dropped;
        };

        let over = size(doctype) + html.bytes - maxBytes;
        if (over > 0) {
            // the latest run first; one that holds another comes before it
            runs.sort((a, b) => b.end - a.end || a.start - b.start);
            for (const run of runs) {
                if (over <= 0) break;
                if (!alive(run.parent)) continue;
                for (let i = run.members.length - 1; i >= KEEP && over > 0; i--) {
                    const m = run.members[i];
                    if (m.gone) continue;
                    m.gone = true;
                    over -= m.bytes;
                    if (run.parent.cut++ === 0) over += MARKER_BYTES;
                }
            }
        }
        if (over > 0) {
            // then the end of the page: the body's, then the head's, then whatever else the root holds
            /** @param {string} tag */
            const part = (tag) => html.kids.find((k) => typeof k !== "string" && !k.gone && new RegExp(`^<${tag}[\\s>]`).test(k.open));
            for (const p of [part("body"), part("head"), html]) {
                if (typeof p !== "object") continue;
                over = size(doctype) + resize(html) - maxBytes;
                if (over <= 0) break;
                trim(p, over);
            }
        }

        /** @type {string[]} */
        const out = [doctype];
        /** @param {Piece} p */
        const emit = (p) => {
            out.push(p.cut > 0 ? p.open.replace(/>(\n?)$/, ` data-agex-cut="${p.cut}">$1`) : p.open);
            for (const k of p.kids) {
                if (typeof k === "string") out.push(k);
                else if (!k.gone) emit(k);
            }
            out.push(p.close);
        };
        emit(html);
        const text = out.join("");
        const bytes = size(text);
        return {
            html: text,
            url: location.href,
            title: document.title,
            host: location.hostname,
            viewport: { width: innerWidth, height: innerHeight, scrollX: Math.round(scrollX), scrollY: Math.round(scrollY) },
            bytes,
            ...(full > bytes && { cut: full - bytes }),
        };
    } catch (e) {
        return /** @type {any} */ ({ error: String(/** @type {Error} */ (e)?.stack ?? e) });
    }
}
