---
name: pixel-art
description: Draw pixel art (game sprites, characters, items, tiles, tilesets, icons, scenes, animations, sprite sheets) as code with pxl, a compact DSL rendered to PNGs, GIFs and sheets in the workspace; look at upscaled previews and fix pixels by palette keys. Use when asked to draw, design or iterate on pixel art or game assets.
---

# Pixel art with pxl

[pxl](https://github.com/crsolver/claude-pxl) (MIT) is pixel art as
code. You write a small `.px.js` file, and the helper here renders it:
PNGs, upscaled previews to look at, sprite sheets with JSON, and GIFs of
animations. The DSL is built to avoid writing pixels twice: mirroring,
auto-outline, palette-swap variants, reusable parts, primitives,
brushes and tilemaps.

pxl's own CLI needs Node; here its engine runs in `run_ts`, through
`references/pxl.js`. Import it **statically**, at the top of the code
(a dynamic `import()` of a workspace path doesn't resolve):

```ts
import { build, ascii, list } from '/workspace/skills/pixel-art/references/pxl.js'
```

| call | does |
|---|---|
| `build(fs, file, { only?, out?, scale?, preview?, previewFrames? })` | renders into `out/` beside the file; returns `{ lines, errors }` |
| `ascii(fs, file, name)` | the asset as palette keys with x/y rulers (an anim: every frame) |
| `list(fs, file)` | its assets, groups and sheets, each with `file:line:col` |

## Workflow

1. **Write** `art/art.px.js` with `file_write` (start from the template
   below).
2. **Build only what you're working on:**
   ```ts
   import { build } from '/workspace/skills/pixel-art/references/pxl.js'
   return await build(fs, 'art/art.px.js', { only: ['slime', 'heart'] })
   ```
3. **Look at it:** `view_image` on `art/out/_preview/<name>.png`
   (upscaled, checkerboard = transparent, a grid line every pixel and a
   darker one every 8). For exact pixel fixes, `ascii` is cheaper than an
   image:
   ```ts
   import { ascii } from '/workspace/skills/pixel-art/references/pxl.js'
   console.log(await ascii(fs, 'art/art.px.js', 'slime'))
   ```
4. **Fix with small edits** (`file_edit`: a `grid(x, y, ...)` patch, one
   op) and build again. Repeat.

`errors` name the file:line:col, the asset > layer > op path, and
suggest fixes ("did you mean 'r'?"). One broken asset doesn't stop the
others from building. Each `run_ts` starts afresh, so import again in
each one.

**What `build` writes** in `out/`: `sprites/<n>.png`, `scenes/<n>.png`,
`anims/<n>.png` (a strip of frames), `anims/<n>.json` (Aseprite-style
durations and tags) and `anims/<n>.gif`; a GIF beside any animated
sprite or scene; `<sheet>.png` with `<sheet>.json` (TexturePacker hash:
Phaser, Godot and others read it); `_preview/<n>.png`, and
`_preview/<n>.gif` for anything animated. An anim's preview PNG shows
at most 8 of its frames, evenly spaced (`previewFrames` to change it);
`ascii` shows any frame exactly.

## In an app

Build into the app's folder and use the files from there:

```ts
await build(fs, 'art/art.px.js', { out: '/workspace/app/art', preview: false })
```

```html
<img src="art/sprites/slime.png" class="px">
<style>.px { image-rendering: pixelated; width: 128px; }</style>
```

Scale pixel art by whole numbers, with `image-rendering: pixelated` on
images and `ctx.imageSmoothingEnabled = false` on a canvas, or it blurs.
A game draws frames from a sheet: load `art/chars.png` and read each
frame's rectangle from `art/chars.json` (`frames[name].frame`).

## Template

```js
pal({ k: "#1b1630", g: "#8ccf63", G: "#4c8a44", t: "#2a5560", w: "#fff6e0", r: "#e2585e", R: "#a63a4c" })
ramps("ktGg", "kRr")                   // dark -> light, drives shade()/light()

// Symmetric: write the left half, mirror it, outline it.
sprite("slime", { mx: true, outline: "k" }, `
  ....ggg
  ..ggGGg
  .ggGwGg
  gggkwgg
  gggkkgg
  tgggggg
  .tttttt`)
sprite("slime_red", { base: "slime", swap: { g: "r", G: "R" } })   // variant: 1 line

sprite("_eye", "wk\nkk")                                            // "_" = part, not exported
sprite("chest", { w: 16, h: 12, outline: "k" },
  rect(0, 3, 16, 9, "R"), rect(0, 0, 16, 4, "r"), stamp("_eye", 7, 4), shade([0, 9, 16, 3]))

scene("meadow", { w: 160, h: 96, bg: "w" },
  layer("ground", { y: 64 }, rect(0, 0, 160, 32, "G"), noise(0, 0, 160, 32, "g", 0.1, 3)),
  layer("props", stamp("slime", 40, 54), stamp("slime_red", 70, 54, { flip: "x" })),
  layer("shadow", { shade: true }, poly([38, 64, 88, 64, 92, 67, 34, 67], "k")))   // cast shadow

sheet("chars", ["slime*", "chest"], { pad: 1 })
```

## Essentials

- **Colors**: one-char keys from `pal`, `"#hex"`, `"."` skip, `"_"`
  erase. The default palette is pico8 (`0-f`); `use("sweetie16" |
  "db16" | "endesga32" | "gray8")` for others.
- **Items run in order**: grid strings (drawn at 0,0), ops,
  `(c) => { c.rect(...) }` functions, `layer(...)`s. Then mirror → swap
  → flip → rot → outline (grows 1px each side) → crop.
- **Shapes**: `px rect box line(…, width) hline vline circ ring ellipse
  poly fill wire text`.
- **Tone**: `dither grad noise`, `shade/light(region, steps, density)`,
  `recolor`, and `shade:`/`light:` layers for cast shadows and glows.
  Regions: `[cx,cy,r]`, `[x,y,w,h]`, polygon, or a function.
  `clip(region, ...items)` restricts any items (half shapes, slopes).
- **Reuse**: `stamp tile pattern tilemap scatter`. Names can be groups
  or globs (`group("rocks", ["rock_a", "rock_a", "rock_b"])`,
  `"tree_*"`). Each placement picks randomly but reproducibly. Use
  `rflip`, `rswap`, `seed`, and `reseed: true` for per-copy variety.
- **Brushes**: `scatter("_leaf*", x, y, w, h, 30, { on: "g", clip: true,
  rflip: "xy" })` paints texture with tiny part sprites, only on the
  given colors.
- **Animation**: `anim("cat", { outline: "k", fps: 10 }, grid, frame(),
  frame(grid(23, 0, "_K")))`: frames are patches over shared items or a
  `base`; or `frames: 6` + `(c) => ... c.phase ...` for procedural loops.
  Stamping an anim animates the scene (`rdelay: true` desyncs copies,
  `frame: n` freezes one). Check `_preview/<name>.png` or `ascii`.
- **Glow**: `glow("zgQ", { r: 6, strength: 0.5 })` directly in a sprite
  or scene body gives every pixel of those keys a halo (flames, potions,
  moons, neon); `ramp: 2` instead stays in the palette. Give glowing
  things their own keys so nothing else lights up, or limit it with
  `where`.
- **More files**: `include("parts.px.js")` runs another art file,
  relative to the one including it.

The full API, every option: `cat /workspace/skills/pixel-art/references/pxl/reference.md`
(its CLI and Library sections are pxl's own; here the helper does
their work). Dynamic lighting (lamps, light blocked by solid layers,
sky light): `references/pxl/lighting.md`, only when a scene needs
lights.

## Habits that save tokens and give better art

- Write half of anything symmetric (`mx`) and let `outline` draw
  outlines. Never hand-draw either.
- Recolors are `base` + `swap`; repeated details are `_parts` +
  `stamp`; families are a `group` or a loop:
  `for (let i = 1; i <= 3; i++) sprite("tree_" + i, ...)`.
- Large areas: primitives, `grad`, `noise`, `pattern`, `tilemap`. Never
  big hand grids.
- Organic texture (leaves, grass, stones, rust): 2–3 tiny brush parts +
  `scatter` with `on`/`clip`.
- **No filler noise.** Don't sprinkle `noise` speckle over walls, floors
  or plaster to make them "less flat": it reads as random dots, not
  material. Every mark on a surface needs a cause you could name, and it
  should sit where that cause would put it:
  - built structure: siding or plank lines, brick or stone courses with
    offset joints, tile seams;
  - weathering: rain-stain streaks under ledges and sills, splash-back
    grime fading up from the ground, rust runs under metal brackets,
    paint flaking off boards (following the board lines);
  - clutter that tells the story: posters, pipes, vents, cracks from a
    corner.

  Flat color is fine; a clean wall beats a dotted one. `noise` is OK
  only where the material itself is granular (gravel, sand, asphalt, tar
  roofs, rough stone), and keep it sparse. On faces drawn at an angle
  (3/4 views), make the marks follow the face's slant.
- Lighting: define `ramps`, then `light`/`shade` regions; stack a
  `density: 0.5` pass for soft edges. Use `shade: true` layers with a
  `poly` for cast shadows across many objects.
- Use mnemonic keys (`g`/`G` light/dark green). Keep 2–4 shades per
  material for a clean pixel-art look.
- Build with `only` while iterating; a full build also writes every
  preview.
