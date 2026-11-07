#!/usr/bin/env node
/**
 * How well a rebuilt capture predicts the live page: each saved page (the
 * outline bench's MHTML captures) loaded in Playwright's Chromium,
 * captured (`walk.js`), rebuilt in a page of its own (`rebuild.js`), and
 * the two compared on
 *
 * - selectors made from the live page's own elements (tags, classes,
 *   attributes and values, `:has()`, combinators, positions), each
 *   counted on both sides, in the document and every open shadow root;
 *   a selector agrees when both counts are the same, uncut and cut to
 *   the default size;
 * - visible text: the live body's `innerText` against
 *   `capturedVisibleText`, as words (lowercased: `innerText` applies
 *   `text-transform`), how many of each side's the other has.
 *
 * Where they disagree is put down to a cause, element by element: every
 * live element is numbered (`data-fid`) before a second capture, so an
 * element the rebuild matches differently can be found on both sides.
 *
 * Per page results go to `bench/out/fidelity.json` (not committed: they
 * hold the sites' own selectors); the console gets the numbers.
 *
 *     node extensions/filters/bench/fidelity.mjs                     # extension/bench/pages/*.mhtml
 *     node extensions/filters/bench/fidelity.mjs --pages DIR reddit  # some pages, from DIR
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { capturePage } from "../src/capture/walk.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(here, "..");
const outDir = join(here, "out");

const args = process.argv.slice(2);
const at = args.indexOf("--pages");
const pagesDir = at >= 0 ? resolve(args[at + 1]) : resolve(root, "../../extension/bench/pages");
const wanted = args.filter((a, i) => !a.startsWith("--") && (at < 0 || i !== at + 1));
const files = existsSync(pagesDir)
    ? readdirSync(pagesDir).filter((f) => f.endsWith(".mhtml") && (wanted.length === 0 || wanted.includes(basename(f, ".mhtml")))).sort()
    : [];
if (files.length === 0) {
    console.error(`no pages in ${pagesDir}: run extension/bench/capture.mjs, or name a directory with --pages`);
    process.exit(1);
}

// the rebuild's page, served as the extension's own pages will be
const TYPES = { ".html": "text/html", ".js": "text/javascript" };
const server = createServer((req, res) => {
    const file = join(root, new URL(req.url ?? "/", "http://x").pathname.slice(1));
    if (!file.startsWith(root) || !existsSync(file)) {
        res.statusCode = 404;
        res.end();
        return;
    }
    res.setHeader("content-type", TYPES[/** @type {keyof TYPES} */ (extname(file))] ?? "application/octet-stream");
    res.end(readFileSync(file));
});
await new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(undefined)));
const base = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`;

/**
 * Selectors from the live page's elements, a sample of each kind, the
 * same each run. Leaves out what a capture drops by design: the page's
 * code and styling (and what's inside it), event handler attributes.
 * Runs in the page, sent as source.
 *
 * @param {{ perKind: Record<string, number> }} opts
 * @returns {{ kind: string, selector: string }[]}
 */
function selectorsOf({ perKind }) {
    const DROPPED = "script, noscript, style, template, link";
    let seed = 1;
    const random = () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    /** @type {Element[]} */
    const els = [];
    /** @param {Document | ShadowRoot} r */
    const visit = (r) => {
        for (const el of r.querySelectorAll("*")) {
            if (!el.closest(DROPPED)) els.push(el);
            if (el.shadowRoot) visit(el.shadowRoot);
        }
    };
    visit(document);
    const tag = (/** @type {Element} */ el) => CSS.escape(el.localName);
    const classes = (/** @type {Element} */ el) => [...el.classList].filter((c) => c.length < 60);
    /** a short name for `el`: its tag, a class, or both @param {Element} el */
    const key = (el) => {
        const cs = classes(el);
        const r = random();
        if (cs.length === 0 || r < 0.34) return tag(el);
        const c = `.${CSS.escape(cs[Math.floor(random() * cs.length)])}`;
        return r < 0.67 ? c : `${tag(el)}${c}`;
    };
    const handler = (/** @type {Element} */ el, /** @type {string} */ name) => name.startsWith("on") && name in el;
    /** @type {Map<string, Set<string>>} */
    const kinds = new Map();
    const add = (/** @type {string} */ kind, /** @type {string} */ s) => {
        if (!kinds.has(kind)) kinds.set(kind, new Set());
        /** @type {Set<string>} */ (kinds.get(kind)).add(s);
    };
    for (const el of els) {
        add("tag", tag(el));
        for (const c of classes(el)) {
            add("class", `.${CSS.escape(c)}`);
            add("tag.class", `${tag(el)}.${CSS.escape(c)}`);
        }
        for (const a of el.attributes) {
            if (handler(el, a.name) || a.name === "class" || a.name === "data-fid") continue;
            add("attribute", `[${CSS.escape(a.name)}]`);
            if (a.value.length > 0 && a.value.length <= 60 && !/[\x00-\x1f"\\]/.test(a.value)) add("attribute=value", `${tag(el)}[${CSS.escape(a.name)}="${a.value}"]`);
        }
        const parent = el.parentElement;
        if (parent && !parent.closest(DROPPED)) {
            const [p, c] = [key(parent), key(el)];
            add(":has(> child)", `${p}:has(> ${c})`);
            add("parent > child", `${p} > ${c}`);
            let up = parent;
            for (let n = Math.floor(random() * 4); n > 0 && up.parentElement; n--) up = up.parentElement;
            add(":has(descendant)", `${key(up)}:has(${c})`);
            add("ancestor descendant", `${key(up)} ${c}`);
            const index = [...parent.children].indexOf(el) + 1;
            const prev = el.previousElementSibling;
            const forms = [`${c}:nth-child(${index})`, `${c}:first-child`, `${c}:last-child`, `${c}:nth-of-type(2)`, `${c}:empty`];
            if (prev && !prev.matches(DROPPED)) forms.push(`${key(prev)} + ${c}`);
            add("position", forms[Math.floor(random() * forms.length)]);
        }
    }
    /** @type {{ kind: string, selector: string }[]} */
    const out = [];
    for (const [kind, set] of kinds) {
        const all = [...set].sort();
        for (let i = all.length - 1; i > 0; i--) {
            const j = Math.floor(random() * (i + 1));
            [all[i], all[j]] = [all[j], all[i]];
        }
        const n = perKind[kind] ?? 20;
        let taken = 0;
        for (const selector of all) {
            if (taken >= n) break;
            try {
                document.querySelector(selector);
            } catch {
                continue;
            }
            out.push({ kind, selector });
            taken++;
        }
    }
    return out;
}

/**
 * The `data-fid`s each selector matches in `scope` and its open shadow
 * roots, nested ones too. Runs in the page, sent as source.
 * @param {Document} scope @param {string[]} selectors @returns {(string | null)[][]}
 */
function matchesOf(scope, selectors) {
    /** @type {(Document | ShadowRoot)[]} */
    const roots = [];
    /** @param {Document | ShadowRoot} r */
    const visit = (r) => {
        roots.push(r);
        for (const el of r.querySelectorAll("*")) if (el.shadowRoot) visit(el.shadowRoot);
    };
    visit(scope);
    return selectors.map((s) => {
        try {
            return roots.flatMap((r) => [...r.querySelectorAll(s)].map((el) => el.getAttribute("data-fid")));
        } catch {
            return [];
        }
    });
}

/** Number every element, in the document and open shadow roots. Runs in the page. */
function numberAll() {
    let n = 0;
    /** @param {Document | ShadowRoot} r */
    const visit = (r) => {
        for (const el of r.querySelectorAll("*")) {
            el.setAttribute("data-fid", String(n++));
            if (el.shadowRoot) visit(el.shadowRoot);
        }
    };
    visit(document);
    return n;
}

/**
 * Each numbered element's place: its parent's number, its index among
 * its parent's element children, its attributes, and whether layout
 * renders it (`checkVisibility`). Runs in the page, sent as source.
 * @param {Document} scope
 */
function placesOf(scope) {
    const DROPPED = "script, noscript, style, template, link[rel~=stylesheet i], link[rel~=preload i], link[rel~=modulepreload i], link[rel~=prefetch i]";
    /** @type {Record<string, { parent: string | null, index: number, attrs: string, rendered: boolean, root: boolean, dropped: boolean }>} */
    const out = {};
    /** @param {Document | ShadowRoot} r */
    const visit = (r) => {
        for (const el of r.querySelectorAll("[data-fid]")) {
            const parent = el.parentElement ?? (el.parentNode instanceof ShadowRoot ? el.parentNode.host : null);
            const attrs = [...el.attributes].filter((a) => !a.name.startsWith("data-agex-") && !(a.name.startsWith("on") && a.name in el)).map((a) => `${a.name}=${a.value}`).sort().join("\n");
            out[/** @type {string} */ (el.getAttribute("data-fid"))] = {
                parent: parent?.getAttribute("data-fid") ?? null,
                index: el.parentNode ? [...(/** @type {ParentNode} */ (el.parentNode)).children].indexOf(el) : -1,
                attrs,
                rendered: scope === document ? el.checkVisibility() : !el.closest("[data-agex-hidden]"),
                root: el.getRootNode() !== scope,
                dropped: el.closest(DROPPED) !== null,
            };
        }
        for (const el of r.querySelectorAll("*")) if (el.shadowRoot) visit(el.shadowRoot);
    };
    visit(scope);
    return out;
}

/** words, lowercased @param {string} s */
const words = (s) => s.toLowerCase().split(/[\s\u00a0]+/).filter(Boolean);
/** @param {string[]} ws */
const bag = (ws) => {
    /** @type {Map<string, number>} */
    const m = new Map();
    for (const w of ws) m.set(w, (m.get(w) ?? 0) + 1);
    return m;
};
/** how many of `a`'s words `b` has @param {Map<string, number>} a @param {Map<string, number>} b */
const shared = (a, b) => {
    let n = 0;
    for (const [w, c] of a) n += Math.min(c, b.get(w) ?? 0);
    return n;
};
/** `a` less `b` @param {Map<string, number>} a @param {Map<string, number>} b */
const minus = (a, b) => {
    /** @type {Map<string, number>} */
    const m = new Map();
    for (const [w, c] of a) if (c > (b.get(w) ?? 0)) m.set(w, c - (b.get(w) ?? 0));
    return m;
};
/** Take from `left` what `from` explains, and say how much. @param {Map<string, number>} left @param {Map<string, number>} from */
const explain = (left, from) => {
    let n = 0;
    for (const [w, c] of from) {
        const k = Math.min(c, left.get(w) ?? 0);
        if (k === 0) continue;
        n += k;
        left.set(w, /** @type {number} */ (left.get(w)) - k);
    }
    return n;
};
const sum = (/** @type {Map<string, number>} */ m) => [...m.values()].reduce((a, b) => a + b, 0);

const PER_KIND = {
    tag: 40, class: 70, "tag.class": 30, attribute: 40, "attribute=value": 40,
    ":has(> child)": 30, ":has(descendant)": 30, "parent > child": 20, "ancestor descendant": 20, position: 40,
};

mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ channel: "chromium", headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
/** @type {any[]} */
const rows = [];
for (const file of files) {
    const name = basename(file, ".mhtml");
    const live = await context.newPage();
    const rebuilt = await context.newPage();
    try {
        await live.goto(pathToFileURL(join(pagesDir, file)).href, { waitUntil: "load", timeout: 60_000 });
        await rebuilt.goto(`${base}/test/page/blank.html`);
        await rebuilt.evaluate(async () => {
            const m = await import("/src/capture/rebuild.js");
            Object.assign(globalThis, m);
        });

        // the capture as the extension makes it: its size and time, whole and cut to the default
        let t = performance.now();
        /** @type {import("../src/capture/walk.js").Capture} */
        const whole = await live.evaluate(`(${capturePage})({ maxBytes: 1e12 })`);
        const ms = Math.round(performance.now() - t);
        t = performance.now();
        /** @type {import("../src/capture/walk.js").Capture} */
        const capped = await live.evaluate(`(${capturePage})({})`);
        const cappedMs = Math.round(performance.now() - t);

        // then numbered, to follow each element across
        const selectors = await live.evaluate(`(${selectorsOf})(${JSON.stringify({ perKind: PER_KIND })})`);
        const elements = await live.evaluate(`(${numberAll})()`);
        const liveText = await live.evaluate(() => document.body?.innerText ?? "");
        // what the MHTML shows that a page with scripts running wouldn't: `<noscript>`'s content
        const selectText = await live.evaluate(() => [...document.querySelectorAll("body select")].map((n) => /** @type {HTMLElement} */ (n).innerText).join(" "));
        const noscriptText = await live.evaluate(() => [...document.querySelectorAll("body noscript")].map((n) => /** @type {HTMLElement} */ (n).innerText).join(" "));
        const sels = selectors.map((/** @type {any} */ s) => s.selector);
        const liveMatches = await live.evaluate(`(${matchesOf})(document, ${JSON.stringify(sels)})`);
        const livePlaces = await live.evaluate(`(${placesOf})(document)`);
        const shadowRoots = await live.evaluate(() => {
            let n = 0;
            for (const el of document.querySelectorAll("*")) if (el.shadowRoot) n++;
            return n;
        });

        /** @param {{ maxBytes: number }} opts */
        const compare = async (opts) => {
            /** @type {import("../src/capture/walk.js").Capture} */
            const c = await live.evaluate(`(${capturePage})(${JSON.stringify(opts)})`);
            await rebuilt.evaluate((html) => {
                const g = /** @type {any} */ (globalThis);
                g.doc = g.rebuildCapture(html);
            }, c.html);
            const got = await rebuilt.evaluate(`(${matchesOf})(globalThis.doc, ${JSON.stringify(sels)})`);
            const places = await rebuilt.evaluate(`(${placesOf})(globalThis.doc)`);
            const text = await rebuilt.evaluate(() => {
                const g = /** @type {any} */ (globalThis);
                const body = g.doc.body;
                // the text of each kind of place `innerText` reads otherwise
                const of = (/** @type {string} */ sel) => [...body.querySelectorAll(sel)].filter((e) => !e.closest("[data-agex-hidden]")).map((e) => g.capturedVisibleText(e)).join(" ");
                /** @type {string[]} */
                const shadow = [];
                const visit = (/** @type {Element | ShadowRoot} */ r) => {
                    for (const el of r.querySelectorAll("*")) {
                        if (!el.shadowRoot || el.closest("[data-agex-hidden]")) continue;
                        // a shadow tree's own text: its slots' assigned nodes are the host's light DOM
                        const frag = document.createDocumentFragment();
                        frag.append(...[.../** @type {ShadowRoot} */ (el.shadowRoot).childNodes].map((n) => n.cloneNode(true)));
                        for (const s of frag.querySelectorAll("slot")) s.replaceChildren();
                        shadow.push(g.capturedVisibleText(frag));
                        visit(el.shadowRoot);
                    }
                };
                visit(body);
                return { all: g.capturedVisibleText(body), shadow: shadow.join(" "), select: of("select"), textarea: of("textarea") };
            });

            // selectors
            const kinds = /** @type {Record<string, { n: number, agree: number }>} */ ({});
            const causes = /** @type {Record<string, number>} */ ({});
            let agree = 0;
            // agreement on what the capture kept: the live matches less those cut
            let agreeKept = 0;
            let countOnly = 0;
            /** @type {{ kind: string, selector: string, live: number, rebuilt: number, cause: string }[]} */
            const disagree = [];
            selectors.forEach((/** @type {any} */ s, /** @type {number} */ i) => {
                const k = (kinds[s.kind] ??= { n: 0, agree: 0 });
                k.n++;
                const a = /** @type {(string | null)[]} */ (liveMatches[i]);
                const b = /** @type {(string | null)[]} */ (got[i]);
                // the same elements, by number, on both sides (an element the parser made has none)
                const same = (/** @type {(string | null)[]} */ x, /** @type {(string | null)[]} */ y) =>
                    x.length === y.length && [...x].sort().join("\n") === [...y].sort().join("\n");
                if (same(c.cut ? a.filter((f) => f === null || f in places) : a, b)) agreeKept++;
                if (same(a, b)) {
                    k.agree++;
                    agree++;
                    return;
                }
                // as many matches, but not the same elements: a count alone would have agreed
                if (a.length === b.length) countOnly++;
                // the first element matched on one side only, and why
                const inB = new Set(b);
                const inA = new Set(a);
                const missing = a.find((f) => !inB.has(f));
                const extra = b.find((f) => !inA.has(f));
                let cause = "other";
                const fid = missing ?? extra;
                if (missing !== undefined && missing !== null && livePlaces[missing]?.dropped) {
                    cause = "the page's code or styling, left out by design";
                } else if (missing !== undefined && missing !== null && !(missing in places)) {
                    cause = c.cut && !c.html.includes(`data-fid="${missing}"`) ? "cut" : c.html.includes(`data-fid="${missing}"`) ? "dropped by the parser" : "not captured";
                } else if (fid !== undefined && fid !== null) {
                    const [p, q] = [livePlaces[fid], places[fid]];
                    if (!p || !q) cause = "other";
                    else if (p.parent !== q.parent) cause = "moved by the parser";
                    else if (p.attrs !== q.attrs) cause = "attribute changed";
                    else if (s.kind === "position" && p.index !== q.index) cause = "position among siblings";
                    else if (s.selector.includes(":empty")) cause = "children dropped (:empty)";
                    else cause = s.kind === ":has(descendant)" || s.kind === ":has(> child)" || s.kind === "ancestor descendant" || s.kind === "parent > child" ? "relative changed" : "other";
                }
                causes[cause] = (causes[cause] ?? 0) + 1;
                disagree.push({ kind: s.kind, selector: s.selector, live: a.length, rebuilt: b.length, cause });
            });

            // text
            const L = bag(words(liveText));
            const C = bag(words(text.all));
            const common = shared(L, C);
            const onlyCaptured = minus(C, L);
            const onlyLive = minus(L, C);
            const extraCauses = {
                "shadow tree text": explain(onlyCaptured, bag(words(text.shadow))),
                "select options": explain(onlyCaptured, bag(words(text.select))),
                "textarea text": explain(onlyCaptured, bag(words(text.textarea))),
            };
            const liveFlat = liveText.toLowerCase().replace(/\s+/g, "");
            let glued = 0;
            for (const [w, n] of onlyCaptured) if (n > 0 && w.length > 3 && liveFlat.includes(w)) glued += n;
            const extraLeft = sum(onlyCaptured) - glued;
            /** @type {Record<string, number>} */
            const missingCauses = {
                "noscript content (MHTML runs no scripts)": explain(onlyLive, bag(words(noscriptText))),
                "a closed select's options, which innerText reads": explain(onlyLive, bag(words(selectText))),
            };
            // live words a word only the capture has is made of: run together there
            let gluedLive = 0;
            for (const [w, n] of onlyLive) {
                if (n === 0) continue;
                for (const [g, k] of onlyCaptured) {
                    if (k > 0 && g.length > w.length && g.includes(w)) {
                        gluedLive += n;
                        onlyLive.set(w, 0);
                        break;
                    }
                }
            }
            missingCauses["words run together in the capture"] = gluedLive;
            // live text in elements the capture marked hidden that layout renders (zero size, clipped)
            const hiddenRendered = await live.evaluate((fids) => [...fids].map((f) => document.querySelector(`[data-fid="${f}"]`)).filter((e) => e && e.checkVisibility()).map((e) => /** @type {HTMLElement} */ (e).innerText ?? "").join(" "),
                Object.entries(places).filter(([f, q]) => !q.rendered && livePlaces[f]?.rendered && (places[livePlaces[f].parent ?? ""]?.rendered ?? true)).map(([f]) => f));
            missingCauses["marked hidden, which innerText reads (transparent, zero size, clipped)"] = explain(onlyLive, bag(words(hiddenRendered)));
            return {
                bytes: c.bytes, cut: c.cut ?? 0,
                disagree,
                ...(process.env.SAMPLES && { samples: {
                    onlyCaptured: [...onlyCaptured].filter(([, n]) => n > 0).slice(0, 80),
                    onlyLive: [...onlyLive].filter(([, n]) => n > 0).slice(0, 80),
                    cuts: [...c.html.matchAll(/<([a-z0-9-]+)[^>]*data-agex-cut="(\d+)"/g)].map((m) => `${m[1]} ${m[2]}`),
                } }),
                selectors: { n: selectors.length, agree, agreeKept, countOnly, kinds, causes },
                // of the elements a capture means to keep: not the page's code or styling
                kept: Object.keys(places).length / Math.max(Object.values(livePlaces).filter((p) => !p.dropped).length, 1),
                text: {
                    liveWords: sum(L), capturedWords: sum(C), common,
                    recall: common / Math.max(sum(L), 1), precision: common / Math.max(sum(C), 1),
                    onlyCaptured: { ...extraCauses, "words run together (a box drawn as a block, by its style)": glued, other: extraLeft },
                    onlyLive: { ...missingCauses, other: sum(onlyLive) },
                },
            };
        };
        const uncut = await compare({ maxBytes: 1e12 });
        // cut as the extension would cut it: the numbers' own bytes added to the default
        const cut = whole.bytes > 2_000_000 ? await compare({ maxBytes: 2_000_000 + (uncut.bytes - whole.bytes) }) : uncut;
        rows.push({ page: name, elements, shadowRoots, bytes: whole.bytes, ms, cappedBytes: capped.bytes, cappedMs, cut: capped.cut ?? 0, uncut, capped: cut });
        const pct = (/** @type {number} */ x) => `${(x * 100).toFixed(1)}%`;
        console.log(
            `${name.padEnd(12)} ${String(elements).padStart(6)} els ${String(shadowRoots).padStart(4)} roots ${String(Math.round(whole.bytes / 1024)).padStart(6)} KB ${String(cappedMs).padStart(5)} ms` +
            `${capped.cut ? ` cut ${Math.round(capped.cut / 1024)} KB` : ""} | selectors ${pct(uncut.selectors.agree / uncut.selectors.n)} (cut: ${pct(cut.selectors.agree / cut.selectors.n)}, on what it kept ${pct(cut.selectors.agreeKept / cut.selectors.n)}, ${pct(cut.kept)} of elements kept)` +
            ` | text recall ${pct(uncut.text.recall)} precision ${pct(uncut.text.precision)}`,
        );
    } catch (e) {
        rows.push({ page: name, error: String(e).slice(0, 300) });
        console.log(`${name.padEnd(12)} failed: ${String(e).slice(0, 200)}`);
    }
    await live.close();
    await rebuilt.close();
}
await browser.close();
server.close();
writeFileSync(join(outDir, "fidelity.json"), `${JSON.stringify(rows, null, 2)}\n`);

// the totals
const ok = rows.filter((r) => !r.error);
if (ok.length === 0) {
    console.error(`no page completed (${rows.length} failed)`);
    process.exit(1);
}
/** @param {"uncut" | "capped"} which */
const totals = (which) => {
    const kinds = /** @type {Record<string, { n: number, agree: number }>} */ ({});
    const causes = /** @type {Record<string, number>} */ ({});
    let n = 0;
    let agree = 0;
    let agreeKept = 0;
    let countOnly = 0;
    for (const r of ok) {
        countOnly += r[which].selectors.countOnly;
        n += r[which].selectors.n;
        agree += r[which].selectors.agree;
        agreeKept += r[which].selectors.agreeKept;
        for (const [k, v] of Object.entries(r[which].selectors.kinds)) {
            const t = (kinds[k] ??= { n: 0, agree: 0 });
            t.n += /** @type {any} */ (v).n;
            t.agree += /** @type {any} */ (v).agree;
        }
        for (const [k, v] of Object.entries(r[which].selectors.causes)) causes[k] = (causes[k] ?? 0) + /** @type {number} */ (v);
    }
    return { n, agree, agreeKept, countOnly, kinds, causes };
};
const pct = (/** @type {number} */ x) => `${(x * 100).toFixed(1)}%`;
for (const which of /** @type {const} */ (["uncut", "capped"])) {
    const t = totals(which);
    console.log(`\n${which}: selectors match the same elements ${t.agree}/${t.n} (${pct(t.agree / t.n)}); on what the capture kept ${pct(t.agreeKept / t.n)}; as many but others ${t.countOnly}`);
    for (const [k, v] of Object.entries(t.kinds)) console.log(`  ${k.padEnd(22)} ${pct(v.agree / v.n).padStart(6)} of ${v.n}`);
    console.log(`  disagreements by cause: ${Object.entries(t.causes).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ")}`);
}
const textTotals = (/** @type {"onlyCaptured" | "onlyLive"} */ side) => {
    const out = /** @type {Record<string, number>} */ ({});
    for (const r of ok) for (const [k, v] of Object.entries(r.uncut.text[side])) out[k] = (out[k] ?? 0) + /** @type {number} */ (v);
    return out;
};
const liveWords = ok.reduce((n, r) => n + r.uncut.text.liveWords, 0);
const capturedWords = ok.reduce((n, r) => n + r.uncut.text.capturedWords, 0);
const common = ok.reduce((n, r) => n + r.uncut.text.common, 0);
if (liveWords > 0 && capturedWords > 0) console.log(`\ntext: recall ${pct(common / liveWords)}, precision ${pct(common / capturedWords)} (${liveWords} live words, ${capturedWords} captured)`);
console.log(`  only captured: ${JSON.stringify(textTotals("onlyCaptured"))}`);
console.log(`  only live:     ${JSON.stringify(textTotals("onlyLive"))}`);

// a page's own spread: its size and time, and its text (pages with some to read)
/** @param {number[]} xs */
const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length === 0 ? 0 : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const read = ok.filter((r) => r.uncut.text.liveWords >= 20);
console.log(`\n${ok.length} pages (${rows.length - ok.length} failed), ${ok.filter((r) => r.cut > 0).length} over the default size`);
console.log(`  capture: median ${Math.round(median(ok.map((r) => r.bytes)) / 1024)} KB, max ${Math.round(Math.max(...ok.map((r) => r.bytes)) / 1024)} KB; median ${median(ok.map((r) => r.cappedMs))} ms, max ${Math.max(...ok.map((r) => r.cappedMs))} ms (within the default size)`);
if (read.length > 0) console.log(`  text per page (${read.length} with 20 words or more): recall median ${pct(median(read.map((r) => r.uncut.text.recall)))}, min ${pct(Math.min(...read.map((r) => r.uncut.text.recall)))}; precision median ${pct(median(read.map((r) => r.uncut.text.precision)))}, min ${pct(Math.min(...read.map((r) => r.uncut.text.precision)))}`);
console.log(`  selectors per page: median ${pct(median(ok.map((r) => r.uncut.selectors.agree / r.uncut.selectors.n)))}, min ${pct(Math.min(...ok.map((r) => r.uncut.selectors.agree / r.uncut.selectors.n)))}`);
