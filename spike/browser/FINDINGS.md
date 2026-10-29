# Spike: an agent's tabs in the background

2026-10-28, Chrome for Testing 149.0.7827.55 on macOS 26.5, the
extension unpacked, Chromium started as a plain process (no automation
tool, so none of its throttling flags or focus emulation). Fixture
pages only; no real site yet.

`node run.mjs [scenario,…]` starts the server, Chromium and the driver;
`node summarize.mjs` prints one line per scenario from `results/`.

## What a page does, by where its tab is

The fixture counts a 100 ms interval, a 50 ms timeout chain and an
animation-frame loop for 6 s; renders rooms after a `fetch`, then a
list in an animation frame, then one more when an
`IntersectionObserver` sees the bottom of the page (after a
`scrollIntoView`).

| Where the tab is | Visibility | Timers | Frames | `fetch` then render | Lazy on scroll | Trusted click (DevTools) | Screenshot |
|---|---|---|---|---|---|---|---|
| Background tab | hidden | ~1/s | none | yes | no | **no** (dropped) | DevTools only |
| Background tab, debugger attached | hidden | ~1/s | none | yes | no | no | DevTools only |
| Background tab, + `Page.enable` | hidden | ~1/s | none | yes | no | no | DevTools only |
| **Background tab, + focus emulation** | **visible** | full | full | yes | **yes** | **yes** | DevTools only |
| Window of its own, uncovered | visible | full | full | yes | yes | yes | both |
| Window of its own, covered | hidden after a few s | slowed | stop | yes | no | yes | both |
| Covered window, + focus emulation | visible | full | full | yes | yes | yes | both |
| Minimized window | hidden | slowed | stop | yes | late (37 s) | yes | **neither** (both hang) |
| Minimized window, + focus emulation | visible | full | full | yes | late | yes | neither |

- **`Emulation.setFocusEmulationEnabled` is what wakes a hidden tab.**
  Attaching the debugger, or `Page.enable`, changes nothing. With it, a
  background tab reports `visible`, runs frames and observers, and takes
  trusted input, without being in front or in a window of its own.
  Detaching puts it back to hidden.
- **A window of its own works only while nothing covers it.** macOS
  occlusion hides a covered window within seconds, and the person's own
  windows will cover the agent's. Minimized is worse: no screenshot at
  all.
- **What a content script can do in any tab:** read the DOM, see
  `fetch`-rendered content, set values and click. Its events are all
  `isTrusted: false`.
- **Input through the debugger:** `Input.insertText` is trusted and
  lands even in a hidden tab. `Input.dispatchMouseEvent` is dropped in
  a tab that has never painted (no hit testing without a frame), and
  works once frames run (focus emulation, or a visible window).
- **Screenshots:** `captureVisibleTab` takes a window's active tab, so
  never a background one. `Page.captureScreenshot` works on a hidden
  background tab in ~30-50 ms, and paints one frame doing it (the
  animation-frame list rendered afterwards). It hangs on a minimized
  window.
- **The studio's tab hidden** (another tab in front, or its window
  covered): its timers drop to ~1/s (a 6 s sleep took 6.7 s), and the
  port to the extension still answers in ~1 ms. Long hidden (5 min+),
  Chrome's intensive throttling would slow chained timers to once a
  minute; not measured.
- `chrome.tabs.onUpdated` never reported a background tab `complete`
  here; polling `chrome.tabs.get` did.
- `chrome.windows.create({ state: "minimized" })` made a normal window
  on macOS; `windows.update` after it minimized.

## What it means for the design

- **Background tabs, with the debugger attached and focus emulation on
  while the agent works in them.** It doesn't depend on the person's
  window layout, takes no focus, and gives frames, observers, trusted
  input and screenshots. It costs the `debugger` permission (its
  install warning) and Chrome's "started debugging this browser" bar (known behaviour, not checked in this run),
  shown on every window while any tab is attached; attaching only while
  a tab is worked in, and detaching after, keeps the bar to the time
  the agent is acting.
- **Content scripts alone** are enough for pages that render from
  `fetch` (most server-rendered and many XHR result pages), with
  untrusted clicks. Lazy lists, frame-driven rendering and sites that
  check `isTrusted` need the debugger. How many hotel sites are which is
  the real-site run's question.
- **Windows per tab: no.** Occlusion and minimizing both stop them.

## Still to measure, on real sites

The fixture can't say: how many hotel sites take the dates in the URL,
how big a real outline is (tokens per page), whether results render
without frames, and how often a bot check appears. That run belongs in
the person's own Chrome (the extension loaded unpacked, the driver on
`localhost:4173`), not a fresh automated profile, whose bot checks
would mislead.
