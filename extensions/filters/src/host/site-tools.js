/**
 * The agent's tools, in the sandbox: its site's saved pages, a filter
 * tried on them, and a filter presented to the person. Every check runs
 * on the pages rebuilt from their captures (`filter/engine.js`'s
 * `parseCapture` and `capturedView`), the same way whatever the agent
 * asks.
 *
 * - `site`, a host object for the agent's code: `site.pages()`,
 *   `site.find(pattern)` (where text shows, and what holds it),
 *   `site.query(selector)` and `site.try(filter)`. Its code runs in a
 *   worker with no DOM, so these are how it looks at the pages.
 * - `present_filter`, a tool: the site's filter file checked, and on every
 *   page before and after, then handed to the extension, which puts it on
 *   for the site (or keeps it for the person to accept, where it can't).
 */

import { hostFactory, typedHost } from "@agex-ts/world";
import { z } from "zod";
import { capturedView, composedParent, explain, matchAll, parseCapture, shadowRoots } from "../filter/engine.js";
import { checkFilter } from "../filter/format.js";
import { patternProblem } from "../filter/guards.js";
import { siteOf } from "./sessions.js";

/** The most of a page's visible text a filter may hide: past it, the
 *  filter is hiding the page, not its clutter. */
export const MAX_HIDDEN_SHARE = 0.5;

/** Where the site's filter is kept, by convention. @param {string} site */
export const filterPath = (site) => `filters/${site}.json`;

/** @typedef {import("@agex-ts/world").Workspace} Workspace */
/** @typedef {{ page: string, url: string, title: string, html: string }} SavedPage */

/**
 * The site's saved pages, oldest first.
 *
 * @param {Workspace} ws
 * @returns {Promise<SavedPage[]>}
 */
export async function savedPages(ws) {
    if (!(await ws.files.exists("pages"))) return [];
    const numbers = (await ws.files.list("pages"))
        .flatMap((name) => (/^\d+\.json$/.test(name) ? [Number.parseInt(name, 10)] : []))
        .sort((a, b) => a - b);
    return Promise.all(
        numbers.map(async (n) => {
            const capture = JSON.parse(await ws.files.readText(`pages/${n}.json`));
            return { page: `pages/${n}`, url: capture.url, title: capture.title, html: capture.html };
        }),
    );
}

/** The site a workspace's session is for. @param {Workspace} ws */
function siteOfWs(ws) {
    const site = siteOf(ws.session);
    if (site === null) throw new Error(`session ${ws.session} isn't a site's`);
    return site;
}

/**
 * What `filter` does on each of the site's saved pages: per rule, what it
 * matches (`explain`), and per page how much of its visible text the
 * whole filter hides. A filter that fails the check says why, and is
 * tried on nothing.
 *
 * @param {Workspace} ws @param {unknown} filter
 */
export async function tryFilter(ws, filter) {
    const site = siteOfWs(ws);
    const checked = checkFilter(filter, { site });
    if ("errors" in checked) return { ok: false, errors: checked.errors };
    const pages = (await savedPages(ws)).map(({ page, url, html }) => {
        const doc = parseCapture(html);
        const { hidden, rules } = explain(doc, checked.filter, capturedView);
        // of what it hides, how much showed on the page as saved: hiding what was hidden anyway hides nothing
        const shown = [...matchAll(doc, checked.filter, capturedView)].filter((el) => capturedView.visible(el)).length;
        return { page, url, hidden, shown, hiddenShare: hiddenShare(doc, checked.filter), rules };
    });
    return { ok: true, pages };
}

/**
 * How much of a rebuilt page's visible text `filter` hides, from 0 to 1:
 * its body's text with what the filter matches marked hidden, against
 * its text as saved.
 *
 * @param {Document} doc @param {import("../filter/format.js").Filter} filter
 */
function hiddenShare(doc, filter) {
    const before = capturedView.text(doc.body).length;
    if (before === 0) return 0;
    const matched = matchAll(doc, filter, capturedView);
    for (const el of matched) el.setAttribute("data-agex-hidden", "");
    const after = capturedView.text(doc.body).length;
    for (const el of matched) el.removeAttribute("data-agex-hidden");
    return Math.round((1 - after / before) * 1000) / 1000;
}

/** The most elements `find` and `query` describe on a page. */
const SAMPLES = 8;
/** The most levels of what holds a found element `find` gives. */
const HOLDERS = 6;

/**
 * An element in a line: its tag, id and first classes, and its other
 * attributes that a rule could name (`data-*`, `aria-label`, `role`,
 * `href`), cut short.
 *
 * @param {Element} el
 */
function describe(el) {
    let out = el.localName;
    if (el.id) out += `#${el.id}`;
    const classes = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3) : [];
    if (classes.length > 0) out += `.${classes.join(".")}`;
    for (const a of el.attributes) {
        const named = a.name.startsWith("data-") ? !a.name.startsWith("data-agex-") : ["aria-label", "role", "href", "slot"].includes(a.name);
        if (named) out += `[${a.name}=${JSON.stringify(a.value.length > 40 ? `${a.value.slice(0, 39)}…` : a.value)}]`;
    }
    const root = el.getRootNode();
    if (root.nodeType === Node.DOCUMENT_FRAGMENT_NODE) out = `(in ${describe(/** @type {ShadowRoot} */ (root).host)}'s shadow root) ${out}`;
    return out;
}

/** Every element of a rebuilt page, in its document and its shadow roots. @param {Document} doc */
function everyElement(doc) {
    return [doc, ...shadowRoots(doc)].flatMap((root) => [...root.querySelectorAll("*")]);
}

/** Whether `outer` holds `inner`, across shadow roots (a host holds what its shadow root does).
 *  @param {Element} outer @param {Element} inner */
function holds(outer, inner) {
    for (let at = composedParent(inner); at; at = composedParent(at)) if (at === outer) return true;
    return false;
}

/** A short piece of what an element shows. @param {Element} el */
function shown(el) {
    const text = capturedView.text(el);
    return text.length > 100 ? `${text.slice(0, 99)}…` : text;
}

/**
 * Where text matching `pattern` shows on each saved page: the smallest
 * elements whose visible text matches, each with what holds it, outermost
 * last (for a rule that names the label and goes `upward` to its card).
 *
 * @param {Workspace} ws @param {string} pattern a regular expression's source
 */
export async function findText(ws, pattern) {
    // the guard filters' patterns pass, for one that could stall this page
    const problem = patternProblem(pattern);
    if (problem !== null) throw new Error(`pattern: ${problem}`);
    const re = new RegExp(pattern);
    return (await savedPages(ws)).map(({ page, html }) => {
        const doc = parseCapture(html);
        const hits = everyElement(doc).filter((el) => capturedView.visible(el) && re.test(capturedView.text(el)));
        // the smallest: nothing below them matches too, inside their shadow roots included
        const smallest = hits.filter((el) => !hits.some((other) => other !== el && holds(el, other)));
        return {
            page,
            found: smallest.length,
            samples: smallest.slice(0, SAMPLES).map((el) => {
                /** @type {string[]} */
                const holders = [];
                for (let at = composedParent(el); at && at !== doc.body && holders.length < HOLDERS; at = composedParent(at)) holders.push(describe(at));
                return { element: describe(el), text: shown(el), holders };
            }),
        };
    });
}

/**
 * What `selector` matches on each saved page (in its shadow roots too),
 * and a few of them: how they read, and whether they show.
 *
 * @param {Workspace} ws @param {string} selector
 */
export async function querySelector(ws, selector) {
    return (await savedPages(ws)).map(({ page, html }) => {
        const doc = parseCapture(html);
        const els = [doc, ...shadowRoots(doc)].flatMap((root) => [...root.querySelectorAll(selector)]);
        return { page, matched: els.length, samples: els.slice(0, SAMPLES).map((el) => ({ element: describe(el), text: shown(el), shows: capturedView.visible(el) })) };
    });
}

/** `site`, the agent's code's view of its site's saved pages: one per session. */
export function siteHost() {
    return typedHost(
        hostFactory((ws) => ({
            /** The saved pages: each one's path, URL and title. */
            pages: async () => (await savedPages(ws)).map(({ page, url, title }) => ({ page, url, title })),
            /** Where text matching a pattern shows, and what holds it. */
            find: (/** @type {string} */ pattern) => findText(ws, pattern),
            /** What a selector matches. */
            query: (/** @type {string} */ selector) => querySelector(ws, selector),
            /** What a filter does on each saved page, or why it can't be tried. */
            try: (/** @type {unknown} */ filter) => tryFilter(ws, filter),
        })),
        {
            pages: {},
            find: { args: { pattern: z.string().min(1).max(300) } },
            query: { args: { selector: z.string().min(1).max(1000) } },
            try: { args: { filter: z.unknown() } },
        },
    );
}

/**
 * `present_filter`, the agent's word that the site's filter is ready: the
 * file at `filterPath(site)` checked, then tried on every saved page,
 * where it has to hide something somewhere and never more than
 * `MAX_HIDDEN_SHARE` of a page's text. What passes goes to `present`
 * (the extension, which puts it on for the site, or keeps it as the
 * site's candidate, and tells the person); what doesn't comes back to
 * the agent, saying why.
 *
 * @param {Workspace} ws
 * @param {(candidate: { site: string, filter: import("../filter/format.js").Filter, pages: { page: string, url: string, hidden: number, hiddenShare: number }[] }) => void} present
 * @returns {import("@agex-ts/world").Tool}
 */
export function presentFilterTool(ws, present) {
    const site = siteOfWs(ws);
    return {
        name: "present_filter",
        description: `Present ${filterPath(site)} to the person as ${site}'s filter, once it hides what it should on the site's saved pages. It's checked and tried on every saved page first; what fails comes back to you to fix. On a pass it goes on for the site at once (or, where the person kept the site from the extension, waits for them to preview and accept it), and the person can undo it: stop there, and say in a line what it hides.`,
        parameters: { type: "object", properties: {}, additionalProperties: false },
        async call() {
            const fail = (/** @type {string} */ text) => ({ text, images: [], isError: true });
            if (!(await ws.files.exists(filterPath(site)))) return fail(`no filter at ${filterPath(site)}: write it there first`);
            /** @type {unknown} */
            let filter;
            try {
                filter = JSON.parse(await ws.files.readText(filterPath(site)));
            } catch (e) {
                return fail(`${filterPath(site)} isn't JSON: ${e instanceof Error ? e.message : String(e)}`);
            }
            const tried = await tryFilter(ws, filter);
            if (!tried.ok) return fail(`${filterPath(site)} fails its check:\n${tried.errors.join("\n")}`);
            if (tried.pages.length === 0) return fail("there are no saved pages to try it on");
            const problems = [];
            if (tried.pages.every((p) => p.shown === 0)) problems.push("it hides nothing that shows on any saved page (what it matches was hidden there already)");
            for (const p of tried.pages) {
                if (p.hiddenShare > MAX_HIDDEN_SHARE) {
                    problems.push(`on ${p.page} it hides ${Math.round(p.hiddenShare * 100)}% of the text (at most ${MAX_HIDDEN_SHARE * 100}%): it's hiding the page, not its clutter`);
                }
            }
            if (problems.length > 0) return fail(`Not presented:\n${problems.join("\n")}`);
            const checked = checkFilter(filter, { site });
            if ("errors" in checked) return fail(checked.errors.join("\n"));
            const pages = tried.pages.map(({ page, url, hidden, hiddenShare }) => ({ page, url, hidden, hiddenShare }));
            present({ site, filter: checked.filter, pages });
            const lines = pages.map((p) => `${p.page}: ${p.hidden} hidden (${Math.round(p.hiddenShare * 100)}% of its text)`);
            return { text: `Presented to the person as ${site}'s filter:\n${lines.join("\n")}`, images: [], isError: false };
        },
    };
}
