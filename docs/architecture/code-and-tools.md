# Code and tools

What the agent can do in a session: the tools a turn hands the model,
the TypeScript kernel behind `run_ts`, the studio's host objects, the
skills, and `ui` artifacts. The tools and the kernel are the world's
(`@agex-ts/world`); `PROFILE` in `studio.svelte.js` is what the studio
grants every session.

## The tools

A turn's tools come from the world (`worldTools`, inside agex-ts's
`Session`), with the studio's added:

| tool | what it does |
|---|---|
| `terminal` | a termish shell over the session's files; the profile's commands beside its own |
| `file_write`, `file_edit` | write a file; replace a quoted passage in one |
| `view_image` | show the model an image file (only when the settings say the model takes images) |
| `run_ts` | run TypeScript in the kernel (below) |
| `sessions` | delegate: ask, list, result, cancel, keep, resume, published (see [agent-loop.md](agent-loop.md)) |
| `test_app` | act on the app in a browser (see [app-preview.md](app-preview.md)) |

Every call that changes the workspace commits, stamped with its tool,
so the history and undo follow the tool calls.

### Terminal commands

The profile adds two commands to termish's own:

- **`esbuild <entry> --outfile=<out>`** (`esbuild-terminal.js`):
  bundles JSX/TSX under `app/` (and `helpers/`) into a module the
  preview loads. esbuild-wasm loads on the first use
  (`esbuild-bridge.js`).
- **`ws-git`**: the world's agent git over the session: commits with
  messages, diffs and logs, tags, stashes, and bringing a delegate's
  work back (`ws-git merge <name>`, `ws-git checkout <name> --
  <paths>`). It reads store tags too, so `ws-git checkout
  published/<slug>/<n> -- app/` takes a published version's app.

## The kernel

`run_ts` runs the code as the body of an async function in a Web
Worker: the world's worker, which Vite bundles (`import workerUrl from
"@agex-ts/world/worker?worker&url"`) and the profile names
(`code.worker`). Code has the session's files as `fs`, a cache, the
host objects by name (and as `import { … } from 'host'`), and `ui`.

- **Types are stripped**, not checked: the world's default transform,
  ts-blank-space, which loads (with the TypeScript compiler) on the
  first run, in a chunk of its own, so the studio's first load doesn't
  carry it.
- **Bare imports** load from esm.sh (`code.resolve`); a module of the
  session's own is imported by path.
- **The result** the model reads is what the code printed, its
  returned value, an error with its stack, and the `ui` artifacts it
  wrote.

## Host objects

Typed host objects (`typedHost`, their arguments checked against zod
schemas before the method runs) that code calls with `await`:

- **`web`** (`web.js`): `web.search(query, { deep })` answers from a
  web search, with numbered sources (Perplexity's Sonar on
  OpenRouter, the pro search model when `deep`);
  `web.fetch(url, question)` reads one page and answers a question
  from it (a small model with OpenRouter's `web_fetch` server tool),
  refusing an answer given without the page read.
- **`media`** (`media.js`): `media.image`, `media.speech` and
  `media.music`, each taking its arguments as one object (`{ prompt,
  path, … }`), writing the file into the workspace (in the code's own
  commit), and returning facts read from it (size, length, lyrics,
  cost). Images on OpenRouter's images endpoint (transparency, aspect,
  quality, references), speech on Gemini TTS (a `style` for
  delivery), which arrives as PCM and is written as Opus in Ogg
  (`ogg-opus.js`: the browser's WebCodecs encoder and a small Ogg
  muxer; WAV for a `*.wav` name, or where Opus can't be encoded),
  music on Lyria as MP3.
- **`pdf`** (`pdf.js`): `pdf.pages(path)`, `pdf.text(path, { pages
  })` (text with the spacing its layout implies), and
  `pdf.render(path, { pages, scale, dir })`, which writes pages as
  PNGs for `view_image`. pdf.js runs on the page (it needs a canvas),
  loaded from a CDN on first use.
- **`agex`** (agex-ts's `agentTasks`): tasks the agent's code defines
  (`agex.task({ name, instructions, params, returns })`, the types as
  JSON Schema) and calls like a function, or `.map`s over a list. Each
  call runs a helper agent on the person's model (`currentModel` in
  `studio.svelte.js`, a provider built from the settings at each
  request, since one agent serves every session for the page's life),
  in a scratch world of its own in memory: not a delegate, so no
  branch, no strip and no waking. `run_ts`'s description carries
  agex-ts's `AGEX_GUIDE` (`toolOptionsNow`).

`web` and `media` run on the settings' OpenRouter key
(`openrouter-api.js`): with another provider, a call says it needs one,
and the primer tells the agent so. A host object belongs to the
agent's code: an app's code runs in the preview, which has none of
them. Delegates inherit the profile, so they have them too.

## Skills

`PROFILE.skills` mounts the studio's skills read-only under
`/workspace/skills/<name>/`, in every session and its forks. Each is a
directory under `src/lib/skills/` (`skills/index.js` gathers them):
its `SKILL.md`, and any files beside it (references, examples) the
agent reads when the skill points to them.

- **agex-ecosystem**: what the studio is built from (agex-ts, world,
  termish, kvgit), how they fit, and each one's README with its
  version as `references/<name>.md`. The READMEs aren't files of the
  skill's directory: `packageReadmes` in `vite.config.js` reads them
  from `node_modules` at build time (`virtual:package-readmes`), since
  a package's `exports` don't offer its README to an import.
- **interactive-app**: building an app under `/workspace/app`, the
  JSX path with `esbuild`, data from the agent to the app, checking it
  with `test_app` (and checks that mean something), browser features,
  assets, workers, an agent in the app (`agex.task`, and designing
  one), and what doesn't work.
- **making-videos**: a video as an app on the HyperFrames runtime:
  the page (runtime first, a 1920×1080 stage, its own controls over
  `window.__player`), scenes and crossfades, CSS and Anime.js on the
  video's clock, what breaks scrubbing, narration and music from
  `media`, scenes as modules, long videos with delegates, and the
  `test_app` checks (`#root` frames in a grid, the backwards scrub,
  the voice's sync). References: a working page, a narrated scene
  module, and two HyperFrames guides (Apache-2.0, with their license).
- **media**: the `media` calls, their options, voices, costs, and
  how an app uses the files.

The world lists the skills in the tool instructions; the agent reads
one with `cat`. The Files tab hides `skills/`.

## `ui` artifacts

With `code.ui` on, code gets a fresh `ui` object each run; when the
run ends the world writes what it holds under `/workspace/ui` by kind
(a Plotly spec as `.plotly.json`; records or an Arrow table as
`.table.json`; stat and callout cards as `.cards.json`; image bytes, a
data URL, a Blob or an OffscreenCanvas as an image; a `/path` as a
pointer to a file the code saved), committed with the run, and names
them in the result (`[ui artifacts: name -> path, …]`).

A reply embeds one with markdown image syntax,
`![revenue](/workspace/ui/revenue.plotly.json)`. `artifacts.js`:

- `splice(text)` splits a reply at its embeds, leaving those inside
  code blocks and code spans as text;
- `artifactsOf(results)` reads the artifacts a run's tool results
  name; `unembedded` lists those the reply doesn't embed, shown after
  it.

`Artifact.svelte` renders a file by its kind (`artifactKind`): a chart
(`PlotlyChart`), a table (`DataTable`, its cells escaped unless
they're strings, which render as sanitized inline markdown), a row of
cards, an image, HTML in a sandboxed iframe, or text. It reads the
file as the reply's run left it: at the commit the next turn started
from (`ChatSession.endOf(i)`, a frozen view from `viewAt`), and as it
is now for the latest reply. So a name the agent reuses (`ui.chart`
every turn) changes only the replies after.

## Files the person adds

The Files tab's Upload and From Drive (`drive-import.js`, Google
Identity Services and the Picker, the token held only for the
downloads) write into `/workspace/uploads` as one commit
(`ChatSession.importFiles`, `{tool: "import"}`); a Google Doc, Sheet
or Slides deck is exported as text, `.xlsx` or PDF. The primer tells
the agent where uploads land.
