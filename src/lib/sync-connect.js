/**
 * Connecting sync: which repo a GitHub token can sync through.
 *
 * Sessions sync through a private repo of the person's own, on a
 * fine-grained token scoped to it with Contents read and write. The
 * repo needs a first commit (a README): a session's branch starts from
 * it.
 */

import { GithubClient, GithubError } from "@agex-ts/kvgit/github";
import { errorText } from "./errors.js";

/** Where the person makes the repo and the token. */
export const NEW_REPO_URL = "https://github.com/new?name=agex-sync&visibility=private&description=agex-studio+session+sync";
export const NEW_TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";

const REPOS = `query {
  viewer {
    repositories(first: 100, ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { nameWithOwner isPrivate viewerPermission defaultBranchRef { name } }
    }
  }
}`;

/**
 * @typedef {{ repo: string, private: boolean, ready: boolean }} RepoChoice
 * @typedef {(
 *   | { ok: true, repo: string, private: boolean }
 *   | { ok: false, reason: "choose", choices: RepoChoice[], message: string }
 *   | { ok: false, reason: "no-repos" | "empty-repo" | "not-found" | "auth", message: string }
 * )} ConnectResult
 */

/**
 * Check `token` against GitHub: the repo to sync through, `repo` if
 * given, else the one the token can write to (asking when it can
 * write to several).
 *
 * @param {string} token
 * @param {{ repo?: string, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<ConnectResult>}
 */
export async function connectSync(token, opts = {}) {
    const client = new GithubClient({ token, repo: "-/-", maxRetries: 1, ...(opts.fetchImpl && { fetchImpl: opts.fetchImpl }) });
    /** @type {any} */
    let res;
    try {
        res = await client.graphql(REPOS);
    } catch (e) {
        return { ok: false, reason: "auth", message: describe(e) };
    }
    if (res.data === null) return { ok: false, reason: "auth", message: res.errors.map((/** @type {any} */ e) => e.message).join("; ") || "GitHub refused the token" };
    /** @type {RepoChoice[]} */
    const writable = (res.data.viewer?.repositories?.nodes ?? [])
        .filter((/** @type {any} */ r) => ["ADMIN", "MAINTAIN", "WRITE"].includes(r.viewerPermission))
        .map((/** @type {any} */ r) => ({ repo: r.nameWithOwner, private: r.isPrivate, ready: r.defaultBranchRef !== null }));
    if (writable.length === 0) {
        return { ok: false, reason: "no-repos", message: "The token can't write to any repo: give it Contents read and write on your sync repo." };
    }
    const wanted = opts.repo?.trim();
    const pick = wanted ? writable.find((r) => r.repo.toLowerCase() === wanted.toLowerCase()) : writable.length === 1 ? writable[0] : undefined;
    if (wanted && pick === undefined) {
        return { ok: false, reason: "not-found", message: `The token can't write to ${wanted}.` };
    }
    if (pick === undefined) {
        return { ok: false, reason: "choose", choices: writable, message: "The token can write to several repos: pick the one to sync through." };
    }
    if (!pick.ready) {
        return { ok: false, reason: "empty-repo", message: `${pick.repo} is empty: add a README on GitHub (a first commit), then connect again.` };
    }
    return { ok: true, repo: pick.repo, private: pick.private };
}

/** The repo to offer first: `agex-sync`, else a private one, else the
 *  first. @param {RepoChoice[]} choices */
export function preferredRepo(choices) {
    return (choices.find((c) => c.repo.endsWith("/agex-sync")) ?? choices.find((c) => c.private) ?? choices[0])?.repo ?? "";
}

/** A sync failure as the person reads it. @param {unknown} e */
export function describe(e) {
    if (e instanceof GithubError) {
        if (e.kind === "auth") return "GitHub refused the token: check it, or make a new one.";
        if (e.kind === "permission") return "The token lacks a permission: it needs Contents read and write on the sync repo.";
        if (e.kind === "rate-limit") return "GitHub is rate-limiting requests: sync will try again later.";
        if (e.kind === "network") return "GitHub couldn't be reached.";
    }
    return errorText(e);
}
