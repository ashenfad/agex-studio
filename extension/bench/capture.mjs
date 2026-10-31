#!/usr/bin/env node
/**
 * Capture the bench's pages (`sites.js`) as they render now, each as one
 * MHTML file under `bench/pages/` (not committed: sites' own pages), so
 * the compare reads the same page each time, whatever the site does next.
 *
 *     node extension/bench/capture.mjs              # every site
 *     node extension/bench/capture.mjs udisc ihg    # some
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, settle } from "./browser.mjs";
import { SITES } from "./sites.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "pages");
mkdirSync(out, { recursive: true });
const indexFile = join(out, "index.json");
/** @type {Record<string, { url: string, landed: string, title: string, at: string, bytes?: number, error?: string }>} */
const index = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, "utf8")) : {};

const wanted = process.argv.slice(2);
const browser = await launch();
for (const site of SITES) {
    if (wanted.length > 0 && !wanted.includes(site.name)) continue;
    const page = await browser.context.newPage();
    try {
        await page.goto(browser.resolve(site.url), { waitUntil: "domcontentloaded", timeout: 45_000 });
        await settle(page);
        const cdp = await browser.context.newCDPSession(page);
        const { data } = await cdp.send("Page.captureSnapshot", { format: "mhtml" });
        writeFileSync(join(out, `${site.name}.mhtml`), data);
        index[site.name] = { url: site.url, landed: page.url(), title: await page.title(), at: new Date().toISOString(), bytes: data.length };
        console.log(`${site.name.padEnd(12)} ${Math.round(data.length / 1024)} KB  ${await page.title()}`);
    } catch (e) {
        index[site.name] = { url: site.url, landed: page.url(), title: "", at: new Date().toISOString(), error: String(e).slice(0, 300) };
        console.log(`${site.name.padEnd(12)} failed: ${String(e).slice(0, 120)}`);
    }
    await page.close();
}
writeFileSync(indexFile, `${JSON.stringify(index, null, 2)}\n`);
await browser.close();
