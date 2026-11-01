# Site filters: an agent that tidies the sites you choose

Status: proposed 2026-11-01. A second browser extension, offered as a
developer-mode download beside the browsing one, that runs an agex-ts
agent inside itself, with no studio tab. A spike settled how the agent
is hosted there (below; its code and numbers are on the
`spike/extension-agent` branch, `spike/extension-agent/FINDINGS.md`).
agex-ts needs one option (a classic kernel worker); the studio lends
its model settings.

## Why

Filter lists block ad networks well. What they miss is the clutter a
site serves itself: "Sponsored" posts woven into a feed, its own
promotions, nag banners, autoplay rails, recommendation boxes. Each
site does it differently and changes it now and then, so a list kept
by hand for everyone falls behind, and the person has nobody to ask
about the one site that bothers them.

An agent can write a filter for one site, from the pages the person
shows it, and revise it when the person says what's wrong. It works in
the background; the person only submits pages and says yes or no.

It isn't a list-based ad blocker, and doesn't try to be one: it's
for the sites the person picks, and for what lists don't catch.

## The person's view

1. **Submit a page.** On a site, the toolbar's popup offers *Filter
   this site*. A small warning says what happens: the page as it is
   now goes to the person's model provider, and is kept on this device
   as one of the site's test pages; stronger when the page has a
   password field or looks like an account page.
2. **The agent works in the background.** The tab can be closed.
3. **A notification:** "A filter for reddit.com is ready: 14 items
   hidden on the pages you sent."
4. **Preview.** On the site, the popup shows the candidate applied,
   what it hides outlined rather than removed, with a before/after
   switch.
5. **Accept or Reject.** Accept makes it the site's filter (and is
   when Chrome asks for the site's permission, so applying it on later
   visits is approved as it starts). Reject keeps what was there, with
   an optional reason the agent gets next time.
6. **Afterwards, per site:** on/off; *Extend* (submit this page too);
   *Remove* the filter; *Forget this site* (its session, its pages, the
   permission). A global pause, for "is the extension what broke this?"

When an accepted filter hides nothing on a page of its site, the popup
says so and offers *Extend*: a hint, never a run the person didn't
start.

## The shape

```text
popup / notifications / app page          the site's tabs
        │ runtime messages                content script: applies the
        ▼                                 filter, previews a candidate
service worker ── wakes ──▶ offscreen document (extension origin)
  (captures, permissions,     the store (kvgit on IndexedDB), settings,
   declarativeNetRequest)     the model provider, captures rebuilt to test on
                                │ postMessage
                                ▼
                              sandboxed iframe (manifest `sandbox`, origin "null")
                                agex-ts: a session per site, its kernel in a worker
```

- **The agent lives in the extension.** An offscreen document stays up
  while it's needed, and holds what an extension page may: the store in
  IndexedDB, the person's settings, the model provider. A page listed
  under the manifest's `sandbox` runs agex-ts, since only a sandboxed
  page may eval; its store calls and its model calls go to the
  offscreen document over `postMessage`. No studio tab, and no
  `debugger` permission.
- **The model is called from the offscreen document,** through a
  stand-in `Provider` in the sandbox that forwards each `stream` and
  relays its events. The key never enters the page where model-written
  code and submitted page text meet.
- **The agent has no network.** The sandbox's CSP allows no
  connections (`connect-src 'none'`) and no remote imports: only the
  libraries bundled with the extension. What it reads comes from the
  captures; what it does is write files and present a filter.

## A session per site

- **A site is a registrable domain** (`reddit.com`, covering
  `old.reddit.com`), and has one session: its memory of the site, the
  person's decisions, the pages they sent. Session names can't be the
  domain itself (a dotted name reads as a delegate's), so they're
  encoded (`site-reddit-com`), the domain kept in the session's
  metadata.
- **A chat-shaped session, not a task.** The person's words (a
  rejection's reason, *Extend*) are turns of one conversation that
  remembers what it tried and why. A typed task would check the
  filter's shape for us, but the extension has to check every filter
  before applying it anyway, and a task forgets each time.
- **Filters are files by convention:** `filters/<domain>.json` for the
  whole site, `filters/<host>.json` for one host that differs (a host's
  file wins where both match). Every version is a commit.
- **Captures are the site's test pages:** `pages/<n>.json`, a bounded
  set (the latest few of each kind of page, compressed). A filter has
  to hold up on all of them, not just the newest.
- **Sessions can read each other.** The agent may mount another site's
  session read-only (the world's `attach`, `ws-git worktree add`) to
  see how it handled something there. Enabled to learn whether agents
  use it: the run log counts each peek. Another session's files include
  its pages, so a page submitted for one site can be read while working
  on another, on this device only; the agent has no network to take it
  further.
- **One turn at a time, across all sites:** a global queue.

## Captures

The person's click is the submission. Clicking the toolbar button
grants the extension that one tab for the moment (`activeTab`), with no
host permission, which is enough to run a capture script in it and take
a screenshot.

- **The page as the person sees it,** after their own scrolling: the
  DOM serialized after rendering by a walk of our own, which annotates
  each element with what layout knows (its box, whether it's visible,
  the text a person sees), so checks that need them work away from the
  live page. The walk goes into every open shadow root, nested ones too,
  as the browsing extension's outline does (`getHTML`'s
  `serializableShadowRoots` alone would leave out any root not created
  serializable, which is most), and writes each as a declarative one
  (`<template shadowrootmode="open">`). Scripts are left out.
- **A screenshot** of what's in view; the URL, title and host.
- **Only what was submitted** reaches the agent: no other tab, nothing
  in the background.

## Filters

A small format of our own, checked by the extension before anything is
applied:

```json
{
  "version": 1,
  "hide": [
    { "selector": "shreddit-ad-post", "why": "promoted posts" },
    { "selector": "article", "hasText": "Promoted", "why": "native ads in the feed" },
    { "selector": "span.badge", "hasText": "Sponsored", "upward": "article" }
  ],
  "block": [
    { "urlFilter": "||ads.example^", "types": ["script", "image", "xmlhttprequest"], "why": "ad requests" }
  ]
}
```

- **`hide`:** a CSS selector (`:has()`, `:is()`, attribute matches),
  optionally with a few operators the extension evaluates: `hasText`
  (a pattern on the text a person sees, `innerText`, so letters
  shuffled into hidden spans don't fool it), `upward` (from a match to
  the card that holds it, by count or selector), `matchesAttr` (a
  pattern on an attribute). These are filter lists' procedural
  operators; their maintainers hide most native ads with them.
- **`block`:** `declarativeNetRequest` rules, each held to requests the
  site's own pages make (`initiatorDomains`).
- **`version`** from the first, so a later extension reads an older
  filter.
- **Later levels,** if the dogfood's misses ask for them: a small
  predicate language (conditions on tag, attributes, visible text,
  size and position, ancestors and children, as a tree the extension
  evaluates), then contained code. Neither is in v1.

## Done: `present_filter`

The agent says a filter is ready by calling `present_filter`. The
extension checks it at the call, and the result says what failed:

- **The format and the guards:** every rule within the site; at most
  so many rules; nothing that hides the page's root (`html`, `body`,
  `main`) or blocks the site's own pages.
- **Each saved page, before and after:** the page's main text still
  there, and only what the filter names gone. The pages are rebuilt in
  the offscreen document with `Document.parseHTMLUnsafe`, which, unlike
  `DOMParser`, attaches their declarative shadow roots; the selectors
  and operators run against them, and the recorded boxes stand in for
  layout.

On a pass it becomes the site's candidate, the notification goes out,
and the turn can end: the agent is told the person decides. Their
decision is the next turn's input ("accepted"; "rejected: it hid the
comments"). A new candidate replaces one not yet answered. The
extension keeps two filters a site: the accepted one, which applies,
and the candidate.

The agent tries filters before presenting them with a host object
(`site.try(filter)`: what each rule matches on each saved page, with
samples), and may judge many candidate elements at once with
`agex.task`.

## Applying

- **CSS** goes in as a stylesheet (`scripting.insertCSS`), which also
  covers elements a page adds later. A content script runs the
  operators, again on added nodes (`MutationObserver`): infinite feeds
  and navigation inside a single-page app need nothing from the agent.
- **Block rules** are dynamic `declarativeNetRequest` rules.
- **Host permission** for the site is asked when the person accepts
  its first filter (optional host permissions, one site at a time), and
  given back when they forget the site.
- **Show hidden** outlines what the filter hides; on/off and the global
  pause take effect at once.
- **What it hid** on the page in front is the popup's count.

## Trust

- **Promised:** the agent reads only pages the person submitted; it
  can't send anything anywhere (no network, no remote imports); the key
  never reaches the sandbox; no filter applies until the person accepts
  it; every filter is checked against the guards, and stays within its
  site.
- **A page may be aimed at the agent.** What it can do is bounded by
  the above: at worst a bad filter, for that site, which the person
  previews and can turn off. A session's memory can carry a page's
  instructions into its later turns, which is why each site has its own;
  peeking lets one session read another's files, which the run log
  makes visible.
- **What a submitted page holds** goes to the person's model provider,
  as anything an agent reads does, and is kept on this device as a test
  page until the site is forgotten. The submission's warning says so.

## Spend

Every run is started by the person (a submission, *Extend*, a reason
with a rejection), and the agent can't start one itself, so a runaway
needs nothing to guard but one turn. A cap on tool calls per turn
(agex-ts's `maxToolCalls`) bounds that. Each run's cost shows in the
popup and a running total in the app page, from the run record's usage,
as the studio's app meter (`app-meter.js`) keeps it. A daily allowance
waits until real use asks for one.

## Settings and the app page

The extension's own page (`chrome-extension://…/app.html`):

- **The model:** the studio's model settings, reused. The studio's
  model tab becomes a component (`ModelSettings.svelte`) its settings
  dialog uses, and the extension builds it too. Settings stay in the
  extension's `localStorage`, which the offscreen document shares.
- **Sites:** each one's filter, on/off, its pages, and a log of its
  runs (what each tried and presented, its cost, its peeks).

## What the spike found

Measured 2026-11-01 in Playwright's Chromium (headless):

- An offscreen document can't eval, but has IndexedDB and the network.
- A sandboxed page can eval, import from esm.sh, and reach a model
  provider (a request with a fake key got OpenRouter's 401); it has no
  IndexedDB and no `chrome.*`.
- **A module worker from a blob fails there** (the world asks for
  one); a classic one works, with eval and `import()` inside. The
  bundled kernel worker has no `import` or `export`, so it runs as a
  classic one.
- A scripted turn ran two `run_ts` calls through the world's kernel in
  the sandbox (typed TypeScript, a file written, an esm.sh import), the
  store kept by the offscreen document; a store opened afresh after the
  offscreen document was closed found the session, its two runs and the
  file.
- Chrome's default sandbox CSP blocks blob workers and remote imports:
  the manifest sets its own.
- The sandbox's bundle: 4.1 MB minified, 3.6 MB of it the TypeScript
  compiler `ts-blank-space` brings in.

## Phases

### Phase 0: what it builds on

| # | Where | What |
|---|---|---|
| 1 | agex-ts | A classic kernel worker, as an option of the world's (`code.worker.type`), for a page whose origin is opaque |
| 2 | studio | The model tab of the settings dialog as `ModelSettings.svelte`, the dialog using it; nothing else changes |

### Phase 1: the agent in the extension

Exit: from the extension's app page, with a real model and key, a
turn in a site's session runs code in the sandbox's kernel and writes a
file, read back after the offscreen document restarts; the sandbox
makes no request of its own.

| # | Where | What |
|---|---|---|
| 1 | extension | Its skeleton beside the browsing one: the build (a fixed id from its own public key), the zip on the studio's site and a help page; the service worker, the offscreen document and the sandboxed page; the store over `postMessage`; the sandbox's CSP (eval, blob workers, no connections) |
| 2 | extension | The provider stand-in (the sandbox's `stream` run in the offscreen document); the app page with `ModelSettings`; a session per site, named, opened and queued one turn at a time |

### Phase 2: captures and filters

Exit: on a dozen of the outline bench's captured pages, submitted
through the popup, the agent presents a filter for each that passes the
guards and its before-and-after check; peeks are counted.

| # | Where | What |
|---|---|---|
| 1 | extension | The popup's *Filter this site* with its warning; the capture (`activeTab`: the annotated DOM, a screenshot), saved as the site's pages; a turn started with it |
| 2 | extension | The filter format and its check; `site.try` on the saved pages; `present_filter`, the candidate kept; the agent's instructions (a skill: the format, the operators, trying before presenting, peeking) |

### Phase 3: applying, and the person's say

Exit: in the person's own Chrome, three sites submitted, previewed,
accepted, applied on later visits (a feed scrolled, a page navigated in
place), one rejected with a reason and presented again, one extended,
one forgotten.

| # | Where | What |
|---|---|---|
| 1 | extension | The content script: the stylesheet, the operators on added nodes, block rules, show hidden, the count; host permission asked at the first accept |
| 2 | extension | Notifications; preview, accept, reject with a reason; on/off, *Extend*, *Remove*, *Forget this site*, the global pause; the hint when a filter matched nothing |
| 3 | extension | The run log and the meter in the app page and the popup |

### Phase 4: how good is it

Mark by hand what's clutter on fifteen or so captured pages (feeds with
native ads, a news site, a shop, a forum), have the agent filter them,
and count what it hid that it should have, what it hid that it
shouldn't, and what it said it couldn't express. That decides whether
the format needs its next level, and whether peeking earns its keep.

## Decisions

- **A second extension,** not a mode of the browsing one: its
  permissions differ (no `debugger`; sites asked one at a time), and
  neither should widen the other's.
- **The agent in the extension,** no studio tab: an offscreen document
  and a sandboxed page.
- **A session per site,** chat-shaped, so the person's words and the
  agent's tries carry from one run to the next.
- **The person's click is the submission:** captures, not background
  reading.
- **Filters are data,** checked by the extension; code is for finding
  them, in the agent's own sandbox.
- **Done is `present_filter`,** and only the person makes a filter live.
- **The agent has no network,** and the key stays out of its page.
- **Peeking enabled,** to learn whether agents use it.

## Open questions

- How faithful a rebuilt capture is: a page's own stylesheets, closed
  shadow roots and cross-origin frames don't come with it, and whether
  the before-and-after check on captures predicts the live page is for
  phase 2 to measure.
- How large a capture can be before it should be cut (a long feed).
- The default model: the studio's, or a cheaper one by default.
- Where the code lives: `extension/` and a sibling, or both under
  `extensions/`, sharing the build and what they have in common.

## Later

- **Publishing and syncing site sessions,** as the studio does its own;
  a session per site makes each one shareable alone.
- **Talking to a site's agent** in words beyond a rejection's reason,
  and a view of its runs reusing the studio's transcript.
- **Pointing:** pick an element on the page to say "hide this" or
  "that's not an ad", as checkable constraints for the next run.
- **Shared know-how across sites** curated rather than peeked at
  (nontainer's `docs/curation.md`), or a library of other sites'
  filters, their prose removed, mounted read-only.
- **The format's next levels,** and user scripts for what rules can't
  do, opt-in.
- **Aliases** for one site on several domains (`amazon.com`,
  `amazon.de`).
- **A side panel** beside the page.
- **The Chrome Web Store,** and Firefox.
