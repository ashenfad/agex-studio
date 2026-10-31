#!/usr/bin/env node
/**
 * Draw the extension's icons, `extension/icons/<size>.png`, from the
 * studio's favicon (`public/favicon.svg`): Chrome takes PNGs only.
 * Run it again when the favicon changes; the PNGs are committed, so
 * the build needs no browser.
 *
 *     node extension/icons.mjs
 *
 * The 16 and 32 px icons (the toolbar's) fill their square as the
 * favicon does; the 48 and 128 px ones (`chrome://extensions`, the
 * store) keep Chrome's margin, the art in the middle three quarters.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const svg = readFileSync(join(here, "..", "public", "favicon.svg"), "utf8");
/** Each size, and the share of it the art takes. */
const SIZES = { 16: 1, 32: 1, 48: 0.75, 128: 0.75 };

mkdirSync(join(here, "icons"), { recursive: true });
const browser = await chromium.launch();
try {
    const page = await browser.newPage();
    for (const [size, share] of Object.entries(SIZES)) {
        const px = Number(size);
        const art = Math.round(px * share);
        await page.setViewportSize({ width: px, height: px });
        await page.setContent(
            `<style>html,body{margin:0;background:transparent}svg{display:block;width:${art}px;height:${art}px;margin:${(px - art) / 2}px}</style>${svg}`,
        );
        await page.screenshot({ path: join(here, "icons", `${size}.png`), omitBackground: true });
    }
} finally {
    await browser.close();
}
console.log(`drew ${Object.keys(SIZES).join(", ")} px icons into ${join(here, "icons")}`);
