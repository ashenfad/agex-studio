/**
 * App asset plumbing: turns the files under `app/` that aren't the
 * app's code (images, fonts, audio, data files) into something the
 * iframe preview can actually use.
 *
 * The iframe's page is written by a bootloader at the apps origin, so
 * it has no meaningful base path: `<img src="logo.png">` and
 * `fetch("logo.png")` from agent app code both fail by default. This
 * module does four things:
 *
 *   1. Collects the assets, each once, as bytes with a MIME type, and
 *      stands a token (`agex-asset:<n>:`) for each one's URL.
 *   2. Rewrites known HTML/CSS asset references to the tokens (handles
 *      the static cases: most real apps).
 *   3. Builds an injected script that exposes
 *      `window.appAssets = { 'logo.png': <url>, ... }` plus a `fetch`
 *      monkey-patch so dynamic JS `fetch("logo.png")` calls also
 *      resolve.
 *   4. Turns the tokens into URLs when the page is sent: a bootloader
 *      that says it takes assets gets them as Blobs beside the HTML and
 *      mints a `blob:` URL for each in the frame, so each asset crosses
 *      once, as bytes; an older one gets `data:` URLs written in.
 *
 * What's NOT covered: imperatively-set `<img>.src = "x.png"` after
 * page load (browsers route those through the image loader, not
 * `fetch`): `window.appAssets` gives the URL to set.
 */

import { bytesToBase64 } from "./bytes.js";

/** Extensions we treat as binary app assets — strict allowlist so a
 *  rogue/unknown file extension doesn't get base64-bloated for no
 *  reason. Add new types here as they come up. */
export const BINARY_EXTS = [
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".bmp",
    ".ico",
    ".svg",
    ".avif",
    ".woff",
    ".woff2",
    ".ttf",
    ".otf",
    ".eot",
    ".mp3",
    ".mp4",
    ".webm",
    ".ogg",
    ".wav",
    ".pdf",
];

/** MIME types for the extensions we encode. SVG-as-binary is
 *  deliberate — we treat it as an opaque asset rather than re-
 *  parsing it. Anything not in the map falls back to
 *  `application/octet-stream`, which still renders for `<img>`
 *  but is a hint that we should add a proper mapping. */
const MIME_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".ico": "image/x-icon",
    ".svg": "image/svg+xml",
    ".avif": "image/avif",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".eot": "application/vnd.ms-fontobject",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".ogg": "audio/ogg",
    ".wav": "audio/wav",
    ".pdf": "application/pdf",
};

/** Lowercase extension of `path` (including the dot), or `''` if
 *  none. Same shape `path.extname` would produce, no Node dep. */
function extOf(path) {
    const slashIdx = path.lastIndexOf("/");
    const dotIdx = path.lastIndexOf(".");
    if (dotIdx <= slashIdx) return "";
    return path.slice(dotIdx).toLowerCase();
}

/**
 * Should this app/ file be collected as a binary asset rather than
 * decoded to text? Driven by the extension allowlist above.
 * @param {string} path
 * @returns {boolean}
 */
export function isBinaryAppFile(path) {
    return BINARY_EXTS.includes(extOf(path));
}

/** The MIME types of the app's data files: text files under `app/`
 *  that aren't its page, scripts or styles. */
const DATA_TYPES = {
    ".json": "application/json",
    ".geojson": "application/geo+json",
    ".csv": "text/csv",
    ".tsv": "text/tab-separated-values",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".html": "text/html",
    ".xml": "application/xml",
    ".vtt": "text/vtt",
    ".srt": "text/plain",
};

/** The token a built page holds for asset `n`'s URL, until it's sent.
 *  @param {number} n */
export const assetToken = (n) => `agex-asset:${n}:`;
const TOKEN_RE = /agex-asset:(\d+):/g;

/** @typedef {{ type: string, bytes: Uint8Array }} AppAsset */

/**
 * The app's assets, each once: its binaries, and its data files (text
 * files other than the page, scripts and styles). `urls` maps each
 * reference path (no `app/` prefix: `logo.png`, as agents write them)
 * to its token; `assets[n]` is what token `n` stands for.
 *
 * @param {Record<string, Uint8Array>} appBinaries
 * @param {Record<string, string>} [appFiles]
 * @returns {{ urls: Record<string, string>, assets: AppAsset[] }}
 */
export function collectAssets(appBinaries, appFiles = {}) {
    /** @type {Record<string, string>} */
    const urls = {};
    /** @type {AppAsset[]} */
    const assets = [];
    const add = (/** @type {string} */ path, /** @type {string} */ type, /** @type {Uint8Array} */ bytes) => {
        urls[path.replace(/^app\//, "")] = assetToken(assets.length);
        assets.push({ type, bytes });
    };
    for (const [path, bytes] of Object.entries(appBinaries)) {
        add(path, MIME_TYPES[extOf(path)] ?? "application/octet-stream", bytes);
    }
    const encoder = new TextEncoder();
    for (const [path, text] of Object.entries(appFiles)) {
        const type = DATA_TYPES[extOf(path)];
        if (type === undefined || /^(app\/)?index\.html$/.test(path)) continue;
        add(path, type, encoder.encode(text));
    }
    return { urls, assets };
}

/**
 * `html` with each asset token swapped for `url(asset, n)`.
 *
 * @param {string} html @param {readonly AppAsset[]} assets
 * @param {(asset: AppAsset, n: number) => string} url
 */
export function resolveAssetTokens(html, assets, url) {
    if (assets.length === 0) return html;
    /** @type {Map<number, string>} */
    const made = new Map();
    return html.replace(TOKEN_RE, (match, n) => {
        const i = Number(n);
        const asset = assets[i];
        if (asset === undefined) return match;
        if (!made.has(i)) made.set(i, url(asset, i));
        return /** @type {string} */ (made.get(i));
    });
}

/** `html` with its asset tokens as `data:` URLs: a page that stands on
 *  its own. @param {{ html: string, assets: readonly AppAsset[] }} page */
export function inlineAssets(page) {
    return resolveAssetTokens(page.html, page.assets, (a) => `data:${a.type};base64,${bytesToBase64(a.bytes)}`);
}

/**
 * The `agex-host-init` message that sends `page` to the bootloader whose
 * `agex-host-ready` was `ready`. One that takes assets (`assets: 1`)
 * gets them as Blobs, its page's tokens left for it to resolve; an
 * older one gets the page with `data:` URLs in.
 *
 * @param {{ html: string, assets: readonly AppAsset[] }} page
 * @param {unknown} ready
 */
export function hostInit(page, ready) {
    const takesAssets = /** @type {any} */ (ready)?.assets === 1;
    if (!takesAssets || page.assets.length === 0) {
        return { type: "agex-host-init", html: inlineAssets(page) };
    }
    return {
        type: "agex-host-init",
        html: page.html,
        assets: page.assets.map((a) => new Blob([/** @type {BlobPart} */ (a.bytes)], { type: a.type })),
    };
}

/** Escape a string for use as a literal in a RegExp. */
function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rewrite `src=` / `href=` / `poster=` attributes that reference
 * an app asset by its relative path. Handles both quoted and
 * unquoted attribute values, with or without a leading `./`.
 *
 * Examples that match against asset `logo.png`:
 *   <img src="logo.png">
 *   <img src='./logo.png'>
 *   <link rel="icon" href="logo.png">
 *   <source src="./logo.png">
 *   <video poster="logo.png" src="...">
 *
 * Doesn't touch absolute URLs (`https://...`, `data:...`, `blob:...`)
 * or paths that don't match a known asset.
 *
 * @param {string} html
 * @param {Record<string, string>} assetUrls relative-path → URL (or token)
 * @returns {string}
 */
export function rewriteHtmlAssetRefs(html, assetUrls) {
    if (!html || Object.keys(assetUrls).length === 0) return html;
    let out = html;
    // For each known asset, replace any `attr="<asset>"` /
    // `attr='<asset>'` / `attr="./<asset>"` match in the document.
    // Limiting to the attribute set we care about (src/href/poster)
    // avoids matching `<a href="logo.png">`-style refs where we
    // genuinely want the navigation behavior — though in our
    // sandbox-iframe context that's probably fine too. Keep it
    // tight for now.
    const attrs = "(?:src|href|poster|data)";
    for (const [rel, url] of Object.entries(assetUrls)) {
        const pattern = new RegExp(
            `(\\b${attrs}\\s*=\\s*["'])(?:\\./)?${escapeRegex(rel)}(["'])`,
            "g",
        );
        out = out.replace(pattern, (_m, open, close) => open + url + close);
    }
    return out;
}

/**
 * Rewrite CSS `url(...)` references to app assets. Handles all
 * three CSS url forms: `url(foo.png)`, `url("foo.png")`,
 * `url('foo.png')`, with optional leading `./`.
 *
 * @param {string} css
 * @param {Record<string, string>} assetUrls
 * @returns {string}
 */
export function rewriteCssAssetRefs(css, assetUrls) {
    if (!css || Object.keys(assetUrls).length === 0) return css;
    let out = css;
    for (const [rel, url] of Object.entries(assetUrls)) {
        const pattern = new RegExp(
            `url\\(\\s*(["']?)(?:\\./)?${escapeRegex(rel)}\\1\\s*\\)`,
            "g",
        );
        out = out.replace(pattern, () => `url("${url}")`);
    }
    return out;
}

/**
 * Build a `<script>` tag exposing the asset map as
 * `window.appAssets` plus a `fetch` monkey-patch so
 * `fetch("logo.png")` from agent JS resolves to the asset's URL.
 *
 * The monkey-patch only intercepts relative-path strings that
 * look like asset filenames; absolute URLs (`https://...`,
 * `data:...`, `blob:...`) and paths under known prefixes
 * (`/api/`, etc.) pass through unchanged.
 *
 * Empty map → empty string (no script injected).
 *
 * @param {Record<string, string>} assetUrls
 * @returns {string}
 */
export function buildAssetsScript(assetUrls) {
    const count = Object.keys(assetUrls).length;
    if (count === 0) return "";
    // Stringify the asset map into the script: tokens, blob: and data:
    // URLs are all JSON-safe; `JSON.stringify` handles the paths.
    const json = JSON.stringify(assetUrls);
    return `<script>(function(){
  window.appAssets = ${json};
  const origFetch = window.fetch.bind(window);
  window.fetch = function(input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url);
      if (typeof url === 'string') {
        // Strip a single leading ./ or / so 'logo.png',
        // './logo.png', and '/logo.png' all hit the same key.
        const key = url.replace(/^\\.\\//, '').replace(/^\\//, '');
        if (Object.prototype.hasOwnProperty.call(window.appAssets, key)) {
          return origFetch(window.appAssets[key], init);
        }
      }
    } catch (_) { /* fall through to native fetch on any sniff error */ }
    return origFetch(input, init);
  };
})();<\/script>`;
}
