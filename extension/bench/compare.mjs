#!/usr/bin/env node
/**
 * Read each captured page (`capture.mjs`) both ways, `outline.js`'s and
 * the accessibility tree's (`ax-outline.js`), and say how each did: its
 * size (about a token for four characters), its refs and how many have no
 * name, and the site's checks (`sites.js`) it passed. Both reads are
 * written under `bench/out/` (not committed) to look at.
 *
 *     node extension/bench/compare.mjs                 # every page captured
 *     node extension/bench/compare.mjs --live udisc    # the live page, not its capture
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { outlinePage } from "../src/outline.js";
import { axOutline } from "./ax-outline.js";
import { launch, settle } from "./browser.mjs";
import { SITES } from "./sites.js";

const here = dirname(fileURLToPath(import.meta.url));
const pagesDir = join(here, "pages");
const outDir = join(here, "out");
mkdirSync(outDir, { recursive: true });

const args = process.argv.slice(2);
const live = args.includes("--live");
const wanted = args.filter((a) => !a.startsWith("--"));
const tokens = (/** @type {string} */ s) => Math.round(s.length / 4);

const browser = await launch();
const rows = [];
for (const site of SITES) {
    if (wanted.length > 0 && !wanted.includes(site.name)) continue;
    const capture = join(pagesDir, `${site.name}.mhtml`);
    if (!live && !existsSync(capture)) continue;
    const page = await browser.context.newPage();
    try {
        if (live) {
            await page.goto(browser.resolve(site.url), { waitUntil: "domcontentloaded", timeout: 45_000 });
            await settle(page);
        } else {
            await page.goto(pathToFileURL(capture).href, { waitUntil: "load", timeout: 45_000 });
        }
        let t = performance.now();
        const ours = await page.evaluate(`(${outlinePage})(1, { maxChars: 1e9 })`);
        const oursMs = performance.now() - t;
        t = performance.now();
        const cdp = await browser.context.newCDPSession(page);
        const { nodes } = await cdp.send("Accessibility.getFullAXTree");
        const ax = axOutline(nodes, { maxChars: 1e9 });
        const axMs = performance.now() - t;
        writeFileSync(join(outDir, `${site.name}.ours.txt`), ours.text);
        writeFileSync(join(outDir, `${site.name}.ax.txt`), ax.text);
        const score = (/** @type {string} */ text) => site.checks.map((c) => ({ name: c.name, ok: c.match.test(text) }));
        rows.push({
            site: site.name, group: site.group,
            ours: { tokens: tokens(ours.text), refs: ours.refs.length, unnamed: ours.refs.filter((/** @type {any} */ r) => !r.name.trim()).length, ms: Math.round(oursMs), checks: score(ours.text) },
            ax: { tokens: tokens(ax.text), refs: ax.refs.length, unnamed: ax.refs.filter((r) => !r.name.trim()).length, ms: Math.round(axMs), checks: score(ax.text) },
        });
    } catch (e) {
        rows.push({ site: site.name, group: site.group, error: String(e).slice(0, 200) });
    }
    await page.close();
}
await browser.close();
writeFileSync(join(outDir, "results.json"), `${JSON.stringify(rows, null, 2)}\n`);

const passed = (/** @type {{ ok: boolean }[]} */ cs) => `${cs.filter((c) => c.ok).length}/${cs.length}`;
const failed = (/** @type {{ name: string, ok: boolean }[]} */ cs) => cs.filter((c) => !c.ok).map((c) => c.name).join("; ");
console.log("site         group         ours: tokens refs unnamed checks | ax: tokens refs unnamed checks");
for (const r of rows) {
    if ("error" in r) {
        console.log(`${r.site.padEnd(12)} ${r.group.padEnd(13)} failed: ${r.error}`);
        continue;
    }
    const col = (/** @type {any} */ o) => `${String(o.tokens).padStart(6)} ${String(o.refs).padStart(4)} ${String(o.unnamed).padStart(4)} ${passed(o.checks).padStart(5)}`;
    console.log(`${r.site.padEnd(12)} ${r.group.padEnd(13)} ${col(r.ours)} | ${col(r.ax)}`);
    const misses = [failed(r.ours.checks) && `ours missed: ${failed(r.ours.checks)}`, failed(r.ax.checks) && `ax missed: ${failed(r.ax.checks)}`].filter(Boolean);
    if (misses.length > 0) console.log(`${" ".repeat(27)}${misses.join(" · ")}`);
}
const total = (/** @type {"ours" | "ax"} */ k) => rows.filter((r) => !("error" in r)).reduce((n, r) => n + /** @type {any} */ (r)[k].checks.filter((/** @type {any} */ c) => c.ok).length, 0);
const all = rows.filter((r) => !("error" in r)).reduce((n, r) => n + /** @type {any} */ (r).ours.checks.length, 0);
console.log(`checks passed: ours ${total("ours")}/${all}, ax ${total("ax")}/${all}`);
