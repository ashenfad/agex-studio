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
    assetToken,
    buildAssetsScript,
    collectAssets,
    hostInit,
    inlineAssets,
    isBinaryAppFile,
    resolveAssetTokens,
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

describe("collectAssets", () => {
    it("names each asset by a token, keyed without the app/ prefix", () => {
        const { urls, assets } = collectAssets({
            "app/logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
            "app/icons/star.svg": new Uint8Array([0x3c, 0x73, 0x76]),
        });
        expect(urls).toEqual({ "logo.png": assetToken(0), "icons/star.svg": assetToken(1) });
        expect(assets.map((a) => a.type)).toEqual(["image/png", "image/svg+xml"]);
        expect(assets[0].bytes).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    });

    it("takes the app's data files too, not its page, scripts or styles", () => {
        const { urls, assets } = collectAssets({}, {
            "app/index.html": "<html></html>",
            "app/main.js": "go()",
            "app/style.css": "body{}",
            "app/data/sales.csv": "a,b\n1,2",
            "app/config.json": "{}",
            "app/help.html": "<p>help</p>",
        });
        expect(Object.keys(urls)).toEqual(["data/sales.csv", "config.json", "help.html"]);
        expect(assets.map((a) => a.type)).toEqual(["text/csv", "application/json", "text/html"]);
        expect(new TextDecoder().decode(assets[0].bytes)).toBe("a,b\n1,2");
    });

    it("falls back to application/octet-stream for an unknown binary type", () => {
        expect(collectAssets({ "app/x.bin": new Uint8Array([1]) }).assets[0].type).toBe("application/octet-stream");
    });
});

describe("sending a page's assets", () => {
    const page = {
        html: `<img src="${assetToken(0)}"><script>window.appAssets={"a.png":"${assetToken(0)}","b.wav":"${assetToken(1)}"}</script>`,
        assets: [
            { type: "image/png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
            { type: "audio/wav", bytes: new Uint8Array([1, 2, 3]) },
        ],
    };

    it("inlines each token as a data URL for a page that stands alone", () => {
        expect(inlineAssets(page)).toBe(
            '<img src="data:image/png;base64,iVBORw=="><script>window.appAssets={"a.png":"data:image/png;base64,iVBORw==","b.wav":"data:audio/wav;base64,AQID"}</script>',
        );
    });

    it("leaves a token with no asset alone", () => {
        expect(resolveAssetTokens(`x ${assetToken(5)}`, page.assets, () => "u")).toBe(`x ${assetToken(5)}`);
    });

    it("sends a bootloader that takes assets the bytes once, as Blobs", async () => {
        const init = hostInit(page, { type: "agex-host-ready", assets: 1 });
        expect(init.html).toBe(page.html);
        expect(init.assets).toHaveLength(2);
        expect(init.assets?.[1]?.type).toBe("audio/wav");
        expect(new Uint8Array(await /** @type {Blob} */ (init.assets?.[1]).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    });

    it("sends an older bootloader the page with data URLs in", () => {
        const init = hostInit(page, { type: "agex-host-ready" });
        expect(init).toEqual({ type: "agex-host-init", html: inlineAssets(page) });
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
