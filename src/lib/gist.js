/**
 * Publishing a session as a GitHub gist, and opening one.
 *
 * A published session is a secret gist holding one file, its bundle as
 * base64 (`<slug>.agex.b64`: a gist holds text). Anyone with the link
 * opens it: `/run/?gist=<owner>/<id>/<slug>` follows the gist's latest
 * revision, `/run/?gist=<owner>/<id>/<revision>/<slug>` stays on one,
 * and `&play=1` shows the app alone. Publishing again updates the same
 * gist, so the link stays; reading needs no token, writing one with
 * gist access (a classic token's `gist` scope, or a fine-grained one's
 * account permission Gists: read and write).
 */

import { base64ToBytes, bytesToBase64 } from "./bytes.js";

const API = "https://api.github.com";
const RAW = "https://gist.githubusercontent.com";

/** Where the person makes a token that can publish. */
export const GIST_TOKEN_URL = "https://github.com/settings/tokens/new?description=agex-studio&scopes=gist";

/**
 * A published gist, as a session records it.
 *
 * @typedef {{ owner: string, id: string, slug: string, revision: string }} GistRef
 */

/** A gist's slug from a session's title. @param {string} title */
export function slugOf(title) {
    return (
        title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 50) || "session"
    );
}

/** The bundle's file in a gist. @param {string} slug */
const fileOf = (slug) => `${slug}.agex.b64`;

/**
 * The link that opens a published session.
 *
 * @param {string} origin the studio's
 * @param {GistRef} gist
 * @param {{ pinned?: boolean, play?: boolean }} [opts]
 */
export function runUrl(origin, gist, opts = {}) {
    const path = opts.pinned ? `${gist.owner}/${gist.id}/${gist.revision}/${gist.slug}` : `${gist.owner}/${gist.id}/${gist.slug}`;
    return `${origin}/run/?gist=${path}${opts.play ? "&play=1" : ""}`;
}

/**
 * The gist a `?gist=` value names, or null when it names none.
 *
 * @param {string} value `<owner>/<id>/<slug>` or `<owner>/<id>/<revision>/<slug>`
 * @returns {(Omit<GistRef, "revision"> & { revision: string | null }) | null}
 */
export function parseGistParam(value) {
    const m = /^([\w.-]+)\/([0-9a-f]+)\/(?:([0-9a-f]{40})\/)?([a-z0-9-]{1,50})$/i.exec(value.trim());
    if (m === null) return null;
    return { owner: /** @type {string} */ (m[1]), id: /** @type {string} */ (m[2]), revision: m[3] ?? null, slug: /** @type {string} */ (m[4]) };
}

/**
 * A request to GitHub's API; its JSON, or an error saying what to do.
 *
 * @param {string} path @param {{ method?: string, token?: string, body?: unknown, fetchImpl?: typeof fetch }} [opts]
 */
async function api(path, opts = {}) {
    const r = await (opts.fetchImpl ?? fetch)(`${API}${path}`, {
        method: opts.method ?? "GET",
        // GitHub marks a gist cacheable for a minute: an update check
        // asks it again (a 304 when nothing changed)
        cache: "no-cache",
        headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            ...(opts.token && { Authorization: `Bearer ${opts.token}` }),
            ...(opts.body !== undefined && { "Content-Type": "application/json" }),
        },
        ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }),
    });
    if (r.ok) return r.json();
    const detail = await r.json().catch(() => ({}));
    const message = typeof detail?.message === "string" ? detail.message : "";
    const error = new Error(gistError(r.status, message));
    /** @type {any} */ (error).status = r.status;
    throw error;
}

/** @param {number} status @param {string} message */
function gistError(status, message) {
    if (status === 401) return "GitHub refused the token: check it, or make a new one with gist access.";
    if (status === 403 || status === 404) {
        if (/rate limit/i.test(message)) return "GitHub is rate-limiting requests; try again in a while.";
        if (status === 403) return "The token can't write gists: it needs the gist scope (or Gists: read and write).";
    }
    if (status === 422 && /too large|size/i.test(message)) return "The bundle is too large for a gist: publish it as it is now, rather than with its history.";
    return `GitHub answered ${status}${message ? `: ${message}` : ""}`;
}

/**
 * Publish a bundle: update gist `existing` when given (keeping its file,
 * so its links stay), else a new secret gist. A gist that's gone (or
 * isn't the token's to write) is replaced by a new one.
 *
 * @param {{ token: string, title: string, bytes: Uint8Array, existing?: GistRef | null, fetchImpl?: typeof fetch }} opts
 * @returns {Promise<GistRef & { url: string, replaced: boolean }>}
 */
export async function publishGist({ token, title, bytes, existing = null, fetchImpl }) {
    const content = bytesToBase64(bytes);
    const description = title.replace(/\s+/g, " ").trim() || "agex studio session";
    /** @type {any} */
    let gist = null;
    let replaced = false;
    if (existing !== null) {
        try {
            gist = await api(`/gists/${existing.id}`, {
                method: "PATCH",
                token,
                body: { description, files: { [fileOf(existing.slug)]: { content } } },
                fetchImpl,
            });
        } catch (e) {
            const status = /** @type {any} */ (e).status;
            if (status !== 404 && status !== 403) throw e;
            replaced = true;
        }
    }
    const slug = gist !== null && existing !== null ? existing.slug : slugOf(title);
    if (gist === null) {
        gist = await api("/gists", {
            method: "POST",
            token,
            body: { description, public: false, files: { [fileOf(slug)]: { content } } },
            fetchImpl,
        });
    }
    return {
        owner: gist.owner?.login ?? "",
        id: gist.id,
        slug,
        revision: gist.history?.[0]?.version ?? "",
        url: gist.html_url ?? `https://gist.github.com/${gist.id}`,
        replaced,
    };
}

/**
 * A published session's bundle, from the gist's latest revision or
 * `gist.revision`.
 *
 * @param {Omit<GistRef, "revision"> & { revision: string | null }} gist
 * @param {typeof fetch} [fetchImpl]
 */
export async function fetchGistBundle(gist, fetchImpl = fetch) {
    const rev = gist.revision ? `${gist.revision}/` : "";
    const r = await fetchImpl(`${RAW}/${gist.owner}/${gist.id}/raw/${rev}${fileOf(gist.slug)}`);
    if (!r.ok) {
        throw new Error(r.status === 404 ? "That published session isn't there: the gist was deleted, or the link is wrong." : `GitHub answered ${r.status} for the gist`);
    }
    return base64ToBytes((await r.text()).replace(/\s+/g, ""));
}

/**
 * A gist's latest revision, or null when it is gone. Unauthenticated
 * when no token is given (GitHub allows 60 such requests an hour).
 *
 * @param {string} id @param {{ token?: string, fetchImpl?: typeof fetch }} [opts]
 */
export async function latestRevision(id, opts = {}) {
    try {
        const gist = await api(`/gists/${id}`, opts);
        return /** @type {string} */ (gist.history?.[0]?.version ?? null);
    } catch (e) {
        if (/** @type {any} */ (e).status === 404) return null;
        throw e;
    }
}
