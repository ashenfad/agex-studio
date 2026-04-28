/**
 * Publish an agex-studio bundle as a secret GitHub Gist.
 *
 * The artifact lands as a two-file gist: ``manifest.json`` (the
 * inspectable inventory of the bundle, for human / preview UI) and
 * ``bundle.agex.b64`` (the full bundle bytes base64-encoded).  Gists
 * don't accept binary file content directly — everything stored is
 * text — so the bundle round-trips through base64.  The recipient
 * runtime detects the ``.b64`` suffix and decodes before importing.
 *
 * Why two files instead of one big gist with the bundle flattened
 * across many files?  Recovering the bundle on the recipient side
 * requires a single fetch + decode rather than parsing the gist
 * API response and reconstituting a flattened directory tree.
 * Simpler receive path, single round-trip, no special-case logic
 * for which-file-contains-state-bin.  Only cost is the ~33% size
 * inflation from base64 — gist's ~10MB ceiling becomes ~7.5MB of
 * raw bundle data, which is comfortably above the typical
 * artifact size we expect at hobby scale.
 */

/**
 * @typedef {Object} GistPublishResult
 * @property {string} gistId         - the gist's id (hex string)
 * @property {string} gistHtmlUrl    - the human-facing GitHub URL
 *     (e.g., https://gist.github.com/<user>/<id>) for the publisher
 *     to inspect / rename / delete
 * @property {string} bundleRawUrl   - the raw URL of the bundle file,
 *     pinned to the gist's current commit (versioned and stable)
 * @property {string} runtimeUrl     - the agex.studio URL recipients
 *     open to load this artifact
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
 * Publish a bundle as a secret gist.
 *
 * @param {{
 *   pat: string,
 *   bytes: Uint8Array,
 *   manifest: object,
 *   description?: string,
 *   public?: boolean,
 *   origin?: string,
 * }} options
 * @returns {Promise<GistPublishResult>}
 * @throws {GistPublishError}
 */
export async function publishGistBundle({
    pat,
    bytes,
    manifest,
    description = "",
    public: isPublic = false,
    origin = typeof window !== "undefined" ? window.location.origin : "",
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

    // Pretty-print the manifest so anyone clicking through to the gist
    // on github.com sees a readable inventory.  Bundle file is a base64
    // blob — not human-readable — but the manifest gives the gist a
    // meaningful preview.
    const body = {
        description: description || "agex-studio artifact",
        public: !!isPublic,
        files: {
            "manifest.json": { content: JSON.stringify(manifest, null, 2) },
            "bundle.agex.b64": { content: b64 },
        },
    };

    let resp;
    try {
        resp = await fetch("https://api.github.com/gists", {
            method: "POST",
            headers: {
                Accept: "application/vnd.github+json",
                Authorization: `token ${pat}`,
                "Content-Type": "application/json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            body: JSON.stringify(body),
        });
    } catch (err) {
        // Network failure (offline, CORS-impossible host, etc.).
        const detail = err instanceof Error ? err.message : String(err);
        throw new GistPublishError(
            `Network error contacting api.github.com: ${detail}`,
            0,
        );
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
    const bundleFile = data.files && data.files["bundle.agex.b64"];
    if (!bundleFile || !bundleFile.raw_url) {
        throw new GistPublishError(
            "GitHub accepted the gist but didn't return a raw URL for the bundle file.",
            resp.status,
        );
    }
    const bundleRawUrl = bundleFile.raw_url;
    const runtimeUrl = origin
        ? `${origin}/run/?src=${encodeURIComponent(bundleRawUrl)}`
        : `/run/?src=${encodeURIComponent(bundleRawUrl)}`;

    return {
        gistId: data.id,
        gistHtmlUrl: data.html_url,
        bundleRawUrl,
        runtimeUrl,
    };
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
