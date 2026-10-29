# Agents in the person's browser

Status: proposed (2026-10-28), not started. Three phases, each adding
to a browser extension (Chrome first) and the studio's tools; nothing
in agex-ts is needed to begin.

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
- **A page reads as an outline:** its text, with a numbered ref on each
  thing that can be clicked or typed into (`[12] button "Check
  availability"`). The agent acts by ref. A screenshot is taken when
  asked for, not at each step: a dozen sites at several steps each is
  too many images.
- **`test_app`'s vocabulary**, on a tab instead of the hidden page:
  `click`, `type`, `select`, `waitFor`, `read`, `screenshot`, and
  `goto`. The same calls are tools for the agent's steps and a
  `browser` host object for its code.
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
- **What a shared tab shows is sensitive.** The person shared it because
  it is theirs. Tool results read from a shared tab are marked in the
  run: publishing leaves them out, and an export says it holds them.
- **Pages carry other people's words.** A signed-in page is full of
  them (mail, comments, listings), and any of it may be an instruction
  aimed at the agent. Once a session has read a shared tab, its
  outbound requests (`curl`, `http.fetch`, `goto`, a new tab) go only to
  origins it already holds a grant for.
- **The model sees the page.** What the agent reads goes to the
  person's model provider, as everything in its context does; the
  `tab` card and the share say so.

## What the spike has to settle

- **Background tabs.** A hidden tab doesn't render:
  `requestAnimationFrame` stops and timers are throttled, so results
  that load as the page scrolls may never load, and
  `captureVisibleTab` shows only a window's visible tab. Two ways
  around it: a small window per tab at work, so each is visible; or
  `chrome.debugger` (the DevTools protocol), which screenshots a
  hidden tab and sends trusted input, at the cost of its install
  warning and the bar it shows while attached.
- **Synthetic input.** A content script's events are `isTrusted: false`,
  and some sites ignore them. The debugger's aren't.
- **Deep links.** How many hotel sites take the dates in the URL, and
  whether an agent learns the pattern from one pass through a site's
  form.
- **Bot defences.** A real profile is the best case, but a dozen
  searches at once from one profile may trip a rate limit or a CAPTCHA;
  reporting and a handoff answer the CAPTCHA, a pace per site the rate.
- **The studio tab in the background.** While the person watches the
  session's tabs, the studio's tab is hidden: the extension sets it
  `autoDiscardable: false` while a turn runs, so Memory Saver can't
  drop it, and the open port keeps the extension's service worker
  alive.

## Phase 1: the session's tabs

Exit: a spike. A session's agent, given the skill alone, searches five
hotel sites for one date range, with one `sites` card up front: it
reports availability and price from at least four of them correctly,
and stops before booking. A blocked site (a CAPTCHA, or one the spike
forces) is reported, handed to the person, and rerun, once from code
and once from a delegate resumed. The spike also measures tokens per
site, and answers the background-tab question.

| # | Where | What | Needs |
|---|---|---|---|
| 1 | extension | A Manifest V3 skeleton: the port from agex.studio only, the registry of tabs by top session, a tab group per session, the studio's tab kept from discarding during a turn | |
| 2 | extension | The outline (text and refs, and a blocker when the page is one), the actions by ref, `goto`, `waitFor`, `screenshot`; committing steps reported | 1 |
| 3 | studio | The extension found or not; `request_secret`'s card made the first of a family; site grants per session (the `sites` card, the vault's `agent:<session>`, settings and revoke) | 1 |
| 4 | studio | The browser tools and the `browser` host object (open, act, read, close), checked against grants and the registry; the `handoff` and `confirm` cards, for the session's own agent only | 2, 3 |
| 5 | studio | A `browsing` skill (one site by hand, the rest from code; helper tasks to read the pages; delegates for sites driven step by step; one `sites` card up front; a blocker reported, handed off, rerun or resumed) and the spike | all |

## Phase 2: tabs the person shares, to read

Exit: the person signs in to a site, shares the tab, and the agent
answers a question about it; publishing the session leaves what it read
out, and its requests afterwards go only to origins it was granted.

| # | Where | What | Needs |
|---|---|---|---|
| 1 | extension | Share from the toolbar (`activeTab`), naming a session; the open tabs listed to the studio for its picker, the one chosen given to the session | phase 1 |
| 2 | studio | The `tab` card and its picker; a tab shared from the toolbar arriving in the session's inbox ("the person shared *title*, *url*") | 1 |
| 3 | studio | Sensitive results: marked in the run, left out of a publish, named by an export | 2 |
| 4 | studio | After a shared read, outbound requests limited to granted origins | 2 |

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
  per session.
- **Many sites from code first;** delegates for the sites that need
  driving step by step.
- **Only the session's own agent asks the person,** with a tool call.
  Code reports a blocked site and a delegate answers with its blocker;
  the agent asks, then reruns the site or resumes the delegate. No
  request is relayed from a delegate.
- **Tabs belong to the top session,** so they outlive a delegate.
- **The cards are the studio's,** grown from `request_secret`'s.
- **Site access is a grant per session, by origin,** kept with the
  agent's keys. Chrome's permission is granted once, in the extension.
- **No request carries the person's cookies;** acting as the person
  happens in a tab.
- **An app's agent gets no tabs.**
- **The extension lives in this repository** (`extension/`): its
  protocol and the studio's tools change together.

## Open questions

- Debugger or a window per tab at work (the spike).
- A reload while a card waits leaves the run with a tool call and no
  result, as `request_secret` does today: whether agex-ts keeps the
  waiting call with the run, so a resume asks again.
- Whether sensitive results also stay out of sync, or only out of
  publishing: sync goes to the person's own private repo.
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
- **A side panel,** for a session that follows the person from tab to
  tab.
