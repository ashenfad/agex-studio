# Agents in the person's browser

Status: proposed (2026-10-28). A spike settled how the session's tabs
run (below; its harness and numbers are on the `spike/browser-tabs`
branch, `spike/browser/FINDINGS.md`). Three phases, each adding to a
browser extension (Chrome first) and the studio's tools; nothing in
agex-ts is needed to begin.

## Why

Some work is a person clicking through websites. Is this hotel free
from June 3 to 6, and at what price, at each of a dozen hotels? Each
site has its own search form and date picker, and none has an API
anyone can call. An agent that drives the real pages, many at once,
does it while the person does something else.

Other work is on sites the person is signed in to: a bank, a utility,
an airline account, an admin dashboard. The person can open the page;
nothing else can reach it.

The studio's agent can do neither. From a web page it fetches only what
CORS lets the studio read, and it drives only its own app, in
`test_app`'s hidden page. A browser extension can open real tabs and
drive them, and read a tab the person shares.

## The shape: the studio drives, the extension reaches

- **The agent stays in agex.studio.** One tab holds the loop, the chat,
  the questions to the person and the workspace, as now. The extension
  holds no agent, no model and no keys: it opens tabs, reads them and
  acts in them when the studio asks, over a port it accepts from
  agex.studio's origin only (`externally_connectable`).
- **Real tabs, not headless.** They run in the person's own profile,
  with its logins and history, and the person can take one over at any
  time. A session's tabs open in the background (`active: false`), in a
  tab group named for the session, so they never take focus.
- **Tabs belong to the top session:** the ones its agent or any of its
  delegates opened, and the ones the person shared with it. A tab
  outlives the delegate that opened it, so a delegate resumed later
  finds it again. The extension keeps the registry, and refuses a call
  for any other tab.
- **Who works in a tab is a convention,** not enforced. A parent gives
  each delegate its own tabs and names them in the task, and doesn't
  act in a tab a delegate is working; the person leaves alone the tab
  the agent is acting in, which the extension marks while it does (the
  tab's title, and the debugger's bar). Whoever disturbs a tab, an
  action on an outline read before the page changed fails ("the page
  changed since you read it; read it again") rather than clicking what
  now sits at that ref.
- **A page reads as an outline:** its text, with a numbered ref on each
  thing that can be clicked or typed into (`[12] button "Check
  availability"`). The agent acts by ref. A screenshot is taken when
  asked for, not at each step: a dozen sites at several steps each is
  too many images.
- **`test_app`'s vocabulary**, on a tab instead of the hidden page:
  `click`, `type`, `select`, `waitFor`, `read`, `screenshot`, and
  `goto`, and `tabs` to list the session's tabs (each one's id, title,
  url, and whether the person shared it). The same calls are tools for
  the agent's steps and a `browser` host object for its code.
- **The person's own agents only.** A session's agent and its delegates
  get tabs; an app's agent never does, since an app may be anyone's.
- **Without the extension** the studio is as it is now, and the tools
  aren't offered.

```text
agex.studio tab ──port──▶ extension ──▶ the session's tabs (a tab group)
 (the loop, the chat,     (registry,     and tabs the person shared
  the person's answers)    outlines,
                           actions)
```

## Many sites at once

agex agents act by writing code, and code fans out on its own. The
agent learns one site's search by driving it step by step (the form,
the date picker, the URL it lands on), then searches the rest from
code:

```ts
const found = await Promise.all(hotels.map(async (h) => {
  const tab = await browser.open(h.searchUrl(checkin, checkout))
  const page = await tab.read()
  if (page.blocked) return { hotel: h.name, blocked: page.blocked, tab: tab.id }
  return { hotel: h.name, ...(await availability({ page: page.text })) }
}))
```

- **Each page stays in the code,** a variable, not the agent's context:
  what the agent sees is the table at the end.
- **The judgment per page** ("is a room free, and at what price") is a
  helper agent's: a typed task the code calls, many at once.
- **Delegates are for sites that need driving step by step,** one per
  site, each with its own context. Most hotel sites take the dates in
  the URL and don't.

## Asking the person

The session's own agent asks, with a tool call; its code never does,
and its delegates don't. `request_secret` has the pattern already: the
tool call waits, the chat shows a card, the person answers there, "Not
now" is a result rather than an error so the turn goes on, and a stop
ends the wait. Its card becomes the first of a family:

| Card | The agent asks | The person answers |
|---|---|---|
| key | a key, by name and origins (`request_secret`, today's) | an entry from the vault, or not now |
| sites | to open these origins, and why ("marriott.com, hyatt.com and three more, for June 3 to 6") | allow for this session, or not now |
| tab | to see a tab the person has open | one tab from a picker, or not now |
| confirm | to take a step that commits (book, pay, send, post, delete) | yes or no |
| handoff | the person's hands on a tab: a CAPTCHA, a login, a second factor | done, or skip |

- **A blocked site is reported, not asked about where it blocks.**
  Code marks the site blocked (a CAPTCHA, a login wall) and returns the
  rest; a delegate stops and answers with the blocker (its tab, and
  what it had done). Then the agent hands the tab to the person, with a
  `handoff` or in plain words in the chat, and once they're done it
  reruns the site, or resumes the delegate (`sessions ask resume=…`) on
  its own branch with its conversation kept. A clearance the site sets
  is in the person's profile, so a new tab gets through too.
- **Code never waits on the person.** One CAPTCHA would hold up every
  other site in a `Promise.all`, and a run's clock stops for a host
  call only up to `hostTime`.
- **A delegate never asks,** as with keys today: it is refused, finishes
  and says what it needs, and the agent that asked it asks the person
  and resumes it. Each card comes from one agent, in one queue.
- **A handoff brings the tab to the front,** says what the agent needs
  done there, and waits for Done. A browser that isn't headless gets
  past what stops automation by asking the person.
- **Ask early, in one card.** `sites` takes a list: the agent asks for
  every site it means to search before it fans out, so what reaches the
  person mid-task is only what couldn't be planned (a CAPTCHA, a step
  to confirm).

## Trust

- **Site access is per session, by origin,** as an agent's keys are:
  kept in the vault under `agent:<session>`, listed in settings with a
  revoke, copied by a fork, held by a delegate through its top session.
  Chrome's host permission is a gesture inside the extension's own
  page, which a click in the studio doesn't count as, so the person
  grants it once there and the studio's grants decide what each session
  may open.
- **Every page load in a session's tab is checked,** not only the
  agent's `goto` and new tabs: a link it clicks, a redirect, a sign-in
  that hops to another domain. One to an origin the session holds no
  grant for is blocked before it loads (the extension's
  `declarativeNetRequest` session rules, by tab, kept to the studio's
  grants), and the agent is told, so it can ask with a `sites` card.
- **The person's logins stay in tabs.** The extension makes no request
  of its own with the person's cookies. A session's tab is signed in
  wherever the person is (opening marriott.com opens their account),
  which is why committing steps need a `confirm` in the session's own
  tabs too, not only in shared ones.
- **Steps that commit are confirmed.** The extension reports a form
  submit, and a click on a control whose text reads as committing
  (book, reserve, pay, purchase, send, post, delete, confirm), and the
  tool refuses either without a `confirm` answered yes. It is a
  heuristic: it catches the common steps, and the agent is told to ask
  for the rest. A delegate that meets one stops and reports it, as it
  does a CAPTCHA.
- **What a tab shows joins the session.** What the agent reads goes to
  the person's model provider, as everything in its context does, and
  into the session's history, which syncs and publishes with the rest
  of it, as an upload's content does. The person chose to share it, and
  publishing is a choice of its own: the `tab` card and the share say
  where it goes, and nothing is tracked after.
- **Sessions are the boundary.** Any page's text may be an instruction
  aimed at the agent (mail, comments, listings, or the site itself), and
  what the agent can see can reach any site it works in: a URL it
  opens, a form it fills. No check inside a session stops that, so the
  gate is which sites a session may visit, and a private tab and sites
  the person doesn't trust belong in different sessions. The share card
  says so when the session holds grants for other sites.
- **After a shared read, requests go only to granted sites.** A site's
  own owner already gets whatever the agent sends it; someone who wrote
  only part of a page (an email in a shared inbox, a review, a listing)
  can't collect anything there, and needs the agent to send it to a
  server of their own. Page loads are held to the grants already, so
  once a session's agent has read a shared tab, `curl` and `http.fetch`
  are held to them too: a request to any other origin is refused, and
  the agent can ask with a `sites` card. Before such a read nothing
  changes, so searching and calling services are as they are now.
- **What an injection can't reach:** a key's value, which the agent
  never holds, and a committing step, which waits for a `confirm`. Its
  one way left to the person's data is posting it to a granted site (a
  reply, a review), and that is a committing step.

## What the spike found

Measured on 2026-10-28 with Chrome 149 on macOS: fixture pages in a
fresh profile, then five hotel sites (Marriott, Hilton, Hyatt, IHG,
Booking.com) in the person's own Chrome, one background tab each, all
at once.

- **A hidden tab runs `fetch` and the DOM, and nothing that waits for a
  frame:** no `requestAnimationFrame`, no `IntersectionObserver`,
  timers about once a second, and the debugger's mouse events dropped.
  Three of the five real sites (Marriott, Hilton, Hyatt) drew nothing
  at all in one.
- **The debugger's focus emulation wakes it**
  (`Emulation.setFocusEmulationEnabled`; attaching alone, or
  `Page.enable`, doesn't): the tab reports `visible`, renders, takes
  trusted input, and screenshots in 30 to 70 ms, without coming to the
  front. Detaching hides it again. All five sites rendered with it.
- **A window per tab doesn't work:** macOS hides a covered window
  within seconds, and a minimized one can't be screenshotted.
- **A content script's input is untrusted** (`isTrusted: false`);
  the debugger's (`Input.insertText`, and mouse events once the tab
  renders) is trusted.
- **Every deep link took,** dates and guests, on all five sites: no
  date picker needed. IHG's month is zero-based (`qCiMy=112026` is
  December), which an agent checking that the dates show on the page
  would catch.
- **Four of five showed prices** once woken; IHG listed its hotels and
  loads their rates later.
- **No bot check** in the person's profile, five sites at once.
- **An outline is 1,500 to 4,800 tokens a page,** much of it photo
  carousels and inline text split one fragment per line; a pass over
  both should roughly halve it.
- **A port with no messages doesn't keep the extension's service
  worker alive:** it dropped once the driver went quiet. The studio's
  tab, hidden, keeps working (its timers drop to about once a second;
  the port answers in a millisecond). Only the page can open the port, so the extension can't reach an idle
  studio: whatever it has for the studio (a share from the toolbar)
  waits in the extension's storage until the studio connects again.

So the session's tabs are background tabs, with the debugger attached
and focus emulation on while the agent works in one, detached after.
The cost is the `debugger` permission's install warning and Chrome's
"started debugging this browser" bar while a tab is attached.

## Phase 1: the session's tabs

Exit: a spike. A session's agent, given the skill alone, searches five
hotel sites for one date range, with one `sites` card up front: it
reports availability and price from at least four of them correctly,
and stops before booking. A blocked site (a CAPTCHA, or one the spike
forces) is reported, handed to the person, and rerun, once from code
and once from a delegate resumed. It also measures tokens per site,
against the first spike's 1,500 to 4,800 an outline.

| # | Where | What | Needs |
|---|---|---|---|
| 1 | extension | A Manifest V3 skeleton: the port from agex.studio only, kept up with a heartbeat while a turn runs, and opened again by the studio whenever it has dropped (on its tab's return to the front, and before any call); the registry of tabs by top session, a tab group per session, the studio's tab kept from discarding during a turn; page loads in a session's tabs held to the origins the studio gives it (session rules by tab) | |
| 2 | extension | The debugger attached with focus emulation while a tab is worked in, and the tab marked; the outline (text and refs, carousels dropped and inline text joined, and a blocker when the page is one), each outline's version, an action on a stale one refused; the actions by ref (trusted, through the debugger), `goto`, `waitFor`, `screenshot`; committing steps reported | 1 |
| 3 | studio | The extension found or not; `request_secret`'s card made the first of a family; site grants per session (the `sites` card, the vault's `agent:<session>`, settings and revoke), given to the extension for the session's tabs | 1 |
| 4 | studio | The browser tools and the `browser` host object (tabs, open, act, read, close), checked against grants and the registry; the `handoff` and `confirm` cards, for the session's own agent only | 2, 3 |
| 5 | studio | A `browsing` skill (one site by hand, the rest from code; helper tasks to read the pages; delegates for sites driven step by step, each given its own tabs; one `sites` card up front; a blocker reported, handed off, rerun or resumed) and the spike | all |

## Phase 2: tabs the person shares, to read

Exit: the person signs in to a site, shares the tab, and the agent
answers a question about it. The card said where what it reads goes,
and, in a session that holds grants for other sites, that what it reads
can reach them. Afterwards a `curl` to an origin the session holds no
grant for is refused.

| # | Where | What | Needs |
|---|---|---|---|
| 1 | extension | Share from the toolbar (`activeTab`), naming a session: the share kept in the extension's storage until the studio takes it, and the studio's tab brought to the front, whose return reconnects the port; the open tabs listed to the studio for its picker, the one chosen given to the session | phase 1 |
| 2 | studio | Shares taken on each connect, a share held until its session takes it; the `tab` card and its picker, saying where what the agent reads goes, and that it can reach the session's other sites when there are any; a tab shared from the toolbar arriving in the session's inbox ("the person shared *title*, *url*") | 1 |
| 3 | studio | Once a session's agent has read a shared tab, `curl` and `http.fetch` held to its site grants: a request elsewhere refused, saying the agent can ask with a `sites` card | 2 |

A shared tab is read-only in this phase.

## Phase 3: acting in a shared tab

Exit: in a shared, signed-in tab the agent fills a form the person
asked for, and stops at its submit with a `confirm`.

Sliced once phase 2 has run: the `confirm` heuristic will have met
real sites in phase 1, and shared tabs are where a wrong step costs
most.

## Decisions

- **The studio drives, the extension reaches.** The loop, the chat and
  the person's answers stay in agex.studio; the extension only opens,
  reads and acts in tabs. Packing the studio into an extension would
  meet Manifest V3's rule against remote code (the kernel runs written
  code and esm.sh imports), give it a separate origin with none of the
  person's sessions, and put the loop in a service worker Chrome stops
  when idle.
- **Real tabs,** in the person's profile, in the background, grouped
  per session, woken by the debugger's focus emulation while the agent
  works in one (the spike: three of five hotel sites draw nothing
  without it).
- **Many sites from code first;** delegates for the sites that need
  driving step by step.
- **Only the session's own agent asks the person,** with a tool call.
  Code reports a blocked site and a delegate answers with its blocker;
  the agent asks, then reruns the site or resumes the delegate. No
  request is relayed from a delegate.
- **Tabs belong to the top session,** so they outlive a delegate.
- **Who works in a tab is a convention;** an action on a stale outline
  fails, so a collision costs a retry, not a wrong click.
- **The cards are the studio's,** grown from `request_secret`'s.
- **Site access is a grant per session, by origin,** kept with the
  agent's keys. Chrome's permission is granted once, in the extension.
- **No request carries the person's cookies;** acting as the person
  happens in a tab.
- **The gate is the sites a session may visit,** every page load in its
  tabs held to them, and its `curl` and `http.fetch` too once it has
  read a shared tab. Nothing a tab shows is tracked after it is read:
  sessions are the boundary, and publishing is the person's choice.
- **An app's agent gets no tabs.**
- **The extension lives in this repository** (`extension/`): its
  protocol and the studio's tools change together.

## Open questions

- A reload while a card waits leaves the run with a tool call and no
  result, as `request_secret` does today: whether agex-ts keeps the
  waiting call with the run, so a resume asks again.
- How `confirm` cards are shown so twenty of them stay readable, if a
  task makes that many.

## Later

- **Firefox and Safari.** `externally_connectable` is Chrome's; the
  others need a content script on agex.studio relaying `postMessage`.
  The port's protocol is kept to messages that would cross either.
- **The extension's own fetch,** without CORS, for `curl`,
  `agex.fetch` and reading pages without OpenRouter. It reads no tab,
  so it is a smaller question of trust, and could ship before the
  tabs.
- **A note in the publish dialog** when the session read a shared tab,
  if people turn out to need the reminder.
- **A side panel,** for a session that follows the person from tab to
  tab.
