/**
 * Publish an agex-studio bundle as a secret GitHub Gist.
 *
 * The artifact lands as a single-file gist: ``<slug>.agex.b64``
 * (the full bundle bytes base64-encoded).  Gists don't accept
 * binary file content directly — everything stored is text — so
 * the bundle round-trips through base64.  The recipient runtime
 * detects the ``.b64`` suffix and decodes before importing.
 *
 * After creation we POST a markdown comment carrying the human
 * description, the agex.studio runtime link, and a manifest table
 * (commits / blobs / nodes / sizes) so anyone landing on the raw
 * gist page sees a readable preview.  GitHub flattens newlines
 * in the gist description field, so we keep the description to a
 * single line (just the artifact name) and let the comment carry
 * everything else.
 */

import { formatBytes } from "./bytes.js";

/**
 * @typedef {Object} GistPublishResult
 * @property {string} gistId         - the gist's id (hex string)
 * @property {string} gistHtmlUrl    - the human-facing GitHub URL
 *     (e.g., https://gist.github.com/<user>/<id>) for the publisher
 *     to inspect / rename / delete
 * @property {string} bundleRawUrl   - the raw URL of the bundle file
 *     (unversioned — serves whatever the gist's HEAD is)
 * @property {string} runtimeUrl     - the agex.studio URL recipients
 *     open to load this artifact (HEAD-tracking; updates if the
 *     publisher later edits the gist)
 * @property {string} gistCommit     - the gist's commit SHA at publish
 *     time, or "" if the GitHub API response didn't include history.
 *     Use with `runtimeUrlPinned` when immutability matters.
 * @property {string} runtimeUrlPinned - the immutable variant of
 *     `runtimeUrl` — embeds `gistCommit` so the resolved bundle
 *     bytes can never change after this publish. Falls back to
 *     `runtimeUrl` when `gistCommit` is unavailable. Used by the
 *     gallery-submission flow.
 * @property {string} slug             - the gist's filename slug (no
 *     `.agex.b64` extension). Callers persist this alongside
 *     `gistId` so subsequent updates can preserve the share URL.
 * @property {boolean} updated         - `true` if this publish
 *     PATCHed an existing gist; `false` if it created a new one
 *     (either the first publish, or a 404 fallback after the
 *     stored gist was deleted on github.com).
 */

class GistPublishError extends Error {
    /**
     * @param {string} message - user-facing message
     * @param {number} status  - HTTP status code, or 0 for non-HTTP errors
     * @param {string} [body]  - raw response body for debugging
     */
    constructor(message, status, body = "") {
        super(message);
        this.name = "GistPublishError";
        this.status = status;
        this.body = body;
    }
}

/**
 * Convert a Uint8Array to a base64 string.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function uint8ArrayToBase64(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

/**
 * Derive a URL- and filename-safe slug from a free-form session
 * label.  Lowercase, non-alphanumeric runs collapse to single
 * hyphens, ends are trimmed, capped to ``max`` chars (default 50)
 * with any cut-mid-word trailing hyphen stripped after the cap.
 * Empty input or all-special-chars falls back to ``"session"``.
 *
 * Same shape as ``triggerDownload``'s file-naming logic in
 * ``SessionDrawer.svelte`` so a published gist's filename mirrors
 * what the user would see if they exported the same session
 * locally.
 *
 * @param {string} label
 * @param {number} [max=50]
 * @returns {string}
 */
function slugify(label, max = 50) {
    let s = (label || "")
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "");
    if (s.length > max) {
        s = s.slice(0, max).replace(/-+$/, "");
    }
    return s || "session";
}

/**
 * Publish a bundle as a secret gist.
 *
 * When `existingGistId` is supplied, PATCHes the existing gist
 * instead of creating a new one — preserving the share URL so
 * recipients with the old link auto-pick-up the update. If the
 * gist no longer exists (404), the call transparently falls back
 * to POST (creating a new gist with a freshly-slugified filename).
 *
 * @param {{
 *   pat: string,
 *   bytes: Uint8Array,
 *   manifest: object,
 *   name?: string,
 *   description?: string,
 *   public?: boolean,
 *   origin?: string,
 *   existingGistId?: string,
 *   existingSlug?: string,
 * }} options
 * @returns {Promise<GistPublishResult>}
 * @throws {GistPublishError}
 */
export async function publishGistBundle({
    pat,
    bytes,
    manifest,
    name = "",
    description = "",
    public: isPublic = false,
    origin = typeof window !== "undefined" ? window.location.origin : "",
    existingGistId = "",
    existingSlug = "",
}) {
    if (!pat) {
        throw new GistPublishError(
            "GitHub Personal Access Token is missing. Add one in Settings.",
            0,
        );
    }
    if (!bytes || bytes.length === 0) {
        throw new GistPublishError("Bundle is empty.", 0);
    }

    const b64 = uint8ArrayToBase64(bytes);

    // Slug is derived from the name so the gist's filename (and the
    // share URL's third segment) carries the artifact's human label
    // rather than a generic ``bundle``.  A publisher with many gists
    // in their profile can scan them by filename instead of having
    // to read every description.
    //
    // When updating an existing gist we PRESERVE the original slug —
    // the share URL embeds that slug, so renaming the gist's
    // filename would 404 every link recipients already have. The
    // gist's `description` still tracks the current name; only the
    // bytes/URL stay stable.
    const effectiveName = name || "agex-studio artifact";
    // `slug` / `bundleFilename` reflect the FINAL filename we land
    // on after PATCH-or-fallback. Initialized for the PATCH case;
    // the POST-fallback path below overwrites them if it fires.
    let slug = (existingGistId && existingSlug) || slugify(effectiveName);
    let bundleFilename = `${slug}.agex.b64`;

    const headers = {
        Accept: "application/vnd.github+json",
        Authorization: `token ${pat}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
    };

    // POST and PATCH share the body shape; PATCH ignores `public`
    // (gist privacy is fixed at creation), but including it is
    // harmless and keeps the two paths symmetric.
    //
    // Description is a single line — just the artifact name —
    // because GitHub flattens newlines in the description field.
    // The full description prose, runtime link, and manifest
    // table all live in a markdown comment posted after creation.
    const body = {
        description: effectiveName,
        public: !!isPublic,
        files: {
            [bundleFilename]: { content: b64 },
        },
    };

    // Try PATCH first when an existing gist ID is known. On 404
    // (gist deleted on github.com out from under us), transparently
    // fall back to POST so the publish flow always lands a gist.
    let resp;
    let updated = false;
    if (existingGistId) {
        try {
            resp = await fetch(
                `https://api.github.com/gists/${existingGistId}`,
                {
                    method: "PATCH",
                    headers,
                    body: JSON.stringify(body),
                },
            );
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            throw new GistPublishError(
                `Network error contacting api.github.com: ${detail}`,
                0,
            );
        }
        if (resp.status === 404) {
            // Gist gone — clear our state-local "exists" bit and
            // proceed to the POST path below. Don't surface this as
            // an error; it's the expected recovery path when a user
            // has deleted the gist on github.com but localStorage
            // still remembers it.
            existingGistId = "";
        } else if (!resp.ok) {
            const raw = await resp.text();
            throw new GistPublishError(
                githubErrorMessage(resp.status, raw),
                resp.status,
                raw,
            );
        } else {
            updated = true;
        }
    }

    if (!existingGistId) {
        // POST path — either no prior gist, or PATCH 404 fell
        // through. Re-slug from the current name (the original
        // slug only mattered when updating) and overwrite the
        // slug/filename so downstream URL construction picks up
        // the fresh values.
        slug = slugify(effectiveName);
        bundleFilename = `${slug}.agex.b64`;
        const freshBody = {
            ...body,
            files: { [bundleFilename]: { content: b64 } },
        };
        try {
            resp = await fetch("https://api.github.com/gists", {
                method: "POST",
                headers,
                body: JSON.stringify(freshBody),
            });
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            throw new GistPublishError(
                `Network error contacting api.github.com: ${detail}`,
                0,
            );
        }
    }

    if (!resp.ok) {
        const raw = await resp.text();
        throw new GistPublishError(
            githubErrorMessage(resp.status, raw),
            resp.status,
            raw,
        );
    }

    const data = await resp.json();
    const ownerLogin = data.owner && data.owner.login;
    if (!ownerLogin || !data.id) {
        throw new GistPublishError(
            "GitHub accepted the gist but didn't return owner / id fields needed to build a share URL.",
            resp.status,
        );
    }

    // We construct the unversioned raw URL ourselves rather than using
    // ``data.files[...].raw_url`` (which pins to a specific commit
    // SHA, ~41 chars longer).  Unversioned means recipients with the
    // share URL automatically pick up updates when the publisher
    // re-publishes — matches V1_PLAN's "republishing the same slug
    // overwrites" semantics.  Tradeoff: not byte-immutable, but the
    // user can always fork to snapshot. The pinned variant is also
    // surfaced (``runtimeUrlPinned``) for callers that need
    // immutability — currently the gallery-submission flow.
    const bundleRawUrl =
        `https://gist.githubusercontent.com/${ownerLogin}/${data.id}/raw/${bundleFilename}`;

    // Use the ``?gist=USER/ID/SLUG`` shorthand instead of an encoded
    // ``?src=`` URL.  The receive resolver appends ``.agex.b64`` to
    // the slug to reconstruct ``bundleRawUrl``.  Self-describing
    // share URL and ~80 chars saved over the encoded full form.
    const base = origin || "";
    const runtimeUrl = `${base}/run/?gist=${ownerLogin}/${data.id}/${slug}`;

    // GitHub's gist API returns the full revision history under
    // ``history``; the latest entry's ``version`` is the SHA of the
    // commit that just landed. Defensive — if the response shape
    // ever drops it (or a mock omits it), pinning falls back to the
    // unpinned URL so callers degrade gracefully instead of building
    // a malformed link.
    const gistCommit =
        (Array.isArray(data.history) &&
            data.history[0] &&
            typeof data.history[0].version === "string" &&
            data.history[0].version) ||
        "";
    const runtimeUrlPinned = gistCommit
        ? `${base}/run/?gist=${ownerLogin}/${data.id}/${gistCommit}/${slug}`
        : runtimeUrl;

    // Post a markdown comment carrying the description prose, the
    // runtime link, and a manifest table.  The gist itself is
    // already created, so a comment failure is non-fatal — we log
    // it and still return the publish result.  The runtime URL
    // works either way; we just miss the convenience of the
    // preview block on the gist's github.com page.
    try {
        const commentBody = _composeGistComment({
            name: effectiveName,
            description,
            runtimeUrl,
            manifest,
            bundleBytesLen: bytes.length,
        });
        await fetch(`https://api.github.com/gists/${data.id}/comments`, {
            method: "POST",
            headers: {
                Accept: "application/vnd.github+json",
                Authorization: `token ${pat}`,
                "Content-Type": "application/json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            body: JSON.stringify({ body: commentBody }),
        });
    } catch (err) {
        // Comment post failed — log but don't fail the publish.
        console.warn("Failed to post gist comment with runtime URL:", err);
    }

    return {
        gistId: data.id,
        gistHtmlUrl: data.html_url,
        bundleRawUrl,
        runtimeUrl,
        gistCommit,
        runtimeUrlPinned,
        slug,
        updated,
    };
}

/**
 * Compose the markdown comment posted to the gist after creation.
 *
 * Layout (rendered by GitHub's markdown):
 *
 *     ## <name>
 *
 *     <description prose, if any>
 *
 *     [Open in agex.studio](<runtime URL>)
 *
 *     |  |  |
 *     |--|--|
 *     | Commits | N |
 *     | Blobs | N |
 *     | Nodes | N |
 *     | App storage | size |
 *     | Bundle | size |
 *
 * @param {{
 *   name: string,
 *   description?: string,
 *   runtimeUrl: string,
 *   manifest: object,
 *   bundleBytesLen: number,
 * }} parts
 * @returns {string}
 */
function _composeGistComment({
    name,
    description,
    runtimeUrl,
    manifest,
    bundleBytesLen,
}) {
    const lines = [`## ${name}`];
    if (description && description.trim()) {
        lines.push("", description.trim());
    }
    // Two share URLs — play mode for end-users (app-only view) and
    // showcase for builders/curious folk (split view with chat
    // history visible). Same gist, different default layout; the
    // viewer-side reads `?play=1` on mount and toggles `viewMode`
    // accordingly. See ChatShell's `isPlayMode` + SplitPane's
    // `view-app-only` for the mechanics.
    lines.push(
        "",
        `**Open as app:** [${runtimeUrl}&play=1](${runtimeUrl}&play=1)`,
        "",
        `**Open as showcase:** [${runtimeUrl}](${runtimeUrl})`,
    );

    const stats = (manifest && manifest.stats) || {};
    const rows = [];
    if (stats.commits != null) rows.push(["Commits", String(stats.commits)]);
    if (stats.blobs != null) rows.push(["Blobs", String(stats.blobs)]);
    if (stats.nodes != null) rows.push(["Nodes", String(stats.nodes)]);
    if (bundleBytesLen != null) {
        rows.push(["Bundle", formatBytes(bundleBytesLen)]);
    }
    if (rows.length) {
        lines.push("", "|  |  |", "|--|--|");
        for (const [k, v] of rows) {
            lines.push(`| ${k} | ${v} |`);
        }
    }
    return lines.join("\n");
}


/**
 * Translate a GitHub API error into something a publisher can act on.
 *
 * Common cases:
 *   * 401 — bad / expired / no-scope token
 *   * 403 — rate-limited or insufficient scope
 *   * 422 — payload validation (most likely: gist too large)
 *   * 5xx — GitHub-side outage; the body is rarely useful
 *
 * @param {number} status
 * @param {string} body  - raw response text
 * @returns {string}
 */
function githubErrorMessage(status, body) {
    let message = "";
    try {
        const parsed = JSON.parse(body);
        message = parsed?.message || "";
    } catch {
        // Non-JSON error body — leave message empty so the status-
        // specific copy below kicks in.
    }
    if (status === 401) {
        return "Your GitHub token isn't valid (or doesn't have the gist scope). Update it in Settings.";
    }
    if (status === 403) {
        if (/rate limit/i.test(message)) {
            return "GitHub rate limit hit. Try again in a few minutes.";
        }
        return "GitHub rejected the request (token scope or permissions). Verify the token has the gist scope.";
    }
    if (status === 422) {
        if (/too large|payload|exceeded/i.test(message)) {
            return "Bundle is too large for a gist (~10 MB ceiling). Trim app data or state before retrying.";
        }
        return `GitHub rejected the bundle: ${message || "validation failed"}.`;
    }
    if (status >= 500) {
        return `GitHub is having trouble (${status}). Try again shortly.`;
    }
    return `GitHub returned ${status}${message ? `: ${message}` : ""}.`;
}

export { GistPublishError };
