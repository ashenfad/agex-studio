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
 * packages. Its own page (`src/app/`) is built with Vite and Svelte, as
 * the studio is, since it reuses the studio's model settings. The site and dev builds carry a public key each
 * (`site-key.pub`, `dev-key.pub`), which fixes an unpacked copy's id
 * (`src/ids.js`); no private key is needed for either, nor kept.
 */

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { build as vite } from "vite";
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
const ENTRIES = ["background.js", "offscreen.js", "sandbox.js", "popup.js"];
/** The pages, copied as they are. */
const PAGES = ["offscreen.html", "sandbox.html", "popup.html"];
/** The sandbox's CSP: eval, for the agent's kernel; workers from blobs
 *  (the kernel's); nothing from elsewhere, and no connections at all, so
 *  neither the sandbox nor the agent's code can send anything anywhere. */
export const SANDBOX_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-eval' blob:; worker-src blob:; connect-src 'none'";

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
    // the tests' sites (`test/harness.mjs` sends them to this machine), reachable with no click
    if (mode === "dev") manifest.host_permissions = ["*://*.filters.test/*"];
    manifest.content_security_policy = { sandbox: SANDBOX_CSP };
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    const common = {
        bundle: true,
        platform: /** @type {const} */ ("browser"),
        target: "chrome120",
        absWorkingDir: root,
        logLevel: /** @type {const} */ ("warning"),
        minify: mode !== "dev",
        define: { __DEV__: JSON.stringify(mode === "dev") },
        // the world's Node-only paths, never taken in a browser
        external: ["node:*", "worker_threads"],
    };
    await esbuild().build({ ...common, entryPoints: ENTRIES.map((e) => join(here, "src", e)), outdir: out, format: "esm" });
    // the kernel's worker, whole, as a classic script (`src/host/worker.js`)
    const kernel = join(out, "kernel-worker.js");
    await esbuild().build({ ...common, entryPoints: [join(root, "node_modules", "@agex-ts", "world", "dist", "worker.js")], outfile: kernel, format: "iife" });
    const needsModule = moduleSyntax(readFileSync(kernel, "utf8"));
    if (needsModule) throw new Error(`the kernel's worker uses ${needsModule}, so it can't run as a classic worker in the sandbox`);
    for (const page of PAGES) cpSync(join(here, "src", page), join(out, page));
    await vite({
        configFile: false,
        root: join(here, "src", "app"),
        base: "./",
        // zod's comments make Rollup warn on every build; errors still show
        logLevel: "error",
        plugins: [svelte({ configFile: join(root, "svelte.config.js") })],
        define: common.define,
        build: { outDir: join(out, "app"), emptyOutDir: true, minify: common.minify, rollupOptions: { input: join(here, "src", "app", "app.html") } },
    });
    // the studio's braces, as the browsing extension draws them
    cpSync(join(root, "extension", "icons"), join(out, "icons"), { recursive: true });
    writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return out;
}

/** What in `source` only a module may hold (`import.meta`, a static
 *  `import` or `export`), or null. @param {string} source */
function moduleSyntax(source) {
    if (source.includes("import.meta")) return "import.meta";
    if (/^\s*(import\s*[\w{*"']|export\s)/m.test(source)) return "a static import or export";
    return null;
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
