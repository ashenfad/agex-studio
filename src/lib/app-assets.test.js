/**
 * Tests for the app-asset helpers.
 *
 * Pure functions only — no DOM, no iframe. Asset map construction,
 * HTML / CSS reference rewriting, and the injected-script
 * fetch-monkey-patch shape get covered here. The integration into
 * `buildAppHtml` + the test/live app orchestrators gets covered
 * separately by their existing tests, plus a smoke test below
 * that round-trips a representative asset through the script.
 */

import { describe, expect, it } from "vitest";

import {
    BINARY_EXTS,
    buildAssetsScript,
    buildAssetUrlMap,
    bytesToDataUrl,
    isBinaryAppFile,
    rewriteCssAssetRefs,
    rewriteHtmlAssetRefs,
} from "./app-assets.js";

describe("isBinaryAppFile", () => {
    it("identifies common image extensions", () => {
        expect(isBinaryAppFile("app/logo.png")).toBe(true);
        expect(isBinaryAppFile("app/photo.jpg")).toBe(true);
        expect(isBinaryAppFile("app/icon.svg")).toBe(true);
        expect(isBinaryAppFile("app/sub/dir/pic.webp")).toBe(true);
    });

    it("identifies fonts and other media", () => {
        expect(isBinaryAppFile("app/font.woff2")).toBe(true);
        expect(isBinaryAppFile("app/clip.mp4")).toBe(true);
    });

    it("rejects text / source extensions", () => {
        expect(isBinaryAppFile("app/index.html")).toBe(false);
        expect(isBinaryAppFile("app/script.js")).toBe(false);
        expect(isBinaryAppFile("app/style.css")).toBe(false);
        expect(isBinaryAppFile("app/data.json")).toBe(false);
        expect(isBinaryAppFile("app/README.md")).toBe(false);
    });

    it("is case-insensitive on the extension", () => {
        expect(isBinaryAppFile("app/LOGO.PNG")).toBe(true);
        expect(isBinaryAppFile("app/Photo.JPG")).toBe(true);
    });

    it("treats files with no extension as non-binary", () => {
        expect(isBinaryAppFile("app/Makefile")).toBe(false);
        expect(isBinaryAppFile("app/dotfiles/.gitkeep")).toBe(false);
    });
});

describe("bytesToDataUrl", () => {
    it("encodes PNG bytes with the right MIME", () => {
        const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
        const url = bytesToDataUrl("app/logo.png", bytes);
        expect(url.startsWith("data:image/png;base64,")).toBe(true);
        // 4 input bytes → 8-char base64 string (with padding)
        expect(url.slice("data:image/png;base64,".length)).toBe("iVBORw==");
    });

    it("maps jpg / jpeg to the same image/jpeg MIME", () => {
        const bytes = new Uint8Array([0xff, 0xd8, 0xff]);
        expect(bytesToDataUrl("a.jpg", bytes).startsWith("data:image/jpeg;base64,"))
            .toBe(true);
        expect(bytesToDataUrl("a.jpeg", bytes).startsWith("data:image/jpeg;base64,"))
            .toBe(true);
    });

    it("uses application/octet-stream for unknown extensions", () => {
        const bytes = new Uint8Array([1, 2, 3]);
        const url = bytesToDataUrl("app/strange.xyz", bytes);
        expect(url.startsWith("data:application/octet-stream;base64,")).toBe(true);
    });
});

describe("buildAssetUrlMap", () => {
    it("strips the app/ prefix from keys", () => {
        const map = buildAssetUrlMap({
            "app/logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
            "app/icons/star.svg": new Uint8Array([0x3c, 0x73, 0x76]),
        });
        expect(Object.keys(map).sort()).toEqual(["icons/star.svg", "logo.png"]);
    });

    it("preserves nested paths under app/", () => {
        const map = buildAssetUrlMap({
            "app/assets/img/hero.jpg": new Uint8Array([0xff, 0xd8]),
        });
        expect(Object.keys(map)).toEqual(["assets/img/hero.jpg"]);
        expect(map["assets/img/hero.jpg"].startsWith("data:image/jpeg;base64,"))
            .toBe(true);
    });

    it("returns an empty map for an empty input", () => {
        expect(buildAssetUrlMap({})).toEqual({});
    });
});

describe("rewriteHtmlAssetRefs", () => {
    const urls = {
        "logo.png": "data:image/png;base64,IMG",
        "icons/star.svg": "data:image/svg+xml;base64,SVG",
    };

    it("rewrites <img src> with both quote styles", () => {
        const html = `<img src="logo.png"><img src='logo.png'>`;
        const out = rewriteHtmlAssetRefs(html, urls);
        expect(out).toBe(
            `<img src="data:image/png;base64,IMG"><img src='data:image/png;base64,IMG'>`,
        );
    });

    it("rewrites <link href> for favicon and the like", () => {
        const html = `<link rel="icon" href="logo.png">`;
        const out = rewriteHtmlAssetRefs(html, urls);
        expect(out).toBe(`<link rel="icon" href="data:image/png;base64,IMG">`);
    });

    it("accepts a leading ./ on the reference", () => {
        const html = `<img src="./logo.png">`;
        const out = rewriteHtmlAssetRefs(html, urls);
        expect(out).toBe(`<img src="data:image/png;base64,IMG">`);
    });

    it("handles nested paths", () => {
        const html = `<img src="icons/star.svg">`;
        const out = rewriteHtmlAssetRefs(html, urls);
        expect(out).toBe(`<img src="data:image/svg+xml;base64,SVG">`);
    });

    it("leaves absolute / external URLs alone", () => {
        const html = `<img src="https://example.com/cat.png">`;
        const out = rewriteHtmlAssetRefs(html, urls);
        expect(out).toBe(html);
    });

    it("leaves references to unknown assets alone", () => {
        const html = `<img src="mystery.png">`;
        const out = rewriteHtmlAssetRefs(html, urls);
        expect(out).toBe(html);
    });

    it("rewrites multiple occurrences in one document", () => {
        const html = `
          <link rel="icon" href="logo.png">
          <img src="logo.png" alt="logo">
          <img src='./logo.png'>
        `.trim();
        const out = rewriteHtmlAssetRefs(html, urls);
        expect((out.match(/data:image\/png/g) || []).length).toBe(3);
        expect(out.includes("logo.png")).toBe(false);
    });

    it("no-ops on empty inputs", () => {
        expect(rewriteHtmlAssetRefs("", urls)).toBe("");
        expect(rewriteHtmlAssetRefs(`<img src="logo.png">`, {})).toBe(
            `<img src="logo.png">`,
        );
    });
});

describe("rewriteCssAssetRefs", () => {
    const urls = {
        "logo.png": "data:image/png;base64,IMG",
        "font.woff2": "data:font/woff2;base64,FONT",
    };

    it("rewrites url() with no quotes", () => {
        const css = `.hero { background: url(logo.png); }`;
        const out = rewriteCssAssetRefs(css, urls);
        expect(out).toBe(`.hero { background: url("data:image/png;base64,IMG"); }`);
    });

    it("rewrites url() with double quotes", () => {
        const css = `.hero { background: url("logo.png"); }`;
        const out = rewriteCssAssetRefs(css, urls);
        expect(out).toBe(`.hero { background: url("data:image/png;base64,IMG"); }`);
    });

    it("rewrites url() with single quotes", () => {
        const css = `.hero { background: url('logo.png'); }`;
        const out = rewriteCssAssetRefs(css, urls);
        expect(out).toBe(`.hero { background: url("data:image/png;base64,IMG"); }`);
    });

    it("accepts a leading ./ inside url()", () => {
        const css = `.hero { background: url(./logo.png); }`;
        const out = rewriteCssAssetRefs(css, urls);
        expect(out).toBe(`.hero { background: url("data:image/png;base64,IMG"); }`);
    });

    it("rewrites @font-face src", () => {
        const css = `@font-face { font-family: x; src: url(font.woff2); }`;
        const out = rewriteCssAssetRefs(css, urls);
        expect(out).toBe(
            `@font-face { font-family: x; src: url("data:font/woff2;base64,FONT"); }`,
        );
    });

    it("leaves absolute URLs alone", () => {
        const css = `.x { background: url(https://example.com/cat.png); }`;
        expect(rewriteCssAssetRefs(css, urls)).toBe(css);
    });

    it("leaves unknown asset refs alone", () => {
        const css = `.x { background: url(mystery.png); }`;
        expect(rewriteCssAssetRefs(css, urls)).toBe(css);
    });
});

describe("buildAssetsScript", () => {
    it("returns empty string for an empty asset map", () => {
        expect(buildAssetsScript({})).toBe("");
    });

    it("emits window.appAssets with the JSON-encoded map", () => {
        const out = buildAssetsScript({ "logo.png": "data:image/png;base64,IMG" });
        expect(out.includes("window.appAssets")).toBe(true);
        expect(out.includes('{"logo.png":"data:image/png;base64,IMG"}')).toBe(true);
    });

    it("wraps in an IIFE so the closure-scoped origFetch can't be tampered with", () => {
        const out = buildAssetsScript({ "x.png": "data:," });
        expect(out.includes("(function()")).toBe(true);
        expect(out.includes("})();")).toBe(true);
    });

    it("emits a fetch monkey-patch that intercepts asset paths", () => {
        // Execute the injected script in a sandboxed eval to verify
        // the patch behavior end-to-end. The script is plain ES5
        // wrapped in an IIFE — fine to Function-eval.
        const out = buildAssetsScript({ "logo.png": "data:image/png;base64,IMG" });
        // Strip the <script> wrapping
        const code = out.replace(/^<script>/, "").replace(/<\/script>$/, "");

        const fetchCalls = [];
        const fakeWindow = {
            appAssets: undefined,
            fetch: (url, init) => {
                fetchCalls.push({ url, init });
                return Promise.resolve({ ok: true });
            },
        };
        // The script references `window` directly. Execute with our
        // fake window as both `window` and `this`.
        new Function("window", code).call(fakeWindow, fakeWindow);

        // appAssets should be set
        expect(fakeWindow.appAssets).toEqual({
            "logo.png": "data:image/png;base64,IMG",
        });

        // Fetching a known asset should route through to the data URL
        return fakeWindow
            .fetch("logo.png")
            .then(() => fakeWindow.fetch("./logo.png"))
            .then(() => fakeWindow.fetch("/logo.png"))
            .then(() => fakeWindow.fetch("mystery.png"))
            .then(() => fakeWindow.fetch("https://example.com/a.png"))
            .then(() => {
                expect(fetchCalls.map((c) => c.url)).toEqual([
                    "data:image/png;base64,IMG", // logo.png
                    "data:image/png;base64,IMG", // ./logo.png
                    "data:image/png;base64,IMG", // /logo.png
                    "mystery.png", // unknown — passthrough
                    "https://example.com/a.png", // absolute — passthrough
                ]);
            });
    });

    it("passes a Request-like input through and matches on .url", () => {
        const out = buildAssetsScript({ "logo.png": "data:image/png;base64,IMG" });
        const code = out.replace(/^<script>/, "").replace(/<\/script>$/, "");
        const calls = [];
        const fakeWindow = {
            fetch: (url) => {
                calls.push(url);
                return Promise.resolve({ ok: true });
            },
        };
        new Function("window", code).call(fakeWindow, fakeWindow);
        return fakeWindow.fetch({ url: "logo.png" }).then(() => {
            expect(calls).toEqual(["data:image/png;base64,IMG"]);
        });
    });
});

describe("BINARY_EXTS", () => {
    it("covers common image and font extensions", () => {
        for (const ext of [".png", ".jpg", ".svg", ".woff2", ".pdf"]) {
            expect(BINARY_EXTS.includes(ext)).toBe(true);
        }
    });
});
