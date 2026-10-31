/**
 * The port between the studio and its browser extension: what each side
 * sends, shared by both (the extension's service worker imports it, and
 * the studio's client will).
 *
 * The studio opens the port (`chrome.runtime.connect(id)`); only a page
 * can, so the extension never reaches an idle studio. Each request is
 * `{ id, op, ...args }` and gets one reply with its `id`: `{ id, value }`,
 * or `{ id, error: { code, message } }`. The first request on a port is
 * `hello`, which says the studio's protocol version and gets the
 * extension's; any other op before it is refused.
 *
 * The ops after it:
 *
 * - `ping`: the heartbeat.
 * - `turn { running }`: whether a turn is running, while which the
 *   studio's tab isn't discarded.
 * - `session { session, name, domains }`: a top session's name (its tab
 *   group's title) and the domains its tabs may load (each with its
 *   subdomains, as `marriott.com` covers `www.marriott.com`), set or
 *   replaced.
 * - `sessions` → `[{ session, name, domains }]`: the sessions it has
 *   been told of (kept across the studio's absences).
 * - `open { session, url }` → `{ tab }`: a tab opened for the session.
 * - `close { session, tab }`: one of its tabs closed.
 * - `resume`: the person's cancel (Chrome's debugging bar) lifted.
 * - `show { session, tab }`: one of its tabs brought to the front, for
 *   the person's hands (the agent's work in it rested first).
 * - `tabs { session }` → `[{ id, url, title, working, blocked?, shared? }]`:
 *   its tabs, each with whether the agent is working in it (the debugger
 *   attached), the last load the extension stopped in it, and for one the
 *   person shared, the domain it was shared on.
 * - `browsable` → `[{ id, url, title }]`: the person's open tabs that
 *   could be shared, for the studio's picker (http and https pages, not
 *   a session's nor the studio's), the latest used first.
 * - `share { session, tab }` → `{ tab, domain }`: one of them shared
 *   with the session, on the host it's on now (its subdomains with it,
 *   and for a `www.` host the bare one, but no other). A shared tab stays the person's: its loads aren't held, and
 *   it's only read (`read`, `scroll`, `waitFor`, `screenshot`; anything
 *   else is refused as `read-only`), and only while it's on that host
 *   (else `moved`).
 * - `unshare { session, tab }`: a shared tab the session's no longer,
 *   left open.
 * - `shares` → `[{ tab, url, title, domain, at }]`: the tabs the person
 *   shared from the toolbar (whose popup brings the studio to the front),
 *   waiting for the studio to ask them which session takes each.
 * - `take { session, tab }` → `{ tab, domain }`: one given to the
 *   session, on the domain it was shared on; `drop { tab }`: one turned
 *   down, the tab left as it was.
 * - `read { session, tab, maxChars?, hrefs?, settle? }` → an outline: the
 *   page's text, with numbered refs on what can be clicked or typed into,
 *   each ref's `{ ref, kind, name }` (`refs`), its `version`, a `blocker` when the page is a CAPTCHA or bot check,
 *   and how many screenfuls go on `below`; `settle` first waits for the
 *   page's text to stop changing.
 * - `scroll { session, tab, to? }` → `{ top, below }`: "down" a screenful
 *   or to the "bottom", with the wheel, so lazy lists load.
 * - `goto { session, tab, url }` → `{ url, title }`: the tab sent on.
 * - `waitFor { session, tab, text | selector, timeout? }` → `{ ms }`.
 * - `screenshot { session, tab }` → `{ mime, data }`: a JPEG, base64.
 * - `click { session, tab, version, ref, confirmed? }`,
 *   `type { ..., text, submit?, clear? }`, `select { ..., value }`,
 *   `press { ..., key }` (Enter, Space, Escape, Tab, the arrows, ...) →
 *   `{ url, title, navigated?, submitted?, blocked? }`: an action on the
 *   element at `ref` in outline `version`. Refused as `stale` when the
 *   page has changed since, and as `confirm` when the step reads as
 *   committing and isn't `confirmed`.
 *
 * A port with no messages on it doesn't keep the extension's service
 * worker alive (Chrome stops it after about 30 s idle, and the port
 * drops), so the studio sends `ping` while it needs the port, and opens
 * it again when it has dropped.
 */

/** The protocol's version. A `hello` with another one is refused, and
 *  the port closed. */
export const PROTOCOL = 1;

/** The dev build's extension id, fixed by the public key in
 *  `extension/dev-key.pub`. The store's build gets its id from the
 *  Chrome Web Store. */
export const DEV_EXTENSION_ID = "nmkolhlloohlmpklcknknipkaedblgbe";

/** The store build's id, once the Chrome Web Store has given it one;
 *  until then the studio finds the dev build only.
 *  @type {string | null} */
export const STORE_EXTENSION_ID = null;

/** The pages the extension answers, as match patterns: the studio's,
 *  and in the dev build local dev servers on any port. Kept here, apart
 *  from the manifest's `externally_connectable.matches`, which the build
 *  refuses to widen past them. */
export const STUDIO_MATCHES = Object.freeze(["https://agex.studio/*"]);
export const DEV_MATCHES = Object.freeze(["http://localhost/*", "http://127.0.0.1/*"]);

/** How often the studio pings while it needs the port: well inside the
 *  service worker's 30 s idle limit. */
export const HEARTBEAT_MS = 20_000;

/**
 * @typedef {{ id: number, op: string, [arg: string]: unknown }} Request
 * @typedef {{ code: ErrorCode, message: string }} ReplyError
 * @typedef {{ id: number, value: unknown } | { id: number, error: ReplyError }} Reply
 * @typedef {"protocol" | "hello-first" | "unknown-op" | "bad-request" | "not-found" | "not-granted" | "timeout" | "stopped" | "stale" | "confirm" | "read-only" | "moved" | "failed"} ErrorCode
 */

/** What `hello` answers. @typedef {{ protocol: number, version: string }} Hello */

/**
 * An error that becomes a reply's `error`.
 */
export class ProtocolError extends Error {
    /** @param {ErrorCode} code @param {string} message */
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

/**
 * A request checked for shape: an integer `id` and a string `op`.
 *
 * @param {unknown} msg
 * @returns {Request}
 */
export function checkRequest(msg) {
    const m = /** @type {Record<string, unknown>} */ (msg);
    if (typeof msg !== "object" || msg === null || !Number.isInteger(m.id) || typeof m.op !== "string") {
        throw new ProtocolError("bad-request", "a request is { id, op, ...args }, with an integer id and a string op");
    }
    return /** @type {Request} */ (msg);
}
