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
