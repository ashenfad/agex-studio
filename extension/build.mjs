#!/usr/bin/env node
/**
 * Build the extension into `extension/dist/<mode>/`, ready to load
 * unpacked or to zip for the store:
 *
 *     node extension/build.mjs          # the store's: agex.studio only
 *     node extension/build.mjs --site   # the studio's download: a fixed id, agex.studio only
 *     node extension/build.mjs --dev    # a fixed id, and local dev servers
 *
 * The sources are plain modules and pages, copied as they are (tests left out);
 * only the manifest differs. The site and dev builds each carry a public
 * key (`site-key.pub`, `dev-key.pub`), which fixes the id an unpacked
 * copy has (`SITE_EXTENSION_ID`, `DEV_EXTENSION_ID`); no private key is
 * needed for either, nor kept. The dev build also answers
 * `http://localhost` and `http://127.0.0.1` on any port beside
 * agex.studio (`DEV_MATCHES`), and has the dev-only ops. A manifest that
 * names a page outside the worker's own list fails the build.
 *
 * The studio's own build zips the site build into its download
 * (`zip`, from `vite.config.js`).
 */

import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";
import { originMatcher, untrusted } from "./src/origins.js";
import { DEV_EXTENSION_ID, DEV_MATCHES, SITE_EXTENSION_ID, STUDIO_MATCHES } from "./src/protocol.js";

const here = dirname(fileURLToPath(import.meta.url));

/** What each build adds to the manifest: its key's file and the id that
 *  key must give, and its name's suffix. @type {Record<string, { key: string, id: string, suffix: string } | null>} */
const MODES = {
    prod: null,
    site: { key: "site-key.pub", id: SITE_EXTENSION_ID, suffix: "" },
    dev: { key: "dev-key.pub", id: DEV_EXTENSION_ID, suffix: " (dev)" },
};

/**
 * Build `mode` into `extension/dist/<mode>/`: the directory built.
 *
 * @param {"prod" | "site" | "dev"} mode
 * @returns {string}
 */
export function build(mode) {
    const dev = mode === "dev";
    const out = join(here, "dist", mode);
    const manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
    const fixed = MODES[mode];
    if (fixed) {
        const key = readFileSync(join(here, fixed.key), "utf8").trim();
        if (idOf(key) !== fixed.id) throw new Error(`${fixed.key} gives id ${idOf(key)}, not ${fixed.id}`);
        manifest.key = key;
        manifest.name += fixed.suffix;
    }
    if (dev) manifest.externally_connectable.matches.push(...DEV_MATCHES);
    const trusted = dev ? [...STUDIO_MATCHES, ...DEV_MATCHES] : STUDIO_MATCHES;
    const extra = untrusted(manifest.externally_connectable.matches, trusted);
    if (extra.length > 0) throw new Error(`manifest.json's externally_connectable names ${extra.join(", ")}, which the worker's list (STUDIO_MATCHES in src/protocol.js) doesn't`);
    originMatcher(trusted); // every pattern one the worker can read

    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    for (const file of readdirSync(join(here, "src"))) {
        if ((file.endsWith(".js") && !file.endsWith(".test.js")) || file.endsWith(".html")) cpSync(join(here, "src", file), join(out, file));
    }
    writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    if (dev) writeFileSync(join(out, "build-info.js"), readFileSync(join(here, "src", "build-info.js"), "utf8").replace("DEV = false", "DEV = true"));
    return out;
}

/**
 * The files under `dir` as a zip, each under a folder named `folder`, so
 * that unzipping it gives the one folder to load unpacked. The same
 * files make the same bytes: every entry has the zip format's earliest
 * date.
 *
 * @param {string} dir @param {string} folder
 * @returns {Buffer}
 */
export function zip(dir, folder) {
    /** @type {Buffer[]} */
    const local = [];
    /** @type {Buffer[]} */
    const central = [];
    let offset = 0;
    for (const path of files(dir)) {
        const name = Buffer.from(`${folder}/${relative(dir, path).split("\\").join("/")}`);
        const data = readFileSync(path);
        const packed = deflateRawSync(data);
        // version 2.0, UTF-8 names, deflated, 1980-01-01 00:00, then crc and sizes
        const common = [[20, 2], [0x0800, 2], [8, 2], [0, 2], [33, 2], [crc32(data), 4], [packed.length, 4], [data.length, 4], [name.length, 2], [0, 2]];
        const head = fields([[0x04034b50, 4], ...common]);
        local.push(head, name, packed);
        central.push(fields([[0x02014b50, 4], [20, 2], ...common, [0, 2], [0, 2], [0, 2], [0, 4], [offset, 4]]), name);
        offset += head.length + name.length + packed.length;
    }
    const size = central.reduce((n, b) => n + b.length, 0);
    const count = central.length / 2;
    const end = fields([[0x06054b50, 4], [0, 2], [0, 2], [count, 2], [count, 2], [size, 4], [offset, 4], [0, 2]]);
    return Buffer.concat([...local, ...central, end]);
}

/** Little-endian fields, each `[value, bytes]`. @param {[number, number][]} list */
function fields(list) {
    const b = Buffer.alloc(list.reduce((n, [, size]) => n + size, 0));
    let at = 0;
    for (const [value, size] of list) at = size === 2 ? b.writeUInt16LE(value, at) : b.writeUInt32LE(value >>> 0, at);
    return b;
}

/** Every file under `dir`, sorted. @param {string} dir @returns {string[]} */
function files(dir) {
    return readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => (a.name < b.name ? -1 : 1))
        .flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
}

/** An unpacked extension's id from its manifest key: the first 128 bits
 *  of the key's SHA-256, each hex digit spelled a to p. @param {string} key */
function idOf(key) {
    const hex = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
    return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const mode = process.argv.includes("--dev") ? "dev" : process.argv.includes("--site") ? "site" : "prod";
    const out = build(mode);
    console.log(`built ${out}${MODES[mode] ? ` (id ${MODES[mode].id})` : ""}`);
}
