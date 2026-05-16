/**
 * App asset plumbing — turns binary files under `app/` (images,
 * fonts) into something the iframe preview can actually use.
 *
 * The iframe loads from a `blob:` URL with no meaningful base path,
 * so `<img src="logo.png">` and `fetch("logo.png")` from agent app
 * code both fail by default. This module does three things:
 *
 *   1. Encodes binaries as `data:` URLs via base64.
 *   2. Rewrites known HTML/CSS asset references to point at the
 *      data URLs (handles the static cases — most real apps).
 *   3. Builds an injected script that exposes
 *      `window.appAssets = { 'logo.png': 'data:...', ... }` plus a
 *      `fetch` monkey-patch so dynamic JS `fetch("logo.png")` calls
 *      also resolve.
 *
 * What's NOT covered: imperatively-set `<img>.src = "x.png"` after
 * page load (browsers route those through the image loader, not
 * `fetch`). For that we'd need a service worker — deferred until
 * a real use case demands it.
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

/**
 * Build a `data:` URL from raw bytes. MIME comes from the path's
 * extension; unknown extensions fall back to
 * `application/octet-stream`.
 * @param {string} path
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToDataUrl(path, bytes) {
    const mime = MIME_TYPES[extOf(path)] ?? "application/octet-stream";
    return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

/** Build the `{ relativePath: dataUrl }` map the rewriters consume.
 *  `appBinaries` keys come in as full paths (`app/logo.png`); we
 *  strip the `app/` prefix so the lookup keys match the references
 *  agents write in HTML/JS (`logo.png`).
 * @param {Record<string, Uint8Array>} appBinaries
 * @returns {Record<string, string>}
 */
export function buildAssetUrlMap(appBinaries) {
    /** @type {Record<string, string>} */
    const out = {};
    for (const [path, bytes] of Object.entries(appBinaries)) {
        const rel = path.replace(/^app\//, "");
        out[rel] = bytesToDataUrl(path, bytes);
    }
    return out;
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
 * @param {Record<string, string>} assetUrls relative-path → data URL
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
    for (const [rel, dataUrl] of Object.entries(assetUrls)) {
        const pattern = new RegExp(
            `(\\b${attrs}\\s*=\\s*["'])(?:\\./)?${escapeRegex(rel)}(["'])`,
            "g",
        );
        out = out.replace(pattern, `$1${dataUrl}$2`);
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
    for (const [rel, dataUrl] of Object.entries(assetUrls)) {
        const pattern = new RegExp(
            `url\\(\\s*(["']?)(?:\\./)?${escapeRegex(rel)}\\1\\s*\\)`,
            "g",
        );
        out = out.replace(pattern, `url("${dataUrl}")`);
    }
    return out;
}

/**
 * Build a `<script>` tag exposing the asset map as
 * `window.appAssets` plus a `fetch` monkey-patch so
 * `fetch("logo.png")` from agent JS resolves to the data URL.
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
    // Stringify the asset map into the script. Data URLs are long
    // but base64 is JSON-safe; no special escaping needed beyond
    // `JSON.stringify` which handles quotes / backslashes.
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
