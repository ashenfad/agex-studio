import { describe, expect, it } from "vitest";
import { connectSync, preferredRepo } from "./sync-connect.js";

/** A fetch answering GraphQL with these repos (or `status`). */
function github(/** @type {any[]} */ repos, status = 200) {
    return /** @type {typeof fetch} */ (
        /** @type {unknown} */ (
            async () =>
                new Response(JSON.stringify(status === 200 ? { data: { viewer: { repositories: { nodes: repos } } } } : { message: "Bad credentials" }), { status })
        )
    );
}

const repo = (/** @type {string} */ name, { perm = "WRITE", priv = true, ready = true } = {}) => ({
    nameWithOwner: name,
    isPrivate: priv,
    viewerPermission: perm,
    defaultBranchRef: ready ? { name: "main" } : null,
});

describe("connectSync", () => {
    it("takes the one repo a token can write to", async () => {
        const out = await connectSync("t", { fetchImpl: github([repo("me/agex-sync"), repo("me/other", { perm: "READ" })]) });
        expect(out).toEqual({ ok: true, repo: "me/agex-sync", private: true });
    });

    it("asks which, when the token can write to several", async () => {
        const out = await connectSync("t", { fetchImpl: github([repo("me/a"), repo("me/agex-sync")]) });
        expect(out.ok).toBe(false);
        if (!("choices" in out)) throw new Error("expected choices");
        expect(out.choices.map((c) => c.repo)).toEqual(["me/a", "me/agex-sync"]);
        expect(preferredRepo(out.choices)).toBe("me/agex-sync");
    });

    it("checks a named repo, and says when it is empty", async () => {
        const fetchImpl = github([repo("me/a"), repo("me/empty", { ready: false })]);
        expect(await connectSync("t", { repo: "ME/A", fetchImpl })).toMatchObject({ ok: true, repo: "me/a" });
        expect(await connectSync("t", { repo: "me/empty", fetchImpl })).toMatchObject({ reason: "empty-repo" });
        expect(await connectSync("t", { repo: "me/zzz", fetchImpl })).toMatchObject({ reason: "not-found" });
    });

    it("says when the token can write nowhere, or is refused", async () => {
        expect(await connectSync("t", { fetchImpl: github([repo("me/a", { perm: "READ" })]) })).toMatchObject({ reason: "no-repos" });
        expect(await connectSync("t", { fetchImpl: github([], 401) })).toMatchObject({
            reason: "auth",
            message: "GitHub refused the token: check it, or make a new one.",
        });
    });

    it("prefers a private repo when none is named agex-sync", () => {
        expect(preferredRepo([{ repo: "me/pub", private: false, ready: true }, { repo: "me/priv", private: true, ready: true }])).toBe("me/priv");
    });
});
