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
 * Security guard for inbound iframe→host messages: true only when the
 * `MessageEvent` came from the app-preview `iframe`'s window AND the
 * expected apps origin. Every place that handles unsolicited iframe
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
        event.origin === APPS_ORIGIN
    );
}

/**
 * Post a message back into the app-preview `iframe`, targeting the apps
 * origin. No-op if the iframe is gone. Mirror of `isFromAppFrame` for the
 * outbound direction.
 *
 * @param {HTMLIFrameElement | null | undefined} iframe
 * @param {unknown} message
 */
export function replyToApp(iframe, message) {
    iframe?.contentWindow?.postMessage(message, APPS_ORIGIN);
}
