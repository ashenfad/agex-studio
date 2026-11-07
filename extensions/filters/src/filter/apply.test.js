// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { FILTERED, FILTER_STYLE, applyFilter } from "./apply.js";
import { checkFilter } from "./format.js";

/** a checked filter of these hide rules @param {unknown[]} hide */
function filterOf(...hide) {
    const r = checkFilter({ version: 1, hide }, { site: "example.com" });
    if (!r.ok) throw new Error(r.errors.join("\n"));
    return r.filter;
}

const tick = (/** @type {number} */ ms) => new Promise((ok) => setTimeout(ok, ms));

/** the ids of what's marked, and how @returns {Record<string, string | null>} */
const marks = () => Object.fromEntries([...document.querySelectorAll(`[${FILTERED}]`)].map((el) => [el.id, el.getAttribute(FILTERED)]));

describe("applyFilter", () => {
    afterEach(() => {
        applyFilter(document, filterOf(), { mode: "off" });
        document.body.innerHTML = "";
    });

    /** a feed, and a host whose open shadow root holds a promo */
    const feed = () => {
        document.body.innerHTML = '<main><div id="feed"><article id="a1" class="ad"></article><article id="a2"></article><div id="host"></div></div></main>';
        const root = /** @type {Element} */ (document.getElementById("host")).attachShadow({ mode: "open" });
        root.innerHTML = '<span class="promo" id="s1">Promo</span>';
        return root;
    };

    it("marks what the filter matches, with a stylesheet where it is", () => {
        const root = feed();
        const applied = applyFilter(document, filterOf({ selector: "article.ad" }, { selector: ".promo" }));
        expect(marks()).toEqual({ a1: "hide" });
        expect(root.getElementById("s1")?.getAttribute(FILTERED)).toBe("hide");
        expect(document.head.querySelectorAll(`style[${FILTER_STYLE}]`)).toHaveLength(1);
        expect(root.querySelectorAll(`style[${FILTER_STYLE}]`)).toHaveLength(1);
        expect(applied.count()).toBe(2);
    });

    it("replaces what applied before: another mode, another filter, or off", () => {
        feed();
        applyFilter(document, filterOf({ selector: "article.ad" }));
        const outlined = applyFilter(document, filterOf({ selector: "article.ad" }), { mode: "outline" });
        expect(marks()).toEqual({ a1: "outline" });
        expect(outlined.mode).toBe("outline");
        applyFilter(document, filterOf({ selector: "#a2" }));
        expect(marks()).toEqual({ a2: "hide" });
        expect(document.querySelectorAll(`style[${FILTER_STYLE}]`)).toHaveLength(1);
        const off = applyFilter(document, filterOf({ selector: "#a2" }), { mode: "off" });
        expect(marks()).toEqual({});
        expect(document.querySelectorAll(`style[${FILTER_STYLE}]`)).toHaveLength(0);
        expect(off.count()).toBe(0);
    });

    it("matches again as the page changes, and no more once stopped", async () => {
        feed();
        const applied = applyFilter(document, filterOf({ selector: "article.ad" }), { debounce: 10 });
        const feedEl = /** @type {Element} */ (document.getElementById("feed"));
        feedEl.insertAdjacentHTML("beforeend", '<article id="a3" class="ad"></article>');
        /** @type {Element} */ (document.getElementById("a1")).classList.remove("ad");
        await tick(60);
        expect(marks()).toEqual({ a3: "hide" });
        expect(applied.count()).toBe(1);

        // a copy the page makes of a marked element, made into something else, isn't hidden
        const copy = /** @type {Element} */ (/** @type {Element} */ (document.getElementById("a3")).cloneNode());
        copy.id = "a5";
        copy.classList.remove("ad");
        feedEl.append(copy);
        await tick(60);
        expect(marks()).toEqual({ a3: "hide" });

        applied.stop();
        expect(marks()).toEqual({});
        feedEl.insertAdjacentHTML("beforeend", '<article id="a4" class="ad"></article>');
        await tick(60);
        expect(marks()).toEqual({});
    });

    it("re-adds its stylesheet when the page takes it out", async () => {
        feed();
        applyFilter(document, filterOf({ selector: "article.ad" }), { debounce: 10 });
        document.querySelector(`style[${FILTER_STYLE}]`)?.remove();
        await tick(60);
        expect(document.querySelectorAll(`style[${FILTER_STYLE}]`)).toHaveLength(1);
    });
});
