// @vitest-environment happy-dom
// The walk's writing and cutting, without layout: every element here is
// drawn, in a 10 by 10 box. What layout decides is the end-to-end test's
// (`test/capture.e2e.mjs`).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capturePage } from "./walk.js";

/** @param {string} html */
const page = (html) => {
    document.documentElement.innerHTML = html;
};
/** the capture's HTML read back @param {string} html */
const parse = (html) => new DOMParser().parseFromString(html, "text/html");

beforeEach(() => {
    vi.spyOn(Element.prototype, "checkVisibility").mockReturnValue(true);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(/** @type {DOMRect} */ ({ left: 1, top: 2, width: 10, height: 10 }));
    vi.spyOn(window, "getComputedStyle").mockReturnValue(
        /** @type {CSSStyleDeclaration} */ (/** @type {unknown} */ ({ display: "inline", visibility: "visible", opacity: "1", overflowX: "visible", overflowY: "visible" })),
    );
});
afterEach(() => vi.restoreAllMocks());

describe("capturePage's writing", () => {
    it("escapes text and attribute values, and they read back as they were", () => {
        const text = `a < b & c > d e "quoted" 'single'`;
        const title = `say "hi" & <bye> 'now'`;
        page(`<head></head><body><p id="p"></p></body>`);
        const p = /** @type {HTMLElement} */ (document.getElementById("p"));
        p.textContent = text;
        p.title = title;
        const { html } = capturePage();
        expect(html).toContain(`>a &lt; b &amp; c &gt; d&nbsp;e "quoted" 'single'</p>`);
        expect(html).toContain(`title="say &quot;hi&quot; &amp; &lt;bye&gt;&nbsp;'now'"`);
        const back = /** @type {HTMLElement} */ (parse(html).getElementById("p"));
        expect(back.textContent).toBe(text);
        expect(back.title).toBe(title);
    });

    it("leaves out the page's code, styling, comments and data-agex- attributes", () => {
        page(`<head><style>p{}</style><link rel="stylesheet" href="data:text/css,"><link rel="canonical" href="/x"></head>` +
            `<body><script>1</script><noscript>n</noscript><template><p>t</p></template><!-- c -->` +
            `<p id="p" data-agex-hidden data-agex-box="0 0 1 1" data-keep="1" onclick="x()" onboarding="yes">Kept</p></body>`);
        const { html } = capturePage();
        expect(html).not.toMatch(/<script|<style|<noscript|<template|<!--|stylesheet|onclick/);
        expect(html).toContain(`<link rel="canonical" href="/x"`);
        expect(html).toContain(`<p id="p" data-keep="1" onboarding="yes" data-agex-box="1 2 10 10">Kept</p>`);
    });

    it("writes void elements without an end tag, and doubles a <pre>'s leading newline", () => {
        page(`<head></head><body><img src="a.png" alt="x"><br><pre>\nline</pre></body>`);
        const { html } = capturePage();
        expect(html).toContain(`<img src="a.png" alt="x" data-agex-box="1 2 10 10"><br data-agex-box="1 2 10 10">`);
        expect(html).toMatch(/<pre[^>]*>\n\nline<\/pre>/);
    });

    it("keeps a long data: URL's type, not its payload", () => {
        page(`<head></head><body><img id="i"></body>`);
        document.getElementById("i")?.setAttribute("src", `data:image/png;base64,${"A".repeat(2000)}`);
        expect(capturePage().html).toContain(`src="data:image/png;base64,"`);
    });

    it("counts its size in UTF-8", () => {
        page(`<head></head><body><p>héllo — ✓</p></body>`);
        const c = capturePage();
        expect(c.bytes).toBe(new TextEncoder().encode(c.html).length);
        expect(c.cut).toBeUndefined();
    });
});

describe("capturePage's cut", () => {
    /** a list of `n` posts @param {string} id @param {number} n */
    const list = (id, n) => `<ul id="${id}">${Array.from({ length: n }, (_, i) => `<li>${id} post ${i} ${"words ".repeat(20)}</li>`).join("")}</ul>`;

    it("keeps long attribute values whole within the size, and cuts them first over it", () => {
        page(`<head></head><body><div id="blob"></div>${list("feed", 30)}</body>`);
        document.getElementById("blob")?.setAttribute("data-state", "x".repeat(20_000));
        const whole = capturePage();
        expect(parse(whole.html).getElementById("blob")?.getAttribute("data-state")).toHaveLength(20_000);
        const c = capturePage({ maxBytes: whole.bytes - 5000 });
        const doc = parse(c.html);
        expect(doc.getElementById("blob")?.getAttribute("data-state")).toHaveLength(1024);
        expect(doc.querySelectorAll("#feed > li")).toHaveLength(30);
        expect(c.cut).toBe(whole.bytes - c.bytes);
    });

    it("cuts the latest run of like siblings first, from its tail, and marks where", () => {
        page(`<head></head><body>${list("early", 30)}${list("late", 30)}<footer>end</footer></body>`);
        const whole = capturePage().bytes;
        const c = capturePage({ maxBytes: whole - 2000 });
        expect(c.bytes).toBeLessThanOrEqual(whole - 2000);
        expect(c.cut).toBe(whole - c.bytes);
        const doc = parse(c.html);
        expect(doc.querySelectorAll("#early > li")).toHaveLength(30);
        const late = doc.querySelectorAll("#late > li").length;
        expect(late).toBeLessThan(30);
        expect(doc.getElementById("late")?.getAttribute("data-agex-cut")).toBe(String(30 - late));
        expect(doc.querySelector("#late > li")?.textContent).toMatch(/^late post 0 /);
        expect(doc.querySelector("footer")?.textContent).toBe("end");
    });

    it("keeps a run's first five, then cuts an earlier run", () => {
        page(`<head></head><body>${list("early", 30)}${list("late", 30)}</body>`);
        const whole = capturePage().bytes;
        const doc = parse(capturePage({ maxBytes: Math.round(whole * 0.5) }).html);
        expect(doc.querySelectorAll("#late > li")).toHaveLength(5);
        expect(doc.querySelectorAll("#early > li").length).toBeLessThan(30);
    });

    it("cuts the end of the page when runs aren't enough, keeping what holds it", () => {
        const big = "x".repeat(10_000);
        page(`<head><title>t</title></head><body><main><section id="a">${big}</section><section id="b"><p>${big}</p><p>${big}</p></section></main></body>`);
        const c = capturePage({ maxBytes: 25_000 });
        expect(c.bytes).toBeLessThanOrEqual(25_000);
        const doc = parse(c.html);
        expect(doc.title).toBe("t");
        expect(doc.getElementById("a")?.textContent).toBe(big);
        expect(doc.querySelectorAll("#b > p")).toHaveLength(1);
        expect(doc.getElementById("b")?.getAttribute("data-agex-cut")).toBe("1");
    });

    it("cuts into the head when the head alone is over, and stays within the size", () => {
        const metas = Array.from({ length: 400 }, (_, i) => `<meta name="m${i}" content="${"v".repeat(40)}">`).join("");
        page(`<head>${metas}</head><body><p id="p">Body</p></body>`);
        document.title = "t".repeat(200_000);
        const whole = capturePage();
        for (const maxBytes of [100_000, 20_000, 2_000]) {
            const c = capturePage({ maxBytes });
            expect(c.bytes).toBeLessThanOrEqual(maxBytes);
            expect(c.bytes).toBe(new TextEncoder().encode(c.html).length);
            expect(c.cut).toBe(whole.bytes - c.bytes);
        }
    });

    it("stays within a size too small for the body", () => {
        page(`<head><title>t</title></head><body>${"<p>words words words</p>".repeat(200)}</body>`);
        const c = capturePage({ maxBytes: 300 });
        expect(c.bytes).toBeLessThanOrEqual(300);
        expect(parse(c.html).documentElement.localName).toBe("html");
    });
});
