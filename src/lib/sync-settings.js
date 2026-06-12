/**
 * Session-sync connection setup (settings-side only — no sync engine).
 *
 * The sync remote is a plain GitHub repo the user owns, reached with a
 * fine-grained PAT scoped to just that repo (Contents: read & write).
 * Least privilege is the point: the token lives in localStorage, so a
 * single-repo grant bounds what a leak can touch — and it's why the
 * wizard can't create the repo for the user (a token that could would
 * be a token too broad to store).
 *
 * Connect flow:
 *   1. `discoverSyncRepos(pat)` — fine-grained tokens can only see the
 *      repos they're granted, so `GET /user/repos` usually returns
 *      exactly the sync repo. Zero → bad grant; several → caller asks
 *      the user to pick.
 *   2. `connectSyncRepo(pat, { repo? })` — validates the repo is
 *      initialized (a `main` ref exists; the Git Data API rejects
 *      empty repos, hence the wizard's "tick Add a README") and writes
 *      the `agex-sync.json` marker if absent.
 *
 * Connection state persists via settings (`syncRepo` + `syncPat`);
 * disconnecting just forgets those — the repo and its sessions are
 * never touched. Engine wiring (push/pull, status, lifecycle) builds
 * on this in a later slice.
 */

import { GithubClient, GithubError, bytesToBase64 } from "@agex-ts/kvgit/github";

/** Prefilled repo-creation page: name + privacy set; the user ticks
 *  "Add a README" (an empty repo can't serve the Git Data API). */
export const SYNC_REPO_CREATE_LINK =
    "https://github.com/new?name=agex-sync&visibility=private&description=agex-studio+session+sync";

/** Fine-grained PAT creation page. GitHub doesn't accept prefilled
 *  repo/permission params here, so the wizard spells out the two
 *  choices: Only select repositories → the sync repo; Contents:
 *  Read and write. */
export const SYNC_PAT_CREATE_LINK = "https://github.com/settings/personal-access-tokens/new";

/** Marker file written to main on first connect — identifies the repo
 *  as an agex sync target (and gives empty-ish repos a sanity check). */
export const SYNC_MARKER_PATH = "agex-sync.json";

/** The repo name the wizard's create link prefills — also the
 *  discovery preselection target. */
export const SYNC_REPO_SUGGESTED_NAME = "agex-sync";

/**
 * Pick the default among multiple discovered repos: the wizard's
 * suggested name wins (fine-grained tokens always carry read on the
 * user's public repos, so the list is rarely length one even with a
 * perfectly scoped token), then any private repo, then the first.
 *
 * @param {Array<{ fullName: string, private: boolean }>} choices
 */
export function preferredSyncRepo(choices) {
    return (
        choices.find((c) => c.fullName.split("/")[1] === SYNC_REPO_SUGGESTED_NAME) ??
        choices.find((c) => c.private) ??
        choices[0] ??
        null
    );
}

const API_BASE = "https://api.github.com";

/**
 * Repos the token can push to. Fine-grained PATs only list their
 * granted repos, so this is usually a single entry. Capped at 300 —
 * a sync token that can see more than that is mis-scoped anyway.
 *
 * @param {string} pat
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<Array<{ fullName: string, private: boolean }>>}
 */
export async function discoverSyncRepos(pat, opts = {}) {
    const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const out = [];
    for (let page = 1; page <= 3; page++) {
        const resp = await fetchImpl(`${API_BASE}/user/repos?per_page=100&page=${page}`, {
            headers: authHeaders(pat),
        });
        if (!resp.ok) {
            if (resp.status === 401) {
                throw new Error(
                    "GitHub rejected the token (401). Check it copied fully and hasn't expired.",
                );
            }
            throw new Error(`GitHub /user/repos returned ${resp.status}.`);
        }
        const batch = await resp.json();
        for (const r of batch) {
            if (r?.permissions?.push) {
                out.push({ fullName: r.full_name, private: !!r.private });
            }
        }
        if (batch.length < 100) break;
    }
    return out;
}

/**
 * Validate a sync target and stamp the marker.
 *
 * Result shapes:
 *   { ok: true, repo, isPrivate, markerCreated } — connected
 *   { ok: false, reason: 'choose', choices }     — several candidate
 *       repos; call again with an explicit `repo`
 *   { ok: false, reason, message }               — actionable failure
 *       (`no-repos` | `no-main` | `auth` | `permission` | …)
 *
 * @param {string} pat
 * @param {{ repo?: string, fetchImpl?: typeof fetch }} [opts]
 */
export async function connectSyncRepo(pat, opts = {}) {
    try {
        let repo = opts.repo;
        let isPrivate = null;
        if (!repo) {
            const candidates = await discoverSyncRepos(pat, opts);
            if (candidates.length === 0) {
                return {
                    ok: false,
                    reason: "no-repos",
                    message:
                        "The token can't reach any repos. When creating it, choose “Only select repositories” and grant your sync repo with Contents: read and write.",
                };
            }
            if (candidates.length > 1) {
                return { ok: false, reason: "choose", choices: candidates };
            }
            repo = candidates[0].fullName;
            isPrivate = candidates[0].private;
        } else {
            // Privacy backs the world-readable warning — a guardrail
            // this function owns rather than outsourcing to caller
            // diligence (the explicit-repo path is exactly the
            // broad-token flow where a public pick is most plausible).
            // Tolerant: a failed lookup yields null (unknown), never a
            // blocked connect.
            isPrivate = await fetchRepoPrivacy(pat, repo, opts);
        }

        const client = new GithubClient({
            token: pat,
            repo,
            ...(opts.fetchImpl !== undefined && { fetchImpl: opts.fetchImpl }),
        });

        const main = await client.getRef("main");
        if (main === null) {
            return {
                ok: false,
                reason: "no-main",
                message: `Couldn't find a main branch in ${repo}. If the repo is brand new, recreate or initialize it with a README — the sync machinery can't bootstrap an empty repo.`,
            };
        }

        const markerCreated = await ensureSyncMarker(client);
        return { ok: true, repo, isPrivate, markerCreated };
    } catch (err) {
        if (err instanceof GithubError) {
            return { ok: false, reason: err.kind, message: friendlyGithubMessage(err) };
        }
        return { ok: false, reason: "error", message: err?.message ?? String(err) };
    }
}

/** @param {string} pat */
function authHeaders(pat) {
    return {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${pat}`,
        "X-GitHub-Api-Version": "2022-11-28",
    };
}

/** The repo's `private` flag, or null when it can't be determined.
 *  @returns {Promise<boolean | null>} */
async function fetchRepoPrivacy(pat, repo, opts = {}) {
    const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    try {
        const resp = await fetchImpl(`${API_BASE}/repos/${repo}`, {
            headers: authHeaders(pat),
        });
        if (!resp.ok) return null;
        const data = await resp.json();
        return typeof data?.private === "boolean" ? data.private : null;
    } catch {
        return null;
    }
}

/** Write `agex-sync.json` to main if it isn't there. Returns true when
 *  this call created it. */
async function ensureSyncMarker(client) {
    const existing = await client.getContent(SYNC_MARKER_PATH, "main");
    if (existing !== null) return false;
    const body = `${JSON.stringify({ format: 1, tool: "agex-studio" }, null, 2)}\n`;
    await client.request("PUT", `contents/${SYNC_MARKER_PATH}`, {
        message: "chore: agex-studio sync marker",
        content: bytesToBase64(new TextEncoder().encode(body)),
    });
    return true;
}

/** @param {GithubError} err */
function friendlyGithubMessage(err) {
    if (err.kind === "auth") {
        return "GitHub rejected the token. Check it copied fully and hasn't expired.";
    }
    if (err.kind === "permission") {
        return "The token can see the repo but can't write to it. It needs Contents: read and write.";
    }
    if (err.kind === "rate-limit") {
        return "GitHub rate limit hit — try again in a minute.";
    }
    return `GitHub error: ${err.message}`;
}
