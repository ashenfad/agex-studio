/**
 * Origin of the cross-origin app sandbox host (`agex-studio-apps` repo,
 * served at `apps.agex.studio` in prod).
 *
 * All iframe-creation sites in the studio source from this so we have
 * a single source of truth for "where do agent-built apps run." Also
 * used as the postMessage target origin when sending data into the
 * iframe, and as the expected `event.origin` on incoming messages.
 *
 * Dev override via `VITE_APPS_ORIGIN` env var — set this in
 * `.env.local` to point at a locally-served copy of agex-studio-apps
 * (e.g. `http://localhost:5174` when running
 * `python3 -m http.server 5174` from that repo). Without an override
 * we default to the prod origin; local dev against prod *should*
 * mostly work (CORS-wise OK for postMessage) but is hostile to
 * iteration on the bootloader itself.
 */
export const APPS_ORIGIN = (
    import.meta.env.VITE_APPS_ORIGIN ?? "https://apps.agex.studio"
).replace(/\/$/, "");

/**
 * Origin of the hidden iframes `test_app` builds: the same apps host,
 * served from another site than the studio's, so the browser runs each
 * test's page in a process of its own that exits after the test. What a
 * test's page leaves behind (Chrome keeps the decoded pixels of every
 * image a page decodes until its process exits, and a screenshot
 * decodes several) then goes with it, rather than piling up in the
 * studio's process, which an origin of the studio's own site shares.
 *
 * Set by `VITE_TEST_APPS_ORIGIN`; without it, tests run at `APPS_ORIGIN`.
 */
export const TEST_APPS_ORIGIN = (
    import.meta.env.VITE_TEST_APPS_ORIGIN ?? APPS_ORIGIN
).replace(/\/$/, "");

/** The origins app pages run at: the preview's, and the tests'. */
export const APP_ORIGINS = [...new Set([APPS_ORIGIN, TEST_APPS_ORIGIN])];

/** The origin each app iframe was pointed at, where it isn't `APPS_ORIGIN`. @type {WeakMap<object, string>} */
const _origins = new WeakMap();

/**
 * Say which origin `iframe`'s app runs at, before it's pointed there:
 * the messages it takes and sends are checked against it.
 *
 * @param {HTMLIFrameElement} iframe
 * @param {string} origin
 */
export function setFrameOrigin(iframe, origin) {
    _origins.set(iframe, origin);
}

/**
 * The origin `iframe`'s app runs at: `APPS_ORIGIN` unless set otherwise.
 *
 * @param {HTMLIFrameElement | null | undefined} iframe
 * @returns {string}
 */
export function frameOrigin(iframe) {
    return (iframe && _origins.get(iframe)) ?? APPS_ORIGIN;
}

/**
 * Security guard for inbound iframe→host messages: true only when the
 * `MessageEvent` came from the app-preview `iframe`'s window AND the
 * apps origin it was pointed at. Every place that handles unsolicited iframe
 * messages (the live preview in `AppPreview`, the ephemeral test/live-app
 * bridges in `app-control`) gates on this so the check lives once.
 *
 * @param {MessageEvent} event
 * @param {HTMLIFrameElement | null | undefined} iframe
 * @returns {boolean}
 */
export function isFromAppFrame(event, iframe) {
    return (
        !!iframe &&
        event.source === iframe.contentWindow &&
        event.origin === frameOrigin(iframe)
    );
}

/**
 * Post a message back into the app-preview `iframe`, targeting the apps
 * origin it was pointed at. No-op if the iframe is gone. Mirror of `isFromAppFrame` for the
 * outbound direction.
 *
 * @param {HTMLIFrameElement | null | undefined} iframe
 * @param {unknown} message
 */
export function replyToApp(iframe, message) {
    iframe?.contentWindow?.postMessage(message, frameOrigin(iframe));
}
