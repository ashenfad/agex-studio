# Capture fidelity bench

How well a rebuilt capture predicts the live page: the roadmap's first
open question (`roadmap/site-filters.md`). A filter is checked on the
site's saved pages, rebuilt with `Document.parseHTMLUnsafe` and no
styles or layout, and applied on the live one; the check is only worth
what the rebuild agrees with the live page.

```sh
node extensions/filters/bench/fidelity.mjs                     # extension/bench/pages/*.mhtml
node extensions/filters/bench/fidelity.mjs --pages DIR reddit  # some pages, from DIR
```

The pages are the outline bench's MHTML captures
(`extension/bench/capture.mjs`). Each is loaded in Playwright's Chromium
(headless, 1280 by 900), captured with `capturePage`, and rebuilt in a
page of its own with `rebuildCapture`. Then, both ways:

- **Selectors**, about 270 a page, made from the live page's own
  elements and sampled the same each run: tags, classes, `tag.class`,
  attribute presence and values, `:has(> child)`, `:has(descendant)`,
  `>` and descendant combinators, and positional forms (`:nth-child`,
  `:first-child`, `:last-child`, `:nth-of-type`, `:empty`, `+`). Each is
  counted in the document and every open shadow root; it agrees when
  both counts are the same. Every live element is numbered (`data-fid`)
  before a second capture, so a disagreement is followed to the element
  and put down to a cause.
- **Visible text**, as words, lowercased (`innerText` applies
  `text-transform`): the live body's `innerText` against
  `capturedVisibleText` of the rebuilt body. Recall is the share of live
  words the capture has, precision the share of captured words the live
  page has. A word one side has and the other doesn't is put down to a
  cause where one fits.

Per page results, with the disagreeing selectors, go to `out/` (not
committed: they hold the sites' own class names). `SAMPLES=1` adds the
words each side alone has.

## Results

Measured 2026-11-01 on the 25 pages there (19 with 20 or more words to
read; the rest are a bot check or a near-empty page).

| | |
|---|---|
| Capture size | median 214 KB, largest 2.4 MB |
| Capture time (in the page) | median 15 ms, slowest 109 ms (10,000 elements) |
| Over the default 2 MB | 2 pages; both fit once long attribute values were cut, no element cut |
| Selectors agreeing | 99.4% (6,721 of 6,759); per page median 99.4%, lowest 98.4% |
| Text recall | 99.1% of 31,471 live words; per page median 99.8%, lowest 91.5% |
| Text precision | 99.3% of 31,392 captured words; per page median 100%, lowest 77.5% |

Selector agreement by form: tags, classes, `tag.class`, attribute values,
both `:has()` forms and both combinators all 100%; attribute presence
96.1%; positional forms 98.9%.

### Where selectors disagree

All 38 disagreements are what the capture leaves out by design:

- **The page's code and styling (29):** an attribute-presence selector
  that also matches a `<script>`, a stylesheet or preload `<link>`, a
  `<style>`, or an element inside a `<noscript>` (`[type]`, `[href]`,
  `[rel]`, `[id]`, `[fetchpriority]`, a few others). A filter never
  means those, but one written as a bare attribute selector counts
  differently on a capture.
- **Position among siblings (9):** `:nth-child(n)`, `:last-child` and
  `+` where a dropped `<script>` or `<link>` sat among the siblings: 8
  in `<head>`, 1 in `<body>`. A filter that counts siblings can match a
  different element on a capture; one that names what it hides doesn't.

Nothing was put down to the parser re-nesting or dropping an element,
to a changed attribute, or to a shadow root lost or misplaced (147 open
roots on one page, up to 28 on the others).

### Where text disagrees

- **A closed `<select>`'s options (259 live words):** `innerText` reads
  every option; a person sees the chosen one, and the capture marks the
  rest hidden (they draw no box). Most of the lowest recall (91.5%,
  96.9%) is a long category dropdown.
- **Shadow tree text (161 captured words):** `innerText` reads slotted
  light DOM but not a shadow tree's own text (a badge, a label, a
  fallback), which a person sees and the capture reads. It is most of
  the lowest precision (77.5%, a page of 147 web components). This
  matters for the live side too: a `hasText` evaluated with `innerText`
  on such a page misses text the capture's check found.
- **Words run together (48 captured, 4 live):** neighbouring boxes the
  reader joins as inline where the live page separates them.
- **Marked hidden, read by `innerText` (12 live words):** a zero-size,
  clipped element (`innerText` reads what is rendered, at any size).
- **Other:** 10 captured words, 23 live.

Before the walk marked blocks (`data-agex-block`), with the reader
breaking lines at elements that are blocks by default only, recall was
93.2% and precision 96.3%: flex and grid items, and boxes positioned out
of the flow, are blocks by their style, not their tag, and their words
ran together (`$325$325`, `reviews4.96`). Breaking at gaps between
recorded boxes instead got 94.9% and 96.9%; the mark gets 99.1% and
99.3%, for 1 to 10% more bytes.

### What it doesn't measure

- **The live page is the MHTML's render,** with no scripts running:
  custom elements aren't defined (their shadow roots are the
  declarative ones Chrome wrote into the MHTML), and nothing changes
  after load. `<noscript>` content shows there; none of these pages
  had any.
- **Closed shadow roots and cross-origin frames** can't be read from
  the page on either side, so neither count has them.
- **The cut** wasn't exercised by an element cut on a real page: both
  over-size pages fit once long attribute values (a JSON blob in a data
  attribute, SVG paths) were cut to a kilobyte. A long scrolled feed
  is what would exercise it (the end-to-end test's long page does).
- **Layout-dependent checks** (a filter's size and position
  conditions) against the recorded boxes, which want live pages
  scrolled and resized.
