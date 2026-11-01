#!/usr/bin/env node
/**
 * Build the site-filter extension into `extensions/filters/dist/<mode>/`,
 * ready to load unpacked:
 *
 *     node extensions/filters/build.mjs          # the store's
 *     node extensions/filters/build.mjs --site   # the studio's download: a fixed id
 *     node extensions/filters/build.mjs --dev    # a fixed id, for local work and the tests
 *
 * Its scripts are bundled (esbuild, as Vite has it): the extension runs
 * agex-ts, so unlike the browsing extension's plain modules they import
 * packages. The site and dev builds carry a public key each
 * (`site-key.pub`, `dev-key.pub`), which fixes an unpacked copy's id
 * (`src/ids.js`); no private key is needed for either, nor kept.
 */

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { idOf } from "../../extension/build.mjs";
import { DEV_FILTERS_ID, SITE_FILTERS_ID } from "./src/ids.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");

/** What each build adds to the manifest: its key's file and the id that
 *  key must give, and its name's suffix. @type {Record<string, { key: string, id: string, suffix: string } | null>} */
const MODES = {
    prod: null,
    site: { key: "site-key.pub", id: SITE_FILTERS_ID, suffix: "" },
    dev: { key: "dev-key.pub", id: DEV_FILTERS_ID, suffix: " (dev)" },
};

/** The scripts bundled, each from `src/` to the build's top level. */
const ENTRIES = ["background.js"];

/**
 * Build `mode` into `extensions/filters/dist/<mode>/`: the directory built.
 *
 * @param {"prod" | "site" | "dev"} mode
 * @returns {Promise<string>}
 */
export async function build(mode) {
    const out = join(here, "dist", mode);
    const manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
    const fixed = MODES[mode];
    if (fixed) {
        const key = readFileSync(join(here, fixed.key), "utf8").trim();
        if (idOf(key) !== fixed.id) throw new Error(`${fixed.key} gives id ${idOf(key)}, not ${fixed.id}`);
        manifest.key = key;
        manifest.name += fixed.suffix;
    }
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    await esbuild().build({
        entryPoints: ENTRIES.map((e) => join(here, "src", e)),
        outdir: out,
        bundle: true,
        format: "esm",
        platform: "browser",
        target: "chrome120",
        absWorkingDir: root,
        logLevel: "warning",
    });
    // the studio's braces, as the browsing extension draws them
    cpSync(join(root, "extension", "icons"), join(out, "icons"), { recursive: true });
    writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return out;
}

/** esbuild, as the studio's Vite brings it: the one version the repo has. */
function esbuild() {
    return createRequire(createRequire(join(root, "package.json")).resolve("vite"))("esbuild");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const mode = process.argv.includes("--dev") ? "dev" : process.argv.includes("--site") ? "site" : "prod";
    const out = await build(mode);
    console.log(`built ${out}${MODES[mode] ? ` (id ${MODES[mode].id})` : ""}`);
}
