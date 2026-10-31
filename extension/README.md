# The studio's browser extension

Lets a session's agent open, read and act in browser tabs, on the sites
the person allows it (see [`roadmap/browser.md`](../roadmap/browser.md)).
The agent stays in agex.studio; the extension only reaches tabs, and
answers nothing but the studio's page.

The studio connects, says `hello` with the protocol's version, and keeps
the port up with `ping` (an MV3 service worker stops after about 30 s
without a message, and the port drops with it).
[`src/protocol.js`](src/protocol.js) has the messages.

Over the port the studio tells the extension each top session's name
and granted domains (`session`; each covers its subdomains), and opens,
lists and closes its tabs (`open`, `tabs`, `close`):

- **A session's tabs open in the background** of the studio's window,
  in a tab group with the session's name. A tab one of its pages opens
  is the session's too, and is sent behind if it took the front (a
  popup window gives the focus back to the window that had it).
- **Every page load in them is held to the session's domains** by
  `declarativeNetRequest` session rules for that tab: a link, a
  redirect, a script's navigation. A load to anywhere else is stopped
  before it reaches the site, and `tabs` reports it. A tab a page opens
  is held as soon as the browser tells of it, then closed if it opened,
  or has gone on, anywhere without a grant; its first requests may
  already have gone out. A page's own requests (images, scripts, its
  `fetch`) aren't held.
- **The person's own tabs are never held**, nor listed.

And reads them (`read`, `waitFor`, `screenshot`) and sends them on
(`goto`):

- **While the agent works in a tab, the debugger is attached** with
  focus emulation on, so the background tab renders as if it were in
  front: frames, observers, lazy lists, screenshots. It is detached 20 s
  after the agent's last call there, and when the turn ends. Chrome
  shows its "started debugging this browser" bar meanwhile, and the
  tab's title starts with 🤖. The bar's Cancel stops the agent's work
  in every tab until the next turn.
- **A page reads as an outline:** its text, a line per block, with a
  numbered ref on each thing that can be clicked or typed into
  (`[12] button "Reserve"`), and its state (a field's value, a box
  checked, a select's options). Photo carousels' controls are dropped,
  and a row of refs alike folds into one. Each read has a `version`, and
  the outline's `blocker` says when the page is a CAPTCHA or a bot check.
- **The outline runs in the extension's isolated world** in the page:
  it sees the DOM, not the page's scripts, and keeps the elements its
  refs name there for the actions that follow.

And acts in them, by an outline's refs (`click`, `type`, `select`):

- **Input is trusted:** a click is the debugger's mouse events at the
  element's center, typing its `Input.insertText` (and Enter, with
  `submit`). An element something else covers there is refused, naming
  what covers it.
- **An action names its outline's `version`,** and is refused as
  `stale` when that isn't the page's latest, when the page is another
  document now, or when the element at its ref has left the page (a
  re-render): the agent reads the page again.
- **A step that reads as committing is refused as `confirm`** unless
  the call says `confirmed: true`: a click on a control, or a form
  submit whose submitting button, says book, reserve, pay, purchase,
  buy, checkout, place order, send, post, publish, delete or confirm.
  A guard rail, not a boundary: a control labelled otherwise gets past.
- **The studio's tab isn't discarded** while a turn runs (`turn`).

The registry (sessions, their tabs) is in `chrome.storage.local`, so it
outlives the worker's idle stops and the extension's own updates and
reloads, which clear the tabs' rules and leave the tabs open: each time
the worker starts, it holds the registry's tabs again. When the browser
starts, the registry is cleared, since tab ids don't outlive it.

## Building

```bash
pnpm extension:build             # dist/prod: the store's, agex.studio only
pnpm extension:build --site      # dist/site: the studio's download, a fixed id
pnpm extension:build --dev       # dist/dev: a fixed id, and local dev servers
```

The sources are plain modules, copied as they are, with the icons in
`icons/` (drawn from the studio's favicon by `node extension/icons.mjs`,
and committed); only the manifest differs. The site and dev builds each carry a public key, which fixes
the id an unpacked copy has: `site-key.pub` gives
`odphfgepbkbbiognjbkdjllabphmdhhg` (`SITE_EXTENSION_ID`), `dev-key.pub`
`nmkolhlloohlmpklcknknipkaedblgbe` (`DEV_EXTENSION_ID`). Neither needs
its private key, and neither's is kept. The dev build also answers
`http://localhost` and `http://127.0.0.1` on any port beside
agex.studio, and has the dev-only ops.

The studio's build zips the site build into its download,
`dist/extension/agex-studio-extension.zip` (`EXTENSION_DOWNLOAD`), one
`agex-studio` folder to load unpacked, as its help page says
([`public/docs/browser.md`](../public/docs/browser.md)); its dev server
builds it afresh for each request. It doesn't update itself: the studio
tells the person when the version it offers is newer than theirs.

To try it: `chrome://extensions`, Developer mode, **Load unpacked**, and
choose `extension/dist/dev`. After a rebuild, its ↻ reloads it.

## Testing

```bash
pnpm vitest run extension        # the units
pnpm extension:test              # end to end, in Chromium
```

The end-to-end tests start Chromium as a plain process with the build
loaded (an automation protocol attached would keep the service worker
from ever going idle), and a page on localhost plays the studio. The
tab tests serve a fixture site on `127.0.0.1`, granted, and on
`localhost`, not, and check by the server's own log that a held load
never reached it. They
use Playwright's Chromium (`pnpm exec playwright install chromium`), or
`CHROME`, a path to another Chromium or Chrome for Testing: branded
Chrome ignores `--load-extension`. `HEADED=1` shows the window. Waiting
out the worker's idle stop takes them a couple of minutes.
