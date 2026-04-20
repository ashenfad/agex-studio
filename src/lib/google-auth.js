/**
 * Google OAuth 2.0 via Google Identity Services (implicit token flow).
 *
 * On-demand access-token fetch for Drive imports. No persistent state:
 * the token exists only in the scope of the requesting call. After the
 * caller finishes using it (typically a picker + download sequence),
 * the reference is dropped and the token expires naturally within ~1
 * hour.
 *
 * Consent is cached by Google (typically 6 months), so the second and
 * subsequent requestAccessToken() calls usually resolve silently or
 * with a very brief popup flash.
 */

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || "";

// Drive picker needs drive.file scope (files the user picks). We don't
// persist any other Google scopes — each integration that needs Google
// should request its own scopes at action time.
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

/** @type {any} GIS token client instance, created lazily */
let tokenClient = null;

/** @type {((resp: any) => void)|null} */
let pendingResolve = null;

/**
 * Whether Google auth is available (Client ID configured at build time).
 * @returns {boolean}
 */
export function isGoogleAvailable() {
    return CLIENT_ID.length > 0;
}

/**
 * Load the Google Identity Services script if not already loaded.
 * @returns {Promise<void>}
 */
function loadGIS() {
    if (window.google?.accounts?.oauth2) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://accounts.google.com/gsi/client";
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("Failed to load Google Identity Services"));
        document.head.appendChild(script);
    });
}

/**
 * Request a Google access token with the given scopes.
 * If consent was granted previously (and hasn't expired), the popup
 * resolves silently; otherwise the user sees the consent screen.
 *
 * @param {string[]} [scopes] - OAuth scopes to request. Defaults to drive.file.
 * @returns {Promise<string|null>} Access token, or null if user cancelled.
 */
export async function requestAccessToken(scopes = [DRIVE_SCOPE]) {
    if (!CLIENT_ID) {
        throw new Error("VITE_GOOGLE_CLIENT_ID not configured");
    }

    await loadGIS();

    // Recreate the client each call so scope changes are picked up
    tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: scopes.join(" "),
        include_granted_scopes: true,
        callback: (response) => {
            if (pendingResolve) {
                pendingResolve(response);
                pendingResolve = null;
            }
        },
    });

    return new Promise((resolve) => {
        pendingResolve = (response) => {
            if (response.error) {
                resolve(null);
            } else {
                resolve(response.access_token);
            }
        };
        tokenClient.requestAccessToken();
    });
}
