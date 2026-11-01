/**
 * What a filter's hide rules match: one engine for the live page (the
 * content script) and for a rebuilt capture (the offscreen document),
 * which differ only in their view, how an element's text, box and
 * visibility are read.
 *
 * A selector runs in the document and in every open shadow root under
 * it, nested ones too (a selector doesn't pierce a shadow root); its
 * matches are kept by `hasText` and `matchesAttr`, then mapped through
 * `upward`. Nothing a rule matches is ever the page's root: the
 * document's root element, its body, or its `main` (an element or a
 * role), whatever a rule says.
 *
 * The module uses the DOM alone, no extension API, so it runs in a page
 * as it does in the extension's own documents.
 */

/** @typedef {import("./format.js").HideRule} HideRule */
/** @typedef {import("./format.js").Filter} Filter */

/** @typedef {{ left: number, top: number, width: number, height: number }} Box
 *  in CSS pixels, page coordinates */

/**
 * @typedef {{
 *   text(el: Element): string,
 *   box(el: Element): Box | null,
 *   visible(el: Element): boolean,
 * }} View
 *   How an element reads where the engine runs. `text`: what a person
 *   sees of it, whitespace collapsed. `box`: where it is drawn, or null
 *   when it draws nothing. `visible`: whether it shows.
 */

/** @typedef {Document | ShadowRoot | Element} Root */

/**
 * @typedef {{
 *   selector: string,
 *   text: RegExp | null,
 *   attr: { name: string, pattern: RegExp } | null,
 *   upward: number | string | null,
 * }} Compiled
 */

/** elements whose text no one sees */
const UNSEEN = new Set(["script", "style", "noscript", "template", "head", "title", "meta", "link"]);

/** elements a line of text ends at, by default: their text is apart from what's around it */
const BLOCKS = new Set([
    "address", "article", "aside", "blockquote", "br", "dd", "details", "dialog", "div", "dl", "dt",
    "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header",
    "hgroup", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "summary", "table", "tbody",
    "td", "tfoot", "th", "thead", "tr", "ul", "option", "caption",
]);

const squash = (/** @type {string} */ s) => s.replace(/\s+/g, " ").trim();

/** @type {WeakMap<HideRule, Compiled>} */
const compiled = new WeakMap();

/**
 * A checked hide rule, its patterns compiled once.
 *
 * @param {HideRule} rule
 * @returns {Compiled}
 */
function compile(rule) {
    let c = compiled.get(rule);
    if (!c) {
        c = {
            selector: rule.selector,
            text: rule.hasText === undefined ? null : new RegExp(rule.hasText),
            attr: rule.matchesAttr ? { name: rule.matchesAttr.name, pattern: new RegExp(rule.matchesAttr.pattern) } : null,
            upward: rule.upward ?? null,
        };
        compiled.set(rule, c);
    }
    return c;
}

/**
 * Every open shadow root under `root`, nested ones too, in document
 * order: a host's root before the hosts inside it.
 *
 * @param {Root} root
 * @returns {ShadowRoot[]}
 */
export function shadowRoots(root) {
    /** @type {ShadowRoot[]} */
    const out = [];
    /** @param {Root} r */
    const visit = (r) => {
        for (const el of r.querySelectorAll("*")) {
            if (el.shadowRoot) {
                out.push(el.shadowRoot);
                visit(el.shadowRoot);
            }
        }
    };
    if (root.nodeType === Node.ELEMENT_NODE && /** @type {Element} */ (root).shadowRoot) {
        const own = /** @type {ShadowRoot} */ (/** @type {Element} */ (root).shadowRoot);
        out.push(own);
        visit(own);
    }
    visit(root);
    return out;
}

/**
 * The element `node` is drawn inside of: its parent, or for the top of a
 * shadow root, the root's host.
 *
 * @param {Node} node
 * @returns {Element | null}
 */
export function composedParent(node) {
    const p = node.parentNode;
    if (!p) return null;
    if (p.nodeType === Node.DOCUMENT_FRAGMENT_NODE) return /** @type {ShadowRoot} */ (p).host ?? null;
    return p.nodeType === Node.ELEMENT_NODE ? /** @type {Element} */ (p) : null;
}

/**
 * Whether `el` is the page's root, which no rule hides: its document's
 * root element, its body, or its `main`.
 *
 * @param {Element} el
 */
export function isPageRoot(el) {
    const doc = el.ownerDocument;
    return el === doc.documentElement || el === doc.body || el.localName === "main" || el.getAttribute("role") === "main";
}

/**
 * The ancestor `upward` names from `el`: that many levels up, or the
 * nearest one that matches it, out of shadow roots to their hosts; null
 * when there is none.
 *
 * @param {Element} el
 * @param {number | string} upward
 * @returns {Element | null}
 */
function up(el, upward) {
    let at = composedParent(el);
    if (typeof upward === "number") {
        for (let n = 1; at && n < upward; n++) at = composedParent(at);
        return at;
    }
    while (at && !at.matches(upward)) at = composedParent(at);
    return at;
}

/**
 * `root` and every open shadow root under it: where a filter's selectors
 * run. Found once for a whole filter, not once a rule: finding them
 * walks the page.
 *
 * @param {Root} root
 * @returns {Root[]}
 */
function scopes(root) {
    return [root, ...shadowRoots(root)];
}

/**
 * What `rule` hides in `roots` (`scopes`), how many of its matches it
 * left alone because they are the page's root, and why it matched
 * nothing when a selector this DOM can't parse stopped it (a rule fails
 * alone).
 *
 * @param {Root[]} roots
 * @param {HideRule} rule
 * @param {View} view
 */
function run(roots, rule, view) {
    const c = compile(rule);
    /** @type {Set<Element>} */
    const hits = new Set();
    let atRoot = 0;
    for (const r of roots) {
        /** @type {Iterable<Element>} */
        let found;
        try {
            found = r.querySelectorAll(c.selector);
            if (typeof c.upward === "string") r.querySelector(c.upward);
        } catch (e) {
            return { hits: [], atRoot: 0, error: e instanceof Error ? e.message : String(e) };
        }
        for (const el of found) {
            if (c.attr) {
                const value = el.getAttribute(c.attr.name);
                if (value === null || !c.attr.pattern.test(value)) continue;
            }
            if (c.text && !c.text.test(view.text(el))) continue;
            const target = c.upward === null ? el : up(el, c.upward);
            if (!target) continue;
            if (isPageRoot(target)) atRoot++;
            else hits.add(target);
        }
    }
    return { hits: [...hits], atRoot, error: /** @type {string | undefined} */ (undefined) };
}

/**
 * The elements `rule` hides under `root`, each once, in the order found.
 *
 * @param {Root} root
 * @param {HideRule} rule a rule `checkFilter` passed
 * @param {View} view
 * @returns {Element[]}
 */
export function matches(root, rule, view) {
    return run(scopes(root), rule, view).hits;
}

/**
 * The elements a filter hides under `root`, each once.
 *
 * @param {Root} root
 * @param {Filter} filter a filter `checkFilter` passed
 * @param {View} view
 * @returns {Set<Element>}
 */
export function matchAll(root, filter, view) {
    /** @type {Set<Element>} */
    const all = new Set();
    const roots = scopes(root);
    for (const rule of filter.hide) for (const el of run(roots, rule, view).hits) all.add(el);
    return all;
}

/**
 * @typedef {{ tag: string, path: string, text: string }} Sample
 *   `path`: where it is, outermost first, at most four steps
 *   (`div.feed > article#t3_x > span.badge`); `>>` where a step is into
 *   a host's shadow root.
 *   `text`: the start of what a person sees of it.
 */

/**
 * @typedef {{
 *   rule: number,
 *   selector: string,
 *   why?: string,
 *   matched: number,
 *   shown: number,
 *   atRoot: number,
 *   samples: Sample[],
 *   error?: string,
 * }} RuleReport
 *   `matched`: how many elements the rule hides. `shown`: how many of
 *   them show (the rest already hidden). `atRoot`: matches left alone
 *   because they are the page's root. `samples`: up to three, those that
 *   show first. `error`: why the rule matched nothing here, when this
 *   DOM can't parse its selector.
 */

/** @typedef {{ hidden: number, rules: RuleReport[] }} Explained
 *   `hidden`: how many elements the whole filter hides, each once. */

/**
 * What each of a filter's hide rules matches under `root`, for an agent
 * to judge it by.
 *
 * @param {Root} root
 * @param {Filter} filter a filter `checkFilter` passed
 * @param {View} view
 * @returns {Explained}
 */
export function explain(root, filter, view) {
    /** @type {Set<Element>} */
    const all = new Set();
    const roots = scopes(root);
    const rules = filter.hide.map((rule, i) => {
        const { hits, atRoot, error } = run(roots, rule, view);
        for (const el of hits) all.add(el);
        const shownHits = hits.filter((el) => view.visible(el));
        const picked = [...shownHits, ...hits.filter((el) => !shownHits.includes(el))].slice(0, 3);
        /** @type {RuleReport} */
        const report = {
            rule: i,
            selector: rule.selector,
            matched: hits.length,
            shown: shownHits.length,
            atRoot,
            samples: picked.map((el) => sample(el, view)),
        };
        if (rule.why !== undefined) report.why = rule.why;
        if (error !== undefined) report.error = error;
        return report;
    });
    return { hidden: all.size, rules };
}

/** @param {Element} el @param {View} view @returns {Sample} */
function sample(el, view) {
    const text = view.text(el);
    return { tag: el.localName, path: pathOf(el), text: text.length > 80 ? `${text.slice(0, 79)}…` : text };
}

/** @param {Element} el */
function step(el) {
    if (el.id) return `${el.localName}#${el.id}`;
    const classes = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
    return classes.length > 0 ? `${el.localName}.${classes.join(".")}` : el.localName;
}

/** where `el` is, from below the body, at most four steps @param {Element} el */
function pathOf(el) {
    const doc = el.ownerDocument;
    const outer = (/** @type {Element | null} */ p) => !p || p === doc.body || p === doc.documentElement;
    let out = step(el);
    let at = el;
    for (let n = 1; n < 4 && !outer(composedParent(at)); n++) {
        const parent = /** @type {Element} */ (composedParent(at));
        out = `${step(parent)} ${at.parentNode === parent ? ">" : ">>"} ${out}`;
        at = parent;
    }
    return outer(composedParent(at)) ? out : `… ${out}`;
}

/**
 * The live page's view, from layout: the text a person sees, the box it
 * draws, and whether it shows. Its text is what `innerText` gives (so
 * letters in hidden spans don't count) but read into open shadow roots
 * too, which `innerText` leaves out: the text nodes of what is drawn (a
 * host's shadow tree in place of its children, what's slotted in place
 * of a slot), none that is `display: none` or `visibility: hidden`, a
 * space between blocks. A capture's view reads the same text from the
 * capture's marks.
 *
 * @type {View}
 */
export const liveView = {
    text(el) {
        const win = el.ownerDocument.defaultView;
        if (!win) return squash(el.textContent ?? "");
        if (!liveView.visible(el)) return "";
        /** @type {string[]} */
        const parts = [];
        /** @param {Element} e @param {CSSStyleDeclaration} style */
        const inside = (e, style) => {
            const shows = style.visibility === "visible";
            for (const c of drawnChildren(e)) {
                if (c.nodeType === Node.TEXT_NODE) {
                    if (shows) parts.push(/** @type {Text} */ (c).data);
                } else if (c.nodeType === Node.ELEMENT_NODE) {
                    walk(/** @type {Element} */ (c));
                }
            }
        };
        /** @param {Element} e */
        const walk = (e) => {
            if (UNSEEN.has(e.localName)) return;
            const style = win.getComputedStyle(e);
            if (style.display === "none") return;
            const block = e.localName === "br" || (style.display !== "contents" && !style.display.startsWith("inline"));
            if (block) parts.push(" ");
            inside(e, style);
            if (block) parts.push(" ");
        };
        inside(el, win.getComputedStyle(el));
        return squash(parts.join(""));
    },
    box(el) {
        if (!liveView.visible(el)) return null;
        const r = el.getBoundingClientRect();
        const win = el.ownerDocument.defaultView;
        return {
            left: Math.round(r.left + (win?.scrollX ?? 0)),
            top: Math.round(r.top + (win?.scrollY ?? 0)),
            width: Math.round(r.width),
            height: Math.round(r.height),
        };
    },
    visible(el) {
        const win = el.ownerDocument.defaultView;
        // an element that draws no box of its own (a slot) shows as its parent does
        if (win && win.getComputedStyle(el).display === "contents") {
            const parent = composedParent(el);
            return parent ? liveView.visible(parent) : true;
        }
        if (typeof el.checkVisibility === "function" && !el.checkVisibility({ visibilityProperty: true })) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    },
};

/**
 * A rebuilt capture's view, from the marks the capture left
 * (`data-agex-box="left top width height"` on what draws a box,
 * `data-agex-block` beside it when layout drew a block, `data-agex-hidden`
 * on what draws nothing, its subtree with it). Its text is the text a
 * person would see: the text nodes of what is drawn (a host's shadow
 * tree in place of its children, what's slotted in place of a slot),
 * none under a hidden mark, a space between blocks.
 *
 * @type {View}
 */
export const capturedView = {
    text(el) {
        if (!capturedView.visible(el)) return "";
        /** @type {string[]} */
        const parts = [];
        /** @param {Node} node */
        const walk = (node) => {
            if (node.nodeType === Node.TEXT_NODE) {
                parts.push(/** @type {Text} */ (node).data);
                return;
            }
            if (node.nodeType !== Node.ELEMENT_NODE) return;
            const e = /** @type {Element} */ (node);
            if (e.hasAttribute("data-agex-hidden") || UNSEEN.has(e.localName)) return;
            // a block as layout drew it, which the capture records (`data-agex-block`): flex
            // and grid items are blocks by their style, not their tag; a capture without
            // boxes (written by hand) falls back to the tags that are blocks by default
            const block = e.localName === "br" || e.hasAttribute("data-agex-block") || (!e.hasAttribute("data-agex-box") && BLOCKS.has(e.localName));
            if (block) parts.push(" ");
            for (const c of drawnChildren(e)) walk(c);
            if (block) parts.push(" ");
        };
        for (const c of drawnChildren(el)) walk(c);
        return squash(parts.join(""));
    },
    box(el) {
        if (!capturedView.visible(el)) return null;
        const m = /^\s*(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s*$/.exec(el.getAttribute("data-agex-box") ?? "");
        return m ? { left: Number(m[1]), top: Number(m[2]), width: Number(m[3]), height: Number(m[4]) } : null;
    },
    visible(el) {
        for (let at = /** @type {Element | null} */ (el); at; at = composedParent(at)) {
            if (at.hasAttribute("data-agex-hidden")) return false;
        }
        return true;
    },
};

/**
 * What an element draws in its place: its shadow tree's nodes for a
 * host, what is slotted for a slot (its own children when nothing is),
 * else its children.
 *
 * @param {Element} el
 * @returns {Iterable<Node>}
 */
function drawnChildren(el) {
    if (el.shadowRoot) return el.shadowRoot.childNodes;
    if (el.localName === "slot" && typeof (/** @type {HTMLSlotElement} */ (el).assignedNodes) === "function") {
        const assigned = /** @type {HTMLSlotElement} */ (el).assignedNodes();
        if (assigned.length > 0) return assigned;
    }
    return el.childNodes;
}

/**
 * A capture's HTML as a document to run rules on, its declarative shadow
 * roots (`<template shadowrootmode="open">`, a host's first child)
 * attached as real ones: `Document.parseHTMLUnsafe` where there is one
 * (no script runs in what it makes), else `DOMParser` and the templates
 * attached by hand.
 *
 * @param {string} html
 * @returns {Document}
 */
export function parseCapture(html) {
    const parse = /** @type {{ parseHTMLUnsafe?: (html: string) => Document }} */ (/** @type {unknown} */ (Document)).parseHTMLUnsafe;
    if (typeof parse === "function") return parse.call(Document, html);
    const doc = new DOMParser().parseFromString(html, "text/html");
    attachDeclarative(doc);
    return doc;
}

/**
 * Attach each open declarative shadow root under `root` to its host,
 * nested ones too. A host that has a root already, or can't have one,
 * keeps its template as it is.
 *
 * @param {Document | ShadowRoot} root
 */
function attachDeclarative(root) {
    for (const t of [...root.querySelectorAll("template[shadowrootmode=open]")]) {
        const host = t.parentElement;
        if (!host || host.shadowRoot) continue;
        let shadow;
        try {
            shadow = host.attachShadow({ mode: "open" });
        } catch {
            continue;
        }
        shadow.append(/** @type {HTMLTemplateElement} */ (t).content);
        t.remove();
        attachDeclarative(shadow);
    }
}
