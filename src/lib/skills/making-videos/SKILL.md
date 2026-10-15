---
name: making-videos
description: Make a video as an app — an HTML composition of timed scenes animated with CSS and Anime.js on the HyperFrames runtime, with narration and music from media, its own play/scrub controls and an Export button that saves it as an MP4; scenes as modules, long videos with delegates, and how to check frames with test_app.
---

# Making videos

A video here is an app. `app/index.html` holds a **composition**: a
1920×1080 stage, scenes that are shown for a stretch of time, and
animations. The HyperFrames runtime runs it on a clock of its own, so it
can be played, paused and scrubbed to any moment and always shows the
same frame there. The page has its own play button, scrubber and Export
button (which saves the video as an MP4, in the viewer's browser), and
it previews and publishes like any other app.

Two things this is not:

- **Not GSAP.** HyperFrames' own examples animate with GSAP; its license
  rules it out here. Animate with CSS keyframes or Anime.js, below.
- **Not a `<hyperframes-player>`.** The player element frames a
  composition in an iframe of its own and loads the runtime there
  itself, after the composition's scripts have run: a video that works
  once and breaks on a reload. Here the page IS the composition, and its
  controls drive the runtime directly.

## Do this first

The reference is a working 10-second video: three scenes, crossfades,
a bar chart Anime.js grows, and the controls, Export among them. Read
it, copy it and its exporter into the app, then change the content:

```sh
cat /workspace/skills/making-videos/references/index.html
mkdir -p /workspace/app
cp /workspace/skills/making-videos/references/index.html /workspace/app/index.html
cp /workspace/skills/making-videos/references/export.js /workspace/app/export.js
```

Keep its structure: it already does the things below that are easy to
get wrong. Two more references go deeper:

```sh
cat /workspace/skills/making-videos/references/narrated-scene.js           # a narrated scene in a module of its own
cat /workspace/skills/making-videos/references/hyperframes/animejs.md        # before writing Anime.js: v4 API, splitText, seeded random
cat /workspace/skills/making-videos/references/hyperframes/css-animations.md # CSS keyframes: fill, delays, staggers, loops
```

## The page

```html
<script src="https://cdn.jsdelivr.net/npm/@hyperframes/core@0.8.92/dist/hyperframe.runtime.iife.js"></script>  <!-- first, always -->
<script src="https://cdn.jsdelivr.net/npm/animejs@4.5.0/dist/bundles/anime.umd.min.js"></script>

<div id="frame">
  <div id="root" data-composition-id="main" data-start="0" data-duration="10"
       data-width="1920" data-height="1080">
    <div class="scene clip" data-start="0" data-duration="3.5">…</div>
    <div class="scene clip" data-start="3" data-duration="4">…</div>   <!-- overlaps by 0.5s -->
  </div>
</div>
<div id="controls">…</div>
```

- **The runtime is the first script in `<head>`,** a plain classic
  `<script src>`: not `async`, `defer` or `type="module"`. It creates
  `window.__player` (`play()`, `pause()`, `seek(seconds)`, `getTime()`,
  `getDuration()`, `isPlaying()`) and sets `window.__playerReady`.
- **Pin every CDN URL to an exact version,** as above. An unpinned URL
  changes under a finished video.
- **The root's `data-duration` is the video's length** in seconds. Write
  it in the HTML: it is read once, before any script runs, so a script
  that changes it later changes nothing.
- **A clip is any element with `data-start` and `data-duration`,** shown
  from its start for its duration and hidden before and after. Scenes
  are clips; give them `class="clip"` as well, by convention, and the
  reference's `.scene` rule makes a scene fill the stage. Clips may
  overlap in time; which one is in front is CSS `z-index`.
- **The runtime owns a clip's visibility.** Never animate `display` or
  `visibility` on a clip; fade its content with `opacity`, or animate a
  child.
- **The stage is 1920×1080 pixels,** and `#frame` scales it to fit the
  window. Size text in px for 1920×1080, not vw or %. Keep 80px clear at
  every edge, as the reference's padding does.
- **Fonts come from a CDN, pinned, with `crossorigin`** (without it,
  `test_app`'s screenshots can't draw them). System fonts differ from
  machine to machine. The Fontsource variable fonts on jsDelivr:
  `<link rel="stylesheet" crossorigin
  href="https://cdn.jsdelivr.net/npm/@fontsource-variable/inter@5.3.0/index.css">`,
  then `font-family: "Inter Variable"`. Good pairs: **Space Grotesk**
  (`space-grotesk`) or **Outfit** (`outfit`) for headlines with
  **Inter** for text; **Fraunces** (`fraunces`) or **Playfair Display**
  (`playfair-display`) for a serif voice; **JetBrains Mono**
  (`jetbrains-mono`) for code. Video is watched, not read: text 32px or
  larger, headlines 80px or larger, and weights far apart (400 against
  800).
- **Images, sound and data come from the app,** under `app/`: a path in
  the HTML counts from `app/` (`<img src="img/fox.png">`). A path a
  script sets is not seen by the build: take its URL from
  `window.appAssets['img/fox.png']`.
- **The controls are outside `#root`.** They are not part of the video,
  and `test_app` screenshots `#root` alone.

## Scenes and transitions

Cut from one scene straight to the next and the frame between them is
empty: the old scene is gone and the new one's content has not faded in
yet. Crossfade instead, as the reference does:

- **Overlap consecutive clips by about 0.5s:** the next scene's
  `data-start` is 0.5s before the previous one ends.
- **Fade the whole scene with two wrappers:** `.scene-in` fades in over
  the first 0.5s of the clip, and `.scene-out` inside it fades out over
  the last 0.5s (`--out` is the clip's duration minus 0.5). Two
  wrappers, not two animations on one element: opacities multiply, and
  one element with two opacity animations gets one of them wrong.
- The last scene holds to the end: its `--out` is its whole duration.

Slides, wipes and zooms work the same way on the wrappers: animate
`transform` or `clip-path` on `.scene-in` and `.scene-out` instead of,
or as well as, `opacity`.

## Animating

Three ways, all seeked by the runtime. Pick per element; one video can
use all of them.

**CSS keyframes, for entrances and simple motion.** Timed relative to
the clip they are in: an animation inside a scene that starts at 3s
begins at 3s. Use `both` so the element holds its first frame before the
animation and its last after it, and `animation-delay` to stagger.

```css
.title { animation: rise 1.2s ease-out both; }
.subtitle { animation: rise 1.2s ease-out 0.4s both; }
@keyframes rise { from { opacity: 0; transform: translateY(40px); } to { opacity: 1; transform: none; } }
```

**Anime.js, for anything sequenced.** A timeline of steps, staggers and
numbers that count. Four rules the runtime depends on:

1. `autoplay: false`, and push every timeline or animation onto
   `window.__hfAnime`, creating it if it isn't there yet
   (`window.__hfAnime = window.__hfAnime || []`). The runtime seeks only
   what is registered; an unregistered animation plays once on its own
   clock and ignores the scrubber.
2. **Positions are the video's time, in milliseconds.** Unlike CSS,
   Anime.js does not know which scene it is in: a step for the scene that
   starts at 3s goes at `3000` or later.
3. **One step per property per element.** A second step that animates
   the same property of the same element (a fade in, then a fade out; a
   caret blinking as eight opacity steps) plays forwards and then scrubs
   backwards wrong. Use one step with keyframes, `opacity: [0, 1, 1, 0]`,
   or put the second motion on a wrapper.
4. **Start every animated element in CSS where its step starts.** Before
   a step begins, the element shows its CSS value the first time through
   but the step's first value once the scrubber has been past it. The
   reference's bars are `height: 0` and its figures `opacity: 0` in CSS
   for that reason.

```js
const tl = anime.createTimeline({ autoplay: false });
tl.add('#q1', { height: [0, 230], duration: 1200, ease: 'outCubic' }, 3300)
  .add('#q2', { height: [0, 365], duration: 1200, ease: 'outCubic' }, 3550);
window.__hfAnime = window.__hfAnime || [];
window.__hfAnime.push(tl);
```

This is Anime.js **v4**. `anime` is a namespace: `anime.animate(targets,
params)`, `anime.createTimeline()`, `anime.stagger(100)`. The v3 form
`anime({ targets, ... })` does not exist and throws *anime is not a
function*. Easings are `'outCubic'`, `'inOutQuad'`, `'linear'`, not v3's
`'easeOutCubic'`.

**WAAPI (`element.animate(...)`)** also works, and like Anime.js it runs
on the video's clock: `delay` is the absolute start in milliseconds. Use
`fill: 'both'`.

## What breaks scrubbing

The runtime can show any moment only if every frame on the stage is a
function of the time. These are not, and each one shows up as a video
that plays once and then scrubs wrong:

- `setTimeout`, `setInterval` and `requestAnimationFrame` loops that move
  things on the stage. Put the motion in a CSS animation or an Anime.js
  timeline. (The controls' own loop is fine: it moves nothing in `#root`.)
- `Math.random()` and `Date.now()` when drawing. Use fixed values, or a
  seeded generator written out in the page.
- Anime.js animations with `autoplay` left on or not pushed onto
  `window.__hfAnime`.
- Two Anime.js steps on the same property of the same element. Forwards
  looks right; seek back and the element keeps a value from later.
- An element whose CSS disagrees with its Anime.js step's first value.
  Before the step, it shows one or the other depending on where the
  scrubber has been.
- Loops that never end: CSS `animation-iteration-count: infinite`,
  Anime.js `loop: true`. Give a pulse a finite count that fits its scene.
- `<video>` and `<audio>` are timed by the runtime when they are clips
  with `data-start`; do not call `.play()` on them yourself.

## Narration, music and generated images

`media` (see `/workspace/skills/media/SKILL.md`) narrates, scores and
illustrates a video, from `run_ts`.

- **Write the whole script, then voice it in one `run_ts` call,** one
  line per scene, together:
  ```ts
  const lines = [
    { text: 'Meet agex studio.', path: 'app/audio/s1.ogg', style: 'warm and welcoming' },
    { text: 'Every turn is a commit. <short pause> Every one.', path: 'app/audio/s2.ogg' },
  ]
  return await Promise.all(lines.map((l) => media.speech({ ...l, voice: 'Sulafat' })))
  ```
  Name each `*.ogg` (Opus, small). Each result's `seconds` is that
  line's length, and its `path` is where it was written: use that.
- **The text is read word for word.** Put only what is said in it: a
  direction such as `[whispers]` or "Say warmly:" is spoken aloud. How a
  line is said goes in `style`. Short sounds go inline in angle
  brackets (`<laugh>`, `<sigh>`, `<breath>`, `<short pause>`), and are
  performed rather than read. Spell names, acronyms and symbols the way
  they should sound ("agex studio", "W S git").
- **Two path bases.** `media` paths count from `/workspace`
  (`app/audio/s1.ogg`); paths in the page count from `app/`
  (`audio/s1.ogg`), and so do `appAssets` keys. Copying one into the
  other is a missing file.
- **The voice sets the length.** A scene lasts its line's `seconds`
  plus about 0.4s before the voice starts and a second after it ends,
  so the picture follows the voice rather than cutting it off.
- **Place each line as a clip:** `<audio class="clip" id="s1-voice"
  src="audio/s1.ogg" data-start="3.4" data-duration="3.2"></audio>`,
  inside `#root`. Its `data-start` is the video's time: 0.4s after its
  scene starts.
- **Music goes under the voice, not over it.** Compose a bed with
  `media.music`, naming the genre, instruments, tempo and mood, and "no
  vocals" when it plays under narration:
  ```ts
  return await media.music({ prompt: 'Warm lo-fi bed for a product video: soft keys, brushed drums, 85 bpm, no vocals', path: 'app/audio/bed.mp3' })
  ```
  It writes an MP3, so name it `*.mp3`. A clip is about 30 seconds. For
  a longer video, pass `length: 'song'` and ask for the video's length
  in the prompt ("a 90-second instrumental"). What comes back is only
  roughly that long, so use the `seconds` it returns.
- **Place the bed as a quiet clip across the video,** fading in and out:
  `<audio class="clip" src="audio/bed.mp3" data-start="0"
  data-duration="24" data-volume="0.25" data-fade-in="1"
  data-fade-out="2"></audio>`. `data-volume` runs from 0 to 1, and about
  0.25 keeps the voice clear over it. The fades are in seconds. A
  `data-duration` shorter than the music ends it there, after its fade.
- **Music with vocals comes back with its lyrics,** every sung line in
  order. A clip's lines carry the second each starts (`{ at: 2.2, line:
  '...' }`), ready to time captions to. A song's come with `at: null`,
  so captions for a song are timed by hand.
- **Generate pictures with `transparent: true`** for anything that sits
  on a background: characters, icons, objects. Pass earlier images as
  `references` to keep a character the same from scene to scene, and
  look at each with `view_image` before placing it.
- **Keep words in the HTML,** not in generated images: image models
  misspell, and HTML text stays sharp at any size and animates.

## Scenes in modules

A long video is easier to build, and to share out, as one module per
scene: `app/scenes/<id>.js`, whose default export adds its scene to the
stage at the time it is given. The page places them, after its own
scripts:

```html
<script type="module">
  import title from './scenes/title.js';
  import chart from './scenes/chart.js';
  title({ start: 0 });
  chart({ start: 4.5 });
</script>
```

Prefer ONE page for a video under a minute or so. When you split, start
each scene from `references/narrated-scene.js`, and remember:

- **Timing.** A scene module is given its `start`. CSS animations inside
  it count from the scene's start, as in the page; clips and Anime.js
  steps take the video's time, so they add `start`.
- **Assets.** A module sets paths from script, which the build doesn't
  see: `audio.src = window.appAssets['audio/chart.ogg']`.
- **Style.** Every scene lands in the same page. A module's own rules
  are scoped to its id (`#chart .title`) and its keyframes carry the id
  in their names; the wrappers, fonts and colours come from the page.
- **Length.** The root's `data-duration` is written in the page, so when
  a scene's length changes, the page's sum changes with it.
- **Synchronous.** A module adds its clips and registers its timeline
  when it is imported and called, not after a `fetch`, a timer or an
  event: the runtime must find them at load.

## Long videos with delegates

A video of more than a minute, or more than five or six scenes, can be
built a scene per delegate, in parallel (`sessions ask`). Each delegate
is a whole agent on your model, so use three to six of them, not twenty,
and build a short video yourself.

This is for the session directing the whole video. **If you are a
delegate given a scene, build it yourself:** a scene is the unit of the
work, and splitting it again only multiplies the cost.

1. **Set what the scenes share, first.** Write the page: its styles
   (fonts, colours, the scene wrappers), the root, the controls, and a
   plan of the scenes with their narration. Pick the voice. Delegates
   start from your files as they are when you ask, so this has to be
   written before you ask.
2. **One delegate per scene, each owning its files:**
   `app/scenes/<id>.js`, `app/audio/<id>*.ogg`, `app/img/<id>*.png`. A
   delegate must not touch the page or another scene's files; that is
   what keeps bringing the work back conflict-free.
3. **A task that stands alone.** A delegate starts without this
   conversation, so its task says everything: the scene's id and its
   narration, the voice, that its module starts from
   `skills/making-videos/references/narrated-scene.js`, to build the
   scene itself without delegating, to voice the line with
   `media.speech` and size the scene from `seconds`, to check its scene
   with `test_app` (placing it in its own copy of the page at
   `start: 0`, and changing nothing else when it reports), and to reply
   with the scene's length and the files it wrote.
4. **Then end your turn,** saying what you are waiting for. Each answer
   starts your next turn on its own; do not poll. As each arrives, take
   its work with `ws-git checkout <delegate> -- <its files>`, naming
   each file it listed: its scene, its audio, its images. (A delegate's
   test edits to the page stay behind that way.)
5. **Stitch.** Import and place each scene in the page, its `start` the
   running total of the lengths before it less 0.5s for each crossfade,
   and set the root's `data-duration` to the end of the last. Then check
   the whole video as below.

## Exporting a file

The Export button runs `app/export.js` (copied from
`references/export.js`; read its header): it steps `__player` through
every frame, draws `#root` as a screenshot does, mixes the audio clips
as the runtime plays them (start, duration, volume, fades), and
encodes an MP4 (H.264 and AAC), or a WebM where the browser can't
encode those. It runs in the viewer's browser, so a published video
exports for whoever watches it. You don't need to change it: it reads
the stage's size, the video's length and the clips from the page.

- **It takes about 1.5 times the video's length** at 1920×1080 and
  30fps, with the tab visible. The button shows the progress, and
  pressing it again stops.
- **What it draws is what a screenshot shows,** so a video whose
  `test_app` grid looks right exports right. A `<video>` inside the
  stage isn't drawn, nor an image from a site that doesn't allow it.
- **Check it with a short part,** not the Export button: in `test_app`,
  `{"eval": "window.exportVideo({ to: 2 }).then((f) => [f.name, f.type, f.size])"}`
  makes the first 2 seconds and answers what it made
  (`["quarterly-revenue.mp4", "video/mp4", 316501]`); `from` and `to`
  pick any part, `format: "webm"` the other format. Don't click Export
  in a test: it makes the whole video, for no one.

## Checking it

`test_app` loads the page fresh each call, as a viewer's reload does.
`window.__player` is the runtime's handle: `seek(seconds)` takes effect
at once. Screenshot `#root`, not the page: that is the 1920×1080 stage
at full size, whatever the window, without the controls. One call
checks the whole video:

```json
[
  {"assert": "window.__playerReady === true", "message": "the runtime isn't ready: is it the first script in <head>?"},
  {"eval": "window.__player.getDuration()"},
  {"eval": "window.__player.seek(1.5)"},
  {"assert": "getComputedStyle(document.querySelector('#scene-title')).visibility === 'visible'"},
  {"screenshot": "#root", "grid": "scenes", "label": "1.5s title"},
  {"eval": "window.__player.seek(3.25)"},
  {"screenshot": "#root", "grid": "scenes", "label": "3.25s crossfade"},
  {"eval": "window.__player.seek(6)"},
  {"assert": "parseFloat(getComputedStyle(document.querySelector('#q4')).height) > 500"},
  {"screenshot": "#root", "grid": "scenes", "label": "6s chart"},
  {"eval": "window.__player.seek(9.5)"},
  {"screenshot": "#root", "grid": "scenes", "label": "9.5s closing"},
  {"eval": "window.__snap = () => [...document.querySelectorAll('#root *')].map(e => { const s = getComputedStyle(e); return [s.opacity, s.transform, s.width, s.height, s.visibility].join(); }).join('|'); window.__player.seek(6); window.__at6 = window.__snap(); true"},
  {"eval": "window.__player.seek(9.5)"},
  {"eval": "window.__player.seek(6)"},
  {"assert": "window.__snap() === window.__at6", "message": "6s looks different after scrubbing back"}
]
```

The screenshots that name a `grid` come back as **one** image, each frame
captioned with its `label`: up to 12 frames, so a long video still fits
one call. What to cover, with the times changed to your video's:

- **The middle of each scene and the last second,** each a frame in the
  grid. Look at the image, not only at the asserts: that is where text
  off the stage and labels running into numbers show.
- **A scene boundary** (3.25 above, inside the first crossfade). Both
  scenes should be partly visible; an empty frame means a cut to black.
- **Scrubbing backwards,** the last four steps: record every element's
  state at a time, visit a later time, come back, and compare. A
  mismatch means something is not a function of the time; the usual
  cause is two Anime.js steps on one property.
- **The console.** The result lists the page's console output first. An
  error there (`Cannot set properties of undefined`, a 404, *anime is
  not a function*) is a failure even when every assert passed: it is
  often a race that a reload will lose.

A grid's frames are small, and small text in them can look broken when
it is fine. To read one frame in detail, take a plain `{"screenshot":
"#root"}` at that moment as well.

**Narration** needs checking too, and a paused frame says nothing about
it: after a seek, a clip's `currentTime` reads 0 even when it is fine.
Check that each clip loaded, then play a moment of one scene and read
where its voice is:

```json
[
  {"eval": "[...document.querySelectorAll('audio.clip')].map(a => a.readyState === 4 && !a.error)"},
  {"eval": "window.__player.seek(10.2); window.__player.play(); true"},
  {"wait": 1000},
  {"eval": "[window.__player.getTime(), document.querySelector('#intro-voice').currentTime]"},
  {"eval": "window.__player.pause(); true"}
]
```

Every clip should read `true`. The last answer is the video's time and
the voice's, read at one moment, so they differ by where the voice
starts: for a voice placed at 9.9s, about `[11.2, 1.3]`.

## Done

A video is done when:

1. `test_app` passed seeking into every scene and onto a scene
   boundary, with a grid frame of each, the backwards scrub matched,
   and the console showed no errors. Your report says what you checked.
2. Every animation is CSS, WAAPI or a registered Anime.js timeline, and
   the root's `data-duration` covers the last scene.
3. If it is narrated, every clip loaded, and a played moment put the
   voice where the scene's timing says.
4. `window.exportVideo({ to: 2 })` made a file, and the page's Export
   button is there.
