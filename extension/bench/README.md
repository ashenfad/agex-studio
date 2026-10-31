# Outline bench

How well a page reads for the agent, two ways: the extension's own
outline (`src/outline.js`, a walk of the DOM) and one from Chrome's
accessibility tree (`ax-outline.js`, a prototype). Both use the same
line format, `[12] button "Reserve"`.

```sh
node extension/bench/capture.mjs            # freeze every page in sites.js
node extension/bench/compare.mjs            # read each both ways, and check them
node extension/bench/compare.mjs --live udisc  # a live page instead of its capture
```

- `sites.js`: the pages, public ones only (nothing signed in), each with
  checks: patterns a good read passes, for what an agent needs there (the
  destination field, a price, the location search).
- `capture.mjs`: each page as it renders now, saved as MHTML under
  `pages/`, so every compare reads the same page. A site that refuses a
  headless browser captures as whatever it showed.
- `compare.mjs`: per page, each read's size (about a token for four
  characters), its refs, how many have no name, and the checks it passed;
  the reads themselves under `out/`.

`pages/` and `out/` hold the sites' own pages and aren't committed.
