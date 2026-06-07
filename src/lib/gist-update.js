/**
 * Update-checking for sessions imported from a gist source.
 *
 * When a session is opened from a published gist (`/run/?gist=…`), we
 * record where it came from + which revision we imported. Later we can
 * occasionally ask GitHub whether the gist has a newer revision and, if
 * so, surface an "update available" affordance.
 *
 * Scope (slice a — foundation, no UI):
 *   - per-branch import record in localStorage (mirrors the publisher-
 *     side `agex-session-gist-<branch>` mapping in sessions.js)
 *   - pure parse / compare helpers (unit-tested)
 *   - `checkGistUpdate` — lazy, cached, non-throwing gist-revision poll
 *
 * Only `?gist=` shorthand sources are tracked: arbitrary `?src=` URLs
 * have no revision concept, and 4-part (SHA-pinned) shorthands are
 * intentionally frozen (gallery submissions) so they're recorded but
 * never polled.
 */

/** localStorage key prefix: import provenance + update state per branch.
 *  Parallel to `agex-session-gist-` (the publisher-side mapping). */
const SESSION_IMPORT_KEY_PREFIX = "agex-session-import-";

/** How long a check result is considered fresh — checks are skipped
 *  inside this window (per session) so a foreground revisit doesn't ping
 *  GitHub every time. 12h keeps us far under the 60 req/hr unauth cap. */
export const CHECK_TTL_MS = 12 * 60 * 60 * 1000;

const GIST_API = "https://api.github.com/gists/";

/**
 * @typedef {Object} ImportInfo
 * @property {string} gistId      - source gist id (hex)
 * @property {string} user        - gist owner (for reconstructing URLs)
 * @property {string} slug        - bundle filename slug
 * @property {boolean} pinned      - true for SHA-pinned (frozen) sources
 * @property {string|null} importedRevision      - gist revision SHA we imported
 * @property {string|null} importedHead          - kvgit HEAD at import (pristine check)
 * @property {string|null} latestRevision        - latest revision seen by a check
 * @property {number} lastCheckedAt              - epoch ms of last poll (0 = never)
 * @property {string|null} lastSeenUpdateRevision - latest revision the user has seen (badge)
 * @property {string|null} ignoredRevision       - revision the user dismissed
 * @property {boolean} deleted     - true once the gist 404s
 */

function _key(branch) {
    return SESSION_IMPORT_KEY_PREFIX + branch;
}

/** Read the import record for `branch`, or null. */
export function getImportInfo(branch) {
    try {
        const raw = localStorage.getItem(_key(branch));
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed.gistId === "string" ? parsed : null;
    } catch {
        return null;
    }
}

/** Persist the import record for `branch`. */
export function setImportInfo(branch, info) {
    try {
        localStorage.setItem(_key(branch), JSON.stringify(info));
    } catch {
        // Quota / disabled storage — non-fatal; update-check just won't
        // persist for this branch.
    }
}

/** Drop the import record for `branch` (called on session delete). */
export function removeImportInfo(branch) {
    try {
        localStorage.removeItem(_key(branch));
    } catch {
        // ignore
    }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const _USER_RE = /^[\w.-]+$/;
const _ID_RE = /^[a-f0-9]+$/i;
const _SLUG_RE = /^[a-z0-9-]{1,50}$/i;
const _SHA_RE = /^[a-f0-9]{40}$/i;

/**
 * Parse a `?gist=` shorthand into a source record. Mirrors sessions.js's
 * accepted forms:
 *   - `USER/ID/SLUG`       → HEAD-tracking (pollable)
 *   - `USER/ID/SHA/SLUG`   → SHA-pinned (frozen; recorded, never polled)
 * Returns null for anything else (e.g. an arbitrary `?src=` URL).
 *
 * @param {unknown} shorthand
 * @returns {{ user: string, id: string, slug: string, pinned: boolean, sha: string|null } | null}
 */
export function parseGistSource(shorthand) {
    if (typeof shorthand !== "string") return null;
    const parts = shorthand.split("/");
    if (parts.length === 3) {
        const [user, id, slug] = parts;
        if (!_USER_RE.test(user) || !_ID_RE.test(id) || !_SLUG_RE.test(slug)) {
            return null;
        }
        return { user, id, slug, pinned: false, sha: null };
    }
    if (parts.length === 4) {
        const [user, id, sha, slug] = parts;
        if (
            !_USER_RE.test(user) ||
            !_ID_RE.test(id) ||
            !_SHA_RE.test(sha) ||
            !_SLUG_RE.test(slug)
        ) {
            return null;
        }
        return { user, id, slug, pinned: true, sha };
    }
    return null;
}

/** Extract the latest revision SHA from a GitHub gist API response. */
export function latestRevisionOf(gistJson) {
    if (
        gistJson &&
        Array.isArray(gistJson.history) &&
        gistJson.history[0] &&
        typeof gistJson.history[0].version === "string"
    ) {
        return gistJson.history[0].version;
    }
    return null;
}

/** True if a newer, non-dismissed revision is available. Drives the
 *  drawer card's "update available" marker + action. */
export function hasUpdate(info) {
    if (!info || info.pinned || info.deleted) return false;
    const { latestRevision, importedRevision, ignoredRevision } = info;
    if (!latestRevision || !importedRevision) return false;
    return (
        latestRevision !== importedRevision && latestRevision !== ignoredRevision
    );
}

/** True if there's an available update the user hasn't seen yet. Drives
 *  the drawer-button badge (cleared once the drawer is opened). */
export function isUnviewed(info) {
    return hasUpdate(info) && info.latestRevision !== info.lastSeenUpdateRevision;
}

// ---------------------------------------------------------------------------
// Record construction + the poll
// ---------------------------------------------------------------------------

/** Build the initial import record from a parsed gist source. For a
 *  pinned source the revision is known up front; for a HEAD-tracking
 *  source it's left null and the first `checkGistUpdate` baselines it. */
export function makeImportInfo(source, importedHead) {
    return {
        gistId: source.id,
        user: source.user,
        slug: source.slug,
        pinned: !!source.pinned,
        importedRevision: source.pinned ? source.sha : null,
        importedHead: importedHead ?? null,
        latestRevision: source.pinned ? source.sha : null,
        lastCheckedAt: 0,
        lastSeenUpdateRevision: null,
        ignoredRevision: null,
        deleted: false,
    };
}

/**
 * Poll the gist for a newer revision and update the stored record.
 * Lazy (skips if checked within `CHECK_TTL_MS`, unless `force`),
 * non-throwing (network/rate-limit errors leave the cached record
 * intact). On the first successful check of a HEAD-tracking import,
 * `importedRevision` is baselined to the current latest (so we only
 * flag revisions that land *after* import).
 *
 * @param {string} branch
 * @param {{ force?: boolean, now?: number, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<ImportInfo|null>} the (possibly updated) record
 */
export async function checkGistUpdate(branch, opts = {}) {
    const {
        force = false,
        now = Date.now(),
        fetchImpl = fetch,
        pat = null,
        importInfo = null,
    } = opts;
    // Callers that already hold the record (e.g. the sweep below) pass it
    // to skip a redundant localStorage read.
    const info = importInfo || getImportInfo(branch);
    if (!info || info.pinned || info.deleted) return info;
    if (!force && info.lastCheckedAt && now - info.lastCheckedAt < CHECK_TTL_MS) {
        return info;
    }
    // A configured PAT lifts the rate limit (60 → 5000/hr). `token`
    // scheme matches gist-publish.js. Unauthenticated otherwise.
    const headers = { Accept: "application/vnd.github+json" };
    if (pat) headers.Authorization = `token ${pat}`;
    let resp;
    try {
        resp = await fetchImpl(GIST_API + info.gistId, { headers });
    } catch {
        return info; // network error — leave cached, retry next time
    }
    if (resp.status === 404) {
        const next = { ...info, deleted: true, lastCheckedAt: now };
        setImportInfo(branch, next);
        return next;
    }
    if (!resp.ok) {
        // Rate-limited (403) or transient — back off without bumping
        // lastCheckedAt so we retry on the next foreground rather than
        // waiting out the full TTL.
        return info;
    }
    let json;
    try {
        json = await resp.json();
    } catch {
        return info;
    }
    const latest = latestRevisionOf(json);
    if (!latest) return info;
    const next = { ...info, latestRevision: latest, lastCheckedAt: now };
    // First check of a HEAD-tracking import establishes the baseline.
    if (!next.importedRevision) next.importedRevision = latest;
    setImportInfo(branch, next);
    return next;
}

/** Mark the given branches' available updates as seen — clears the
 *  drawer-button badge without dismissing the per-card marker. Call when
 *  the session drawer opens. */
export function markUpdatesSeen(branches) {
    for (const branch of branches) {
        const info = getImportInfo(branch);
        if (info && hasUpdate(info)) {
            setImportInfo(branch, {
                ...info,
                lastSeenUpdateRevision: info.latestRevision,
            });
        }
    }
}

/** Dismiss the current update for `branch` (the card "ignore this
 *  version" action) — suppresses the marker/badge until a *newer*
 *  revision lands. */
export function ignoreUpdate(branch) {
    const info = getImportInfo(branch);
    if (info && info.latestRevision) {
        setImportInfo(branch, { ...info, ignoredRevision: info.latestRevision });
    }
}
