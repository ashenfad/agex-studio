# Browser tabs

With the studio's browser extension in desktop Chrome, a session's
agent works in real tabs: it opens sites the person allows it, reads
them and acts in them, and reads (or acts in) a tab the person shares.
Without the extension none of it is offered. The extension lives in
this repository (`extension/`), so its protocol and the studio's tools
change together; [`extension/README.md`](../../extension/README.md)
has its mechanics, and `extension/src/protocol.js` the port's messages.

## The shape: the studio drives, the extension reaches

```text
agex.studio tab ──port──▶ extension ──▶ the session's tabs (a tab group)
 (the loop, the chat,     (registry,     and tabs the person shared
  the person's answers,    outlines,
  the grants)              actions, holds)
```

- **The agent stays in agex.studio.** The loop, the chat, the cards
  and the grants are the studio's. The extension holds no agent, no
  model and no keys: it opens, reads and acts in tabs when the studio
  asks, over a port it accepts from agex.studio only
  (`externally_connectable`, checked again by the worker against
  `STUDIO_MATCHES`, `origins.js`). Packing the studio into the
  extension would meet Manifest V3's rule against remote code (the
  kernel runs written code and esm.sh imports), give it an origin with
  none of the person's sessions, and put the loop in a service worker
  Chrome stops when idle.
- **Only the page can open the port,** so the extension never reaches
  an idle studio. The studio opens it before any call and whenever its
  tab comes back to the front (`browser-extension.svelte.js`). A port
  with no messages doesn't keep the worker alive, so while a turn runs
  the studio pings it every 20 s (`hold`), and tells it a turn is
  running (`turn`), which keeps the studio's tab from being discarded.
  What the extension has for the studio (a share from the toolbar)
  waits in its storage until the studio connects; it can nudge an open
  port with an unasked `{ event: "shares" }`.
- **The extension keeps what outlives its worker** in
  `chrome.storage.local` (`registry.js`: the sessions it was told of,
  their tabs, the shares), every change serialized through `change`.
  Tab ids don't outlive the browser, so the registry is cleared when
  the browser starts.
- **Without the extension** (`status` not `found`), the `browser` and
  `request_sites` tools aren't offered and the primer says nothing of
  them (`session.svelte.js`, `primer.js`).

## The pieces

| Where | File | What |
|---|---|---|
| extension | `background.js`, `port.js` | the worker: the studio's port (`hello` first, then ops) and the popup's messages |
| | `registry.js` | sessions, their tabs, shares, what was in front |
| | `tabs.js` | a session's tabs and their holds; shares, the popup's state |
| | `grants.js` | domains and the `declarativeNetRequest` rules that hold a tab to them |
| | `work.js` | the debugger attached with focus emulation while the agent works in a tab |
| | `outline.js`, `pages.js` | reading a tab (`read`, `scroll`, `waitFor`, `screenshot`, `goto`) |
| | `act.js` | acting by ref (`click`, `type`, `select`, `press`); stale and committing steps |
| | `popup.html`, `popup.js`, `badge.js` | the toolbar: share, stop sharing, read only or act; a shared tab's badge |
| studio | `browser-extension.svelte.js` | finding the extension, the port, the heartbeat |
| | `browser.js` | the session's tabs for the tool and the host alike; outline versions per caller |
| | `browser-tool.js`, `browser-host.js` | the `browser` tool (steps) and host object (code) |
| | `request-sites.js`, `site-requests.svelte.js`, `site-grants.js`, `site-sync.js` | asking for sites, granting them, telling the extension |
| | `browser-asks.svelte.js` | the `confirm`, `handoff` and `go-on` cards |
| | `shared-tabs.svelte.js`, `SharedTabCard.svelte` | shares from the toolbar, given to a session |
| | `skills/browsing/SKILL.md` | how the agent should go about it |

## Tabs, woken by the debugger

A session's tabs are real tabs in the person's profile, with its
logins, opened in the background (`active: false`) in a tab group
named for the session, so they never take focus and the person can
take one over at any time.

- **A hidden tab runs `fetch` and the DOM but nothing that waits for a
  frame:** no `requestAnimationFrame` or `IntersectionObserver`, timers
  about once a second, and the debugger's mouse events dropped. Many
  sites draw nothing at all in one (three of five hotel sites, when
  measured in Chrome 149).
- **So the debugger is attached with focus emulation** while the agent
  works in a tab (`work.js`, `Emulation.setFocusEmulationEnabled`;
  attaching alone doesn't do it): the tab reports `visible`, renders,
  takes trusted input and screenshots, without coming to the front. It
  is detached 20 s after the agent's last call there (`REST_MS`), and
  when the turn ends; a loop that waits on the page (`scroll`,
  `settle`) renews it so it isn't rested mid-call.
- **A window per tab doesn't work:** macOS hides a covered window
  within seconds, and a minimized one can't be screenshotted.
- **The cost** is the `debugger` permission's install warning and
  Chrome's "started debugging this browser" bar while a tab is
  attached. The tab's title starts with 🤖 meanwhile. The bar's Cancel
  stops the agent's work in every tab until the person lets it go on
  (the `go-on` card, the `resume` op).
- **Tabs belong to the top session:** the ones its agent or any of its
  delegates opened, and the ones the person shared with it. A tab
  outlives the delegate that opened it, so a delegate resumed later
  finds it again. The extension refuses a call for any other tab.

## Reading and acting

- **A page reads as an outline** (`outline.js`): its text, a line per
  block, a numbered ref on each thing that can be clicked or typed into
  (`[12] button "Check availability"`), and its state (a field's value,
  a box checked, a select's options). Photo carousels' controls are
  dropped and a run of refs alike folds into one, since an outline is
  what costs tokens. A `blocker` says when the page is a CAPTCHA or a bot
  check (a challenge over the page, not a badge in its corner), and a
  consent notice is read after the page. A screenshot is taken only
  when asked for.
- **The outline runs in the extension's isolated world** in the page:
  it sees the DOM, not the page's scripts, and keeps the elements its
  refs name there (`globalThis.__agex`) for the actions that follow.
  It walks the DOM rather than Chrome's accessibility tree: sites hide
  their page from the tree while a pop-up shows (`aria-hidden`,
  `inert`), and the tree then drops it entirely (`extension/bench`
  measures both on captured public pages).
- **An action names the outline it came from** (`version`) and is
  refused as `stale` when that isn't the page's latest, when the page
  is another document now, when the element at the ref has left the
  page, or when its name has changed. Whoever disturbed the tab, a
  collision costs a re-read, not a click on whatever now sits at that
  ref. That's why **who works in a tab is a convention**, not enforced:
  a parent gives each delegate its own tabs, and the person leaves the
  marked tab alone.
- **Input is trusted:** a click is the debugger's mouse events where
  the element shows (its center, or another point in it when that's
  covered; covered all over, as by a cookie banner, it's refused,
  naming what covers it, unless that's its own row's content), typing
  is `Input.insertText` (into a combobox's own field, the ref staying
  the box), a key its key events. A content script's events would be
  untrusted (`isTrusted: false`), which many sites ignore.
- **Refs can be named instead of numbered** (`{ name, after, kind }`
  in the tool, `page.find` in code): the first ref whose name holds the
  text, after a given line, so a long list's twin buttons don't get
  mixed up.

## The tool and the host object

The same calls, two ways (`browser.js` serves both):

- **The `browser` tool** (`browser-tool.js`): one call works in one
  tab, a list of actions in order (up to 20), as `test_app` does in the
  app's page, stopping at the first that fails. It keeps each tab's
  latest outline version for its session.
- **The `browser` host object** (`browser-host.js`): code opens tabs
  and works in them with `await`, so it fans out. agex agents act by
  writing code, and the browsing skill has them learn one site's search
  by hand, then search the rest from code with `Promise.all`: each page
  stays a variable in the code, a helper task reads it ("is a room free,
  and at what price"), and the agent sees only the table at the end.
  Delegates are for sites that need driving step by step, one each.
- **Code never asks the person.** One CAPTCHA would hold up every other
  site in a `Promise.all`, and a run's clock stops for a host call only
  up to `hostTime`. A committing step, a domain without a grant or a
  blocker comes back as an error (`codeError`) for code to report; the
  agent asks.

## Asking the person

Each ask is a card in the chat, under the live turn, from the
session's one queue (`asks.svelte.js`): one open at a time, whatever
its kind, "Not now" a result rather than an error so the turn goes on,
and the turn ending takes it back. `request_secret`'s key card was the
first; the browser adds:

| Card | The agent asks | The person answers |
|---|---|---|
| sites (`request_sites`) | to open these domains, and why | allow the ones ticked for this session, or not now |
| confirm | to take a step that commits | yes or no |
| handoff | the person's hands on a tab (a CAPTCHA, a login, a second factor); the tab comes to the front | done, or skip |
| go-on | after the debugging bar's Cancel, to work in tabs again | let it go on, or keep it stopped |
| share (the person's own, from the toolbar) | which session takes the tab | a session, read only or to act in, or not now |

- **Only the session's own agent asks.** A delegate is refused, as with
  keys: it stops and answers with its blocker (its tab, what it had
  done), the agent asks the person, then resumes it (`sessions ask
  resume=…`) with its conversation kept. Code reports a blocked site
  and the agent reruns it once the person has cleared it; a clearance
  the site sets is in the person's profile, so a new tab gets through.
- **Ask early, in one card.** `request_sites` takes a list (up to
  `SITES_MAX`): every site a task means to search, before it fans out,
  so what reaches the person mid-task is only what couldn't be planned.

## Grants and holds

- **Site access is a grant per session, by domain**, kept in the vault
  under `agent:<session>` as an agent's keys are: listed in settings
  with a revoke, copied by a fork, held by a delegate through its top
  session. A domain covers its subdomains (`marriott.com` covers
  `www.marriott.com`, where most sites redirect). `site-sync.js` gives
  each session's grants to the extension (`session`) whenever the vault
  changes and each time the port opens; a session whose grants went is
  sent none, so its tabs are held to nothing at once.
- **Every page load in a tab the agent opened is held to its grants**,
  by the browser: `declarativeNetRequest` session rules for that tab
  (`grants.js`), so a link, a redirect, a sign-in hop or a script's
  navigation to anywhere else is stopped before it loads, and `tabs`
  reports it, for the agent to ask with a sites card.
- **A tab a page opens** (`target="_blank"`, `window.open`) gets an id
  no rule names yet, and Chrome says so only after it exists
  (`webNavigation.onCreatedNavigationTarget`): the extension registers
  it to the session and closes it if it opened, or went on, anywhere
  without a grant, before the agent can read it; `onCommitted` closes
  one a redirect got past its rules. Its first requests may already
  have gone out.
- **What's held is page loads**, not the requests a page makes (its
  images, scripts, `fetch`). The extension needs no host permission of
  Chrome's: `debugger` covers reading and acting, and the studio's
  grants decide where each session may go.

## Tabs the person shares

- **The toolbar is the one way in.** The person shares the tab in
  front from the extension's popup; the share waits in the extension,
  the studio's tab comes to the front, and a card asks which session
  takes it (`shared-tabs.svelte.js`). The agent never sees the
  person's open tabs: when it needs one, it asks in words; when it
  needs a signed-in site in general, it asks for the domain and opens a
  tab of its own, signed in as the person is, with a handoff for a
  login. (The extension's `browsable` op lists shareable tabs, should a
  picker ever be wanted.)
- **Only the person's own web pages:** http and https, not a session's
  own tab (already held to its grants) nor the studio's.
- **A share is the tab on its site:** the host it was on, its
  subdomains, and for a `www.` host the bare one, never a sibling.
  Taken elsewhere, the tab is refused as `moved`, and works again once
  it's back. Each read is checked again before it's given (`stillOn`):
  still on the site, and still the same share, so a share stopped or
  given to another session meanwhile ends it.
- **The tab stays the person's.** It isn't grouped or held to the
  session's grants, needs no grant to read, is never closed, and a fork
  doesn't copy it. The toolbar's badge says it's shared and with whom;
  closing it, the popup or settings ends the share.
- **Read only, or acted in too** (`acts`, on by default: a page's
  collapsed sections, filters and forms need clicks). Read only, the
  agent may `read`, `scroll`, `waitFor` and `screenshot`, and anything
  else is refused as `read-only`. Acting, it may also click, type,
  select, press, `goto` that site or a granted domain, and hand off;
  while it acts the tab's loads are held to that site and the session's
  grants, a load stopped there goes back to the page it left, and once
  its work rests (`onRested`) the loads are the person's again. The
  card, the popup and settings each switch it.
- **A share rides the person's next message,** as a file attached
  does: a chip in the composer, named in the prompt as `[shared tab 9:
  "Inbox" · url; read only]` (`notes.js`). Which shares an agent has
  been told of is kept in this browser, as the shares are.
- **A shared tab is the top session's,** so a delegate named it works
  there as it does in the session's own tabs.

## Trust

- **Promised, whatever a page says:** a key's value, which the agent
  never holds; and the sites the agent reads and acts in, every page
  load in its own tabs held to the session's grants.
- **Guard rails, not boundaries:**
  - `confirm`: the extension reports a form submit or a click on a
    control that reads as committing (book, reserve, pay, purchase,
    send, post, publish, delete, confirm, …; `COMMITS` in `act.js`),
    and the tool refuses it without a yes. A control in another
    language, "Continue", an icon, an autosaving field or a navigation
    with side effects gets past it; a rule a machine could check (every
    submit) would confirm every search. A tab, radio or option never
    asks; a toggle asks as a button does.
  - the model's own resistance to injection, and the person keeping
    private tabs apart from sites they don't trust.
- **Sessions are the boundary.** Any page's text may be aimed at the
  agent, and what the agent sees can reach any server: a URL it opens,
  a form it fills, and outside the tabs its code's own `fetch`,
  `web.fetch`, an import, an app's requests. No check on the tools
  closes all of those, so none is promised, and nothing a tab shows is
  tracked after it's read. A private tab and sites the person doesn't
  trust belong in different sessions; the share card says so when the
  session holds grants for other sites.
- **The person's logins stay in tabs.** The extension makes no request
  of its own with their cookies. A session's own tab is signed in
  wherever the person is, which is why `confirm` applies there too.
- **What a tab shows joins the session:** it goes to the person's
  model provider and into the session's history, which syncs and
  publishes with the rest, as an upload's content does.
- **An app's agent gets no tabs;** an app may be anyone's.

## Builds and distribution

`extension/build.mjs` builds three ways, the sources copied as they
are and only the manifest differing:

- **`--site`**: the studio's download. A fixed id
  (`SITE_EXTENSION_ID`) from the committed public key `site-key.pub`
  (an unpacked id needs no private key, and none is kept); agex.studio
  only. The studio's build zips it into
  `/extension/agex-studio-extension.zip` (`EXTENSION_DOWNLOAD`, the
  `extensionDownload` plugin in `vite.config.js`), loaded unpacked as
  the help page `public/docs/browser.md` says. It doesn't update
  itself: the studio says when the version it offers is newer than the
  one found (`newer`).
- **`--dev`**: a fixed id (`DEV_EXTENSION_ID`, `dev-key.pub`) that also
  answers `localhost` and `127.0.0.1`, with dev-only ops for the tests.
- **plain**: the Chrome Web Store's, whose id the store gives
  (`STORE_EXTENSION_ID`, null until then). When it's listed, `debugger`
  would best be an optional permission asked for at the first browsing,
  so the install warning is the milder one.

The studio tries an id the person set (`ID_KEY` in `localStorage`),
then the store's, the download's and the dev build's.

## Testing

- `npx vitest run`: the units on both sides.
- `pnpm extension:test`: end to end, each build loaded into Chromium as
  a plain process (an automation protocol attached would keep the
  worker alive), a page on localhost playing the studio, and a local
  server whose log proves which loads a hold stopped.
- `extension/bench`: the outline measured on captured public pages
  (none signed in; the captures aren't committed), each read checked
  for what an agent needs there.

## Not built

- **A reload while a card waits** leaves the run with a tool call and
  no result, as `request_secret` does: whether agex-ts should keep the
  waiting call with the run, so a resume asks again.
- **Many `confirm` cards** (twenty, say) shown so they stay readable.
- **Firefox and Safari.** `externally_connectable` is Chrome's; the
  others need a content script on agex.studio relaying `postMessage`.
  The protocol is kept to messages that would cross either.
- **The extension's own fetch**, without CORS, for `curl`, `agex.fetch`
  and reading pages without OpenRouter.
- **Requests held at the network** (every request the studio's tab
  makes, to its own services and the session's grants), if a session's
  reach outside its tabs ever needs a boundary.
- **The outline**: a listing's unnamed photo links, a pop-up read after
  the page, and the sites that refuse a headless browser captured from
  a person's Chrome for the bench; the accessibility tree's names as a
  fallback.
- **A side panel**, for a session that follows the person from tab to
  tab; **a note in the publish dialog** when the session read a shared
  tab.
