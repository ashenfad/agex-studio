# The studio's browser extension

Lets a session's agent open, read and act in browser tabs, on the sites
the person allows it (see [`roadmap/browser.md`](../roadmap/browser.md)).
The agent stays in agex.studio; the extension only reaches tabs, and
answers nothing but the studio's page.

So far it is the port: the studio connects, says `hello` with the
protocol's version, and keeps the port up with `ping` (an MV3 service
worker stops after about 30 s without a message, and the port drops with
it). [`src/protocol.js`](src/protocol.js) has the messages.

## Building

```bash
pnpm extension:build             # dist/prod: the store's, agex.studio only
pnpm extension:build --dev       # dist/dev: a fixed id, and local dev servers
```

The sources are plain modules, copied as they are; only the manifest
differs. The dev build carries the public key in `dev-key.pub`, which
fixes its id (`nmkolhlloohlmpklcknknipkaedblgbe`, `DEV_EXTENSION_ID`),
and answers `http://localhost` and `http://127.0.0.1` on any port beside
agex.studio.

To try it: `chrome://extensions`, Developer mode, **Load unpacked**, and
choose `extension/dist/dev`. After a rebuild, its ↻ reloads it.

## Testing

```bash
pnpm vitest run extension        # the units
pnpm extension:test              # end to end, in Chromium
```

The end-to-end tests start Chromium as a plain process with the build
loaded (an automation protocol attached would keep the service worker
from ever going idle), and a page on localhost plays the studio. They
use Playwright's Chromium (`pnpm exec playwright install chromium`), or
`CHROME`, a path to another Chromium or Chrome for Testing: branded
Chrome ignores `--load-extension`. `HEADED=1` shows the window. Waiting
out the worker's idle stop takes them a couple of minutes.
