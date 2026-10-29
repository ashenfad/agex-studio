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

## Real sites

The person's own Chrome (the extension unpacked, the driver on
`localhost:4173?mode=real`), one background tab per site, all five at
once, from a deep link for Lisbon, December 3 to 6 2026, two adults.
Each page read as a content script sees it, then again after the
debugger's focus emulation; nothing clicked.

| Site | Dates taken from the URL | Hidden tab, content script | With focus emulation | Prices in the outline | Outline (≈ tokens) | Bot check |
|---|---|---|---|---|---|---|
| Marriott | yes | **empty** (no title even) | 27 hotels' cards | yes (`124EUR / Night`) | 3,200 (212 of 375 lines are photo carousels) | none |
| Hilton | yes | **empty** | results | yes (`From 257€`) | 2,100 | none |
| Hyatt | yes | **empty** (title only) | 27 results | yes (`Rates from: €192`) | 1,500 | none |
| IHG | yes (its month is zero-based: `qCiMy=112026` is December) | results | results | **no**: 16 hotels listed, rates not yet loaded | 1,500 | none |
| Booking.com | yes | results | results | yes | 4,800 | none seen (it added `chal_t=` to the URL: a challenge passed without asking) |

- **Every deep link took,** dates and guests: no date picker needed
  for any of the five.
- **Three of five render nothing in a hidden tab.** Marriott, Hilton and
  Hyatt wait for a frame before they draw (or for the page to be
  visible); only focus emulation brought them up. Content scripts alone
  would fail the hotel workflow.
- **Four of five showed prices** once woken. IHG lists the hotels but
  loads their rates later (on scroll, or per card): the agent will need
  to scroll, or open a hotel's page.
- **No CAPTCHA or bot wall** in the person's profile, five sites at once.
- **Screenshots** through the debugger worked on all five (26-67 ms).
- **The outline is 1,500 to 4,800 tokens a page,** and much of it is
  noise: photo carousels (Marriott's 212 lines of image `option`s, IHG's
  "Primary Room Photo" buttons), inline fragments split one per line
  (Hyatt's `(` `383` `)`). Dropping carousels and joining inline text
  should roughly halve it.
- **The port dropped after the run** ("port disconnected" once the
  driver went quiet): an open port doesn't keep an MV3 service worker
  alive with no messages on it. The studio's client needs a heartbeat
  while a turn runs, and to reconnect.

## Settled

- **The agent's tabs are background tabs,** the debugger attached with
  focus emulation while the agent works in them (needed by three of
  five real sites, and for trusted input and screenshots everywhere).
- **Deep links first;** the skill teaches learning a site's pattern from
  one pass and checking that the dates show on the page.
- **The outline needs a pass** for carousels and inline text before its
  token cost is a fair number.
