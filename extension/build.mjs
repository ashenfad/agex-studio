#!/usr/bin/env node
/**
 * Build the extension into `extension/dist/<mode>/`, ready to load
 * unpacked or to zip for the store:
 *
 *     node extension/build.mjs          # the store's: agex.studio only
 *     node extension/build.mjs --dev    # a fixed id, and local dev servers
 *
 * The sources are plain modules, copied as they are (tests left out);
 * only the manifest differs. The dev build carries the public key in
 * `dev-key.pub`, which fixes its id (`DEV_EXTENSION_ID`), and answers
 * `http://localhost` and `http://127.0.0.1` on any port beside
 * agex.studio (`DEV_MATCHES`). A manifest that names a page outside the
 * worker's own list fails the build.
 */

import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { originMatcher, untrusted } from "./src/origins.js";
import { DEV_EXTENSION_ID, DEV_MATCHES, STUDIO_MATCHES } from "./src/protocol.js";

const here = dirname(fileURLToPath(import.meta.url));
const dev = process.argv.includes("--dev");
const out = join(here, "dist", dev ? "dev" : "prod");

const manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
if (dev) {
    const key = readFileSync(join(here, "dev-key.pub"), "utf8").trim();
    if (idOf(key) !== DEV_EXTENSION_ID) throw new Error(`dev-key.pub gives id ${idOf(key)}, not DEV_EXTENSION_ID (${DEV_EXTENSION_ID})`);
    manifest.key = key;
    manifest.name += " (dev)";
    manifest.externally_connectable.matches.push(...DEV_MATCHES);
}
const trusted = dev ? [...STUDIO_MATCHES, ...DEV_MATCHES] : STUDIO_MATCHES;
const extra = untrusted(manifest.externally_connectable.matches, trusted);
if (extra.length > 0) throw new Error(`manifest.json's externally_connectable names ${extra.join(", ")}, which the worker's list (STUDIO_MATCHES in src/protocol.js) doesn't`);
originMatcher(trusted); // every pattern one the worker can read

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const file of readdirSync(join(here, "src"))) {
    if (file.endsWith(".js") && !file.endsWith(".test.js")) cpSync(join(here, "src", file), join(out, file));
}
writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
if (dev) writeFileSync(join(out, "build-info.js"), readFileSync(join(here, "src", "build-info.js"), "utf8").replace("DEV = false", "DEV = true"));
console.log(`built ${out}${dev ? ` (id ${DEV_EXTENSION_ID})` : ""}`);

/** An unpacked extension's id from its manifest key: the first 128 bits
 *  of the key's SHA-256, each hex digit spelled a to p. */
function idOf(key) {
    const hex = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
    return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}
