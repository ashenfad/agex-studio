/*
 * pxl in a session: what its `pxl build` and `pxl ascii` do, for code.
 * pxl's engine is platform-independent; its CLI needs Node, so this runs
 * art files here, writes PNGs with OffscreenCanvas and GIFs with pxl's
 * own encoder, all pinned to one pxl commit.
 *
 *   import { build, ascii, list } from '/workspace/skills/pixel-art/references/pxl.js'
 *   await build(fs, 'art/art.px.js', { only: ['slime'] })   // → { lines, errors }
 *   console.log(await ascii(fs, 'art/art.px.js', 'slime'))
 *
 * build writes beside the art file, in `out/` (or `out`): sprites/,
 * scenes/, anims/ (a strip, its JSON and a GIF), sheets with their JSON,
 * and _preview/<name>.png upscaled with a pixel grid. An anim's preview
 * shows at most `previewFrames` (8) of its frames, evenly spaced; its
 * _preview GIF has them all. Each asset fails on its own: its error is in
 * `errors`, as `file:line:col: asset > op: what`, and the rest build.
 *
 * Import it statically, as above: a dynamic import() of a session path
 * doesn't resolve.
 */

import { Project, PxError, ascii as keys, didYouMean, normalImage, packSheet, preview, previewScale, sheetJson, wrap } from "https://esm.sh/gh/crsolver/claude-pxl@21fee41/src/core/index.ts";
import { encodeGif } from "https://esm.sh/gh/crsolver/claude-pxl@21fee41/src/node/gif.ts";

const dirOf = (path) => path.replace(/\/?[^/]*$/, "") || ".";
const join = (dir, path) => (path.startsWith("/") ? path : `${dir}/${path}`).replace(/\/\.\//g, "/");

/** Asked for by an include() not read yet: read it, then load again. */
class Unread {
    constructor(path) {
        this.path = path;
    }
}

/**
 * Run an art file and the files it includes with the DSL in scope, at
 * their own line numbers (errors point into them). Returns pxl's Project.
 */
export async function load(fs, file) {
    const sources = new Map();
    for (let tries = 0; ; tries++) {
        try {
            return run(file, sources);
        } catch (e) {
            if (!(e instanceof Unread) || tries > 50) throw e;
            try {
                sources.set(e.path, await fs.read(e.path, "utf8"));
            } catch {
                throw new PxError(`cannot read art file '${e.path}'`);
            }
        }
    }
}

function run(file, sources) {
    const p = new Project();
    const stack = [];
    const exec = (path) => {
        if (stack.includes(path)) throw new PxError(`include cycle: ${[...stack, path].join(" -> ")}`);
        if (!sources.has(path)) throw new Unread(path);
        p.addFile(path);
        stack.push(path);
        try {
            // `with` keeps the file's line numbers; the block keeps its
            // consts to this run
            (0, eval)(`with (globalThis.__pxl) {${sources.get(path)}\n}\n//# sourceURL=${path}`);
        } catch (e) {
            if (e instanceof Unread) throw e;
            const unknown = e instanceof ReferenceError && /^(\S+) is not defined/.exec(e.message);
            if (unknown) e.message += didYouMean(unknown[1], Object.keys(globalThis.__pxl));
            throw wrap(e, (s) => p.locFromStack(s));
        } finally {
            stack.pop();
        }
    };
    p.includeHook = (path) => exec(join(dirOf(stack[stack.length - 1]), path));
    globalThis.__pxl = p.env();
    try {
        exec(file);
    } finally {
        delete globalThis.__pxl;
    }
    return p;
}

/** pxl's Img (0xRRGGBBAA pixels) as PNG bytes. */
export async function png(img) {
    const canvas = new OffscreenCanvas(img.w, img.h);
    const g = canvas.getContext("2d");
    const pixels = g.createImageData(img.w, img.h);
    img.data.forEach((v, i) => {
        pixels.data[i * 4] = v >>> 24;
        pixels.data[i * 4 + 1] = (v >>> 16) & 255;
        pixels.data[i * 4 + 2] = (v >>> 8) & 255;
        pixels.data[i * 4 + 3] = v & 255;
    });
    g.putImageData(pixels, 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return new Uint8Array(await blob.arrayBuffer());
}

/** Frames as GIF bytes. */
export function gif(frames) {
    return new Uint8Array(encodeGif(frames));
}

/** Evenly spaced, at most `n`. */
const sample = (items, n) =>
    items.length <= n ? items : Array.from({ length: n }, (_, i) => items[Math.round((i * (items.length - 1)) / (n - 1))]);

/**
 * Build an art file's exported assets and sheets (or `only` these) into
 * `out` (default: `out/` beside the file). Returns a line per output and
 * the errors, one per asset that failed.
 */
export async function build(fs, file, { out = join(dirOf(file), "out"), only, scale, preview: previews = true, previewFrames = 8 } = {}) {
    const lines = [];
    const errors = [];
    const put = async (path, bytes) => {
        await fs.mkdir(dirOf(path), { parents: true, existOk: true });
        await fs.writeFile(path, bytes);
    };
    let p;
    try {
        p = await load(fs, file);
    } catch (e) {
        return { lines, errors: [wrap(e).message] };
    }
    const sheetNames = new Set(p.sheets.map((s) => s.name));
    for (const n of only ?? [])
        if (!p.assets.has(n) && !sheetNames.has(n)) errors.push(`unknown asset or sheet '${n}'${didYouMean(n, [...p.order, ...sheetNames])}`);
    const want = only && new Set(only);
    const pv = (img) => scale ?? Math.max(1, Math.min(previewScale(img), Math.floor(2048 / img.w)));

    for (const n of want ? p.order.filter((x) => want.has(x)) : p.exported()) {
        const def = p.assets.get(n);
        try {
            const b = p.build(n);
            const dir = `${out}/${def.kind}s`;
            const frames = b.anim ? p.frames(n) : [];
            let shown = b.img;
            let info = "";
            if (def.kind === "anim") {
                const { sheet, frames: placed } = packSheet(frames.map((f, i) => ({ name: `${n}_${i}`, img: f.img, ms: f.ms })), frames.length);
                await put(`${dir}/${n}.png`, await png(sheet));
                await put(`${dir}/${n}.json`, sheetJson(`${n}.png`, sheet, placed, [{ name: n, from: 0, to: placed.length - 1 }]));
                shown = packSheet(sample(frames, previewFrames).map((f) => ({ name: "", img: f.img })), undefined, 1).sheet;
            } else {
                await put(`${dir}/${n}.png`, await png(b.img));
                if (b.img.norm) await put(`${dir}/${n}_n.png`, await png(normalImage(b.img)));
            }
            if (frames.length) {
                await put(`${dir}/${n}.gif`, gif(frames));
                info = ` (${frames.length} frames, ${b.anim.loop}ms)`;
            }
            if (def.opts.layers) for (const l of b.layers) await put(`${dir}/${n}/${l.name}.png`, await png(l.img));
            let at = "";
            if (previews) {
                const s = pv(shown);
                await put(`${out}/_preview/${n}.png`, await png(preview(shown, s)));
                if (frames.length) {
                    const gs = Math.max(1, Math.min(previewScale(b.img), Math.floor(512 / b.img.w)));
                    await put(`${out}/_preview/${n}.gif`, gif(frames.map((f) => ({ img: preview(f.img, gs), ms: f.ms }))));
                }
                at = ` @${s}x`;
            }
            lines.push(`${def.kind} ${n} ${b.img.w}x${b.img.h}${info}${at}`);
        } catch (e) {
            errors.push(wrap(e).message);
        }
    }

    for (const s of p.sheets) {
        if (want && !want.has(s.name)) continue;
        try {
            const items = [];
            const tags = [];
            for (const name of p.sheetNames(s)) {
                const fr = p.frames(name);
                if (!fr.length) {
                    items.push({ name, img: p.image(name) });
                    continue;
                }
                tags.push({ name, from: items.length, to: items.length + fr.length - 1 });
                fr.forEach((f, i) => items.push({ name: `${name}_${i}`, img: f.img, ms: f.ms }));
            }
            if (!items.length) throw new PxError("sheet is empty (no entries matched)");
            const { sheet, frames } = packSheet(items, s.opts.cols, s.opts.pad);
            await put(`${out}/${s.name}.png`, await png(sheet));
            await put(`${out}/${s.name}.json`, sheetJson(`${s.name}.png`, sheet, frames, tags));
            let at = "";
            if (previews) {
                const sc = pv(sheet);
                await put(`${out}/_preview/${s.name}.png`, await png(preview(sheet, sc)));
                at = ` @${sc}x`;
            }
            lines.push(`sheet ${s.name} ${sheet.w}x${sheet.h} (${frames.length} frames)${at}`);
        } catch (e) {
            errors.push(wrap(e).within(`sheet '${s.name}'`, s.loc).message);
        }
    }
    return { lines, errors };
}

/** An asset as palette keys with x/y rulers (every frame of an anim). */
export async function ascii(fs, file, name) {
    const p = await load(fs, file);
    const def = p.assets.get(name);
    if (!def) throw new PxError(`unknown asset '${name}'${didYouMean(name, p.order)}`);
    if (def.kind === "anim") return p.frames(name).map((f, i) => `frame ${i} (${f.ms}ms)\n${keys(f.img, def.pal)}`).join("\n\n");
    return keys(p.image(name), def.pal);
}

/** The file's assets, groups and sheets, each with where it's defined. */
export async function list(fs, file) {
    const p = await load(fs, file);
    const rows = p.order.map((n) => `${p.assets.get(n).kind.padEnd(6)} ${n.padEnd(24)} ${p.assets.get(n).loc ?? ""}`);
    for (const g of p.groups.values()) rows.push(`${"group".padEnd(6)} ${g.name.padEnd(24)} ${g.loc ?? ""}  [${g.members.join(" ")}]`);
    for (const s of p.sheets) rows.push(`${"sheet".padEnd(6)} ${s.name.padEnd(24)} ${s.loc ?? ""}`);
    return rows.join("\n");
}
