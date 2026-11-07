// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { capturedVisibleText } from "./rebuild.js";

/** a body of `html` @param {string} html */
const body = (html) => {
    document.body.innerHTML = html;
    return document.body;
};

describe("capturedVisibleText", () => {
    it("reads text nodes, skipping every subtree marked hidden", () => {
        const el = body(`<div>Kept <span data-agex-hidden>gone <b>also gone</b></span>too</div><p data-agex-hidden>Hidden</p>`);
        expect(capturedVisibleText(el)).toBe("Kept too");
    });

    it("breaks a line at blocks and <br>, and joins inline runs as drawn", () => {
        const el = body(`<div>Home</div><div>About</div><p>Sp<b>on</b>sored</p><span>one</span><span>two</span><br>three<li>item</li>`);
        expect(capturedVisibleText(el)).toBe("Home\nAbout\nSponsored\nonetwo\nthree\nitem");
    });

    it("breaks a line where layout drew a block, by its mark, not its tag, once boxes are recorded", () => {
        const box = `data-agex-box="0 0 10 10"`;
        const el = body(`<span ${box} data-agex-block>Sponsored</span><span ${box} data-agex-block>Today</span>` +
            `<div ${box}>in</div><div ${box}>line</div><div style="display: contents"><div>default</div></div>`);
        expect(capturedVisibleText(el)).toBe("Sponsored\nToday\ninline\ndefault");
    });

    it("collapses whitespace, and drops empty lines", () => {
        const el = body(`<div>\n   a   \n  b </div>\n\n<div>  </div>\n<div> c</div>`);
        expect(capturedVisibleText(el)).toBe("a b\nc");
    });

    it("reads a <br> inside a hidden-marked parent as nothing", () => {
        const el = body(`<p>a</p><div data-agex-hidden>b<br>c</div><p>d</p>`);
        expect(capturedVisibleText(el)).toBe("a\nd");
    });

    it("reads a shadow root in its host's place, a slot's assigned nodes in the slot's", () => {
        const el = body(`<x-card><span slot="title">Title</span><span>Body</span><i data-agex-hidden>unslotted</i></x-card>`);
        const host = /** @type {Element} */ (el.querySelector("x-card"));
        const root = host.attachShadow({ mode: "open" });
        root.innerHTML = `<h2><slot name="title">No title</slot></h2><div class="badge">Ad</div><slot name="none">Fallback</slot><p><slot></slot></p>`;
        expect(capturedVisibleText(el)).toBe("Title\nAd\nFallback\nBody");
    });

    it("reads a whole document from its root", () => {
        document.body.innerHTML = `<p>x</p>`;
        document.head.innerHTML = `<title>t</title>`;
        document.head.setAttribute("data-agex-hidden", "");
        expect(capturedVisibleText(document)).toBe("x");
    });
});
