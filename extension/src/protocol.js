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
 * @typedef {"protocol" | "hello-first" | "unknown-op" | "bad-request" | "failed"} ErrorCode
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
