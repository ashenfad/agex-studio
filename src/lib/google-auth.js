/**
 * Google OAuth 2.0 via Google Identity Services (implicit flow).
 *
 * Manages token lifecycle: interactive consent, silent refresh, and
 * pushing the access token to the Pyodide worker.
 *
 * Scopes are additive — start with Calendar, add Drive/Gmail later
 * via incremental authorization.
 */

import { setGoogleToken } from "./pyodide.js";

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || "";

const DEFAULT_SCOPES = [
    "https://www.googleapis.com/auth/calendar",
];

const STORAGE_KEY = "agex-google-auth";
const REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh 5 min before expiry

/** @type {((s: GoogleAuthState) => void)[]} */
let subscribers = [];

/**
 * @typedef {Object} GoogleAuthState
 * @property {boolean} connected
 * @property {string|null} token
 * @property {number|null} expiresAt - ms timestamp
 * @property {string[]} scopes
 */

/** @type {GoogleAuthState} */
let state = loadState();

/** @type {any} */
let tokenClient = null;

/** @type {number|null} */
let refreshTimer = null;

/** @type {((resp: any) => void)|null} */
let pendingResolve = null;

/** Whether a token refresh is needed (stale session on page load). */
let needsRefresh = false;

function loadState() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const saved = JSON.parse(raw);
            return {
                connected: false,
                token: null,
                expiresAt: null,
                scopes: saved.scopes || [...DEFAULT_SCOPES],
            };
        }
    } catch {}
    return {
        connected: false,
        token: null,
        expiresAt: null,
        scopes: [...DEFAULT_SCOPES],
    };
}

function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
        scopes: state.scopes,
    }));
}

function notify() {
    for (const fn of subscribers) fn(state);
}

function update(/** @type {Partial<GoogleAuthState>} */ patch) {
    state = { ...state, ...patch };
    notify();
}

/** Svelte-compatible store. */
export const googleAuthStore = {
    subscribe(fn) {
        subscribers.push(fn);
        fn(state);
        return () => {
            subscribers = subscribers.filter((s) => s !== fn);
        };
    },
};

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
 * Handle a token response from GIS.
 * @param {any} response
 */
async function handleTokenResponse(response) {
    if (response.error) {
        if (pendingResolve) {
            pendingResolve(response);
            pendingResolve = null;
        }
        return;
    }

    const expiresAt = Date.now() + (response.expires_in * 1000);

    update({
        connected: true,
        token: response.access_token,
        expiresAt,
    });

    saveState();
    setGoogleToken(response.access_token);
    scheduleRefresh(expiresAt);

    if (pendingResolve) {
        pendingResolve(response);
        pendingResolve = null;
    }
}

/**
 * Schedule a silent token refresh before expiry.
 * @param {number} expiresAt
 */
function scheduleRefresh(expiresAt) {
    if (refreshTimer) clearTimeout(refreshTimer);
    const delay = Math.max(0, expiresAt - Date.now() - REFRESH_MARGIN_MS);
    refreshTimer = setTimeout(() => silentRefresh(), delay);
}

/**
 * Attempt silent re-auth (no user interaction).
 */
function silentRefresh() {
    if (!tokenClient) return;
    tokenClient.requestAccessToken({ prompt: "" });
}

/**
 * Create/recreate the token client with current settings.
 */
function ensureTokenClient() {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: state.scopes.join(" "),
        include_granted_scopes: true,
        callback: handleTokenResponse,
    });
}

/**
 * Whether Google auth is available (Client ID configured).
 * @returns {boolean}
 */
export function isGoogleAvailable() {
    return CLIENT_ID.length > 0;
}

/**
 * Connect to Google (interactive consent).
 * @returns {Promise<boolean>} true if connected
 */
export async function connect() {
    if (!CLIENT_ID) {
        throw new Error("VITE_GOOGLE_CLIENT_ID not configured");
    }

    await loadGIS();
    ensureTokenClient();

    return new Promise((resolve) => {
        pendingResolve = (response) => {
            resolve(!response.error);
        };
        tokenClient.requestAccessToken();
    });
}

/**
 * Disconnect from Google and revoke the token.
 */
export function disconnect() {
    if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
    }

    if (state.token) {
        window.google?.accounts?.oauth2?.revoke(state.token);
    }

    update({
        connected: false,
        token: null,
        expiresAt: null,
    });

    localStorage.removeItem(STORAGE_KEY);
    setGoogleToken(null);
    tokenClient = null;
}

/**
 * Prepare for silent restore on page load.
 * Doesn't open a popup — just loads GIS and marks that a refresh is
 * needed. The actual token refresh happens on the next user gesture
 * via refreshIfNeeded().
 * @returns {Promise<boolean>} true if a previous session was found
 */
export async function tryRestore() {
    if (!CLIENT_ID) return false;

    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return false;

    try {
        await loadGIS();
        ensureTokenClient();
        needsRefresh = true;
        return true;
    } catch {
        return false;
    }
}

/**
 * Refresh the Google token if a previous session exists but the token
 * is stale. Call this from a user-gesture context (e.g. click/submit)
 * to avoid popup blockers.
 * @returns {Promise<boolean>} true if refreshed (or already valid)
 */
export async function refreshIfNeeded() {
    if (!needsRefresh) return state.connected;
    if (!tokenClient) return false;

    needsRefresh = false;

    return new Promise((resolve) => {
        pendingResolve = (response) => {
            resolve(!response.error);
        };
        tokenClient.requestAccessToken({ prompt: "" });
    });
}
