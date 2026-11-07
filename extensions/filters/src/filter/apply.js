/**
 * A filter applied to a live page: what its hide rules match is marked
 * (`data-agex-filtered`), and a stylesheet in the document, and in each
 * shadow root holding a match, hides what is marked or, to show
 * what it hides, outlines it. The page is matched again as it changes
 * (an infinite feed, navigation inside a single-page app, a component
 * filling its shadow root), so what it adds later is filtered too.
 *
 * It imports only the engine and uses no extension API of its own (the
 * engine reads closed shadow roots through `chrome.dom` where it's
 * there), so a content script can load it as a module or have it bundled.
 * One filter applies to a document at a time: applying another, or
 * another mode, replaces it.
 */

import { liveView, matchAll, shadowRoots } from "./engine.js";

/** The attribute on what a filter hides; its value is the mode. */
export const FILTERED = "data-agex-filtered";

/** The attribute on the stylesheets the applier adds. */
export const FILTER_STYLE = "data-agex-filter-style";

const CSS = `[${FILTERED}="hide"]{display:none!important}` +
    `[${FILTERED}="outline"]{outline:2px dashed #e5484d!important;outline-offset:-2px!important;background-color:rgba(229,72,77,.08)!important}`;

/**
 * @typedef {"hide" | "outline" | "off"} Mode
 *   `hide`: what the filter matches is hidden. `outline`: shown,
 *   outlined, to preview it. `off`: nothing of the filter is left.
 */

/**
 * @typedef {{ mode: Mode, count(): number, stop(): void }} Applied
 *   `count`: how many elements on the page the filter hides now.
 *   `stop`: undo it all: no mark, no stylesheet, no watching.
 */

/** @type {WeakMap<Document, Applied>} */
const current = new WeakMap();

/** How often, in ms, the applier looks for shadow roots attached since its last pass. */
export const ROOTS_EVERY = 1000;

/**
 * Apply `filter` to `doc` in `mode`, replacing what applied there before,
 * and keep it applied as the page changes until it is stopped. Changes
 * are gathered for `debounce` ms (at most four times that while the page
 * keeps changing) before the page is matched again.
 *
 * @param {Document} doc
 * @param {import("./format.js").Filter} filter a filter `checkFilter` passed
 * @param {{ mode?: Mode, debounce?: number }} [opts]
 * @returns {Applied}
 */
export function applyFilter(doc, filter, { mode = "hide", debounce = 100 } = {}) {
    current.get(doc)?.stop();
    if (mode === "off") return { mode, count: () => 0, stop() {} };

    /** @type {Set<Element>} */
    let marked = new Set();
    /** @type {Map<Document | ShadowRoot, HTMLStyleElement>} */
    const styles = new Map();
    /** @type {WeakSet<Node>} */
    const watched = new WeakSet();
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    let since = 0;
    let stopped = false;

    const schedule = () => {
        if (stopped) return;
        const now = Date.now();
        if (timer === undefined) since = now;
        clearTimeout(timer);
        timer = setTimeout(() => {
            timer = undefined;
            pass();
        }, Math.max(0, Math.min(debounce, since + 4 * debounce - now)));
    };
    const observer = new MutationObserver(schedule);

    /** @param {Document | ShadowRoot} root */
    const styleIn = (root) => {
        const had = styles.get(root);
        if (had?.isConnected) return;
        const parent = root === doc ? (doc.head ?? doc.documentElement) : root;
        if (!parent) return;
        const style = doc.createElement("style");
        style.setAttribute(FILTER_STYLE, "");
        style.textContent = CSS;
        parent.append(style);
        styles.set(root, style);
    };

    /** @param {Document | ShadowRoot} root */
    const watch = (root) => {
        if (watched.has(root)) return;
        watched.add(root);
        observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
    };

    const pass = () => {
        if (stopped) return;
        // the applier's own sheets off while matching, so what it hid reads as the page draws it
        const sheets = [...styles.values()].map((s) => s.sheet).filter((s) => s !== null);
        for (const s of sheets) s.disabled = true;
        /** @type {Set<Element>} */
        let found;
        try {
            found = matchAll(doc, filter, liveView);
        } finally {
            for (const s of sheets) s.disabled = false;
        }
        const roots = [doc, ...shadowRoots(doc)];
        // a mark on anything else goes, a copy the page made of a marked element's too
        for (const root of roots) {
            for (const el of root.querySelectorAll(`[${FILTERED}]`)) if (!found.has(el)) el.removeAttribute(FILTERED);
        }
        for (const el of found) if (el.getAttribute(FILTERED) !== mode) el.setAttribute(FILTERED, mode);
        marked = found;

        styleIn(doc);
        for (const el of found) {
            const root = el.getRootNode();
            if (root !== doc && root.nodeType === Node.DOCUMENT_FRAGMENT_NODE) styleIn(/** @type {ShadowRoot} */ (root));
        }
        for (const root of roots) watch(root);
        // what the pass itself changed is no change to match again for
        observer.takeRecords();
    };

    // a shadow root attached later (a custom element upgraded after the page loaded) changes
    // nothing an observer sees until something inside it does: looked for now and then
    const newRoots = setInterval(() => {
        if (!stopped && shadowRoots(doc).some((root) => !watched.has(root))) schedule();
    }, ROOTS_EVERY);

    /** @type {Applied} */
    const applied = {
        mode,
        count: () => [...marked].filter((el) => el.isConnected).length,
        stop() {
            if (stopped) return;
            stopped = true;
            observer.disconnect();
            clearTimeout(timer);
            clearInterval(newRoots);
            for (const root of [doc, ...shadowRoots(doc)]) {
                for (const el of root.querySelectorAll(`[${FILTERED}]`)) el.removeAttribute(FILTERED);
            }
            for (const style of styles.values()) style.remove();
            marked = new Set();
            styles.clear();
            if (current.get(doc) === applied) current.delete(doc);
        },
    };
    current.set(doc, applied);
    pass();
    return applied;
}
