import { describe, expect, it } from "vitest";
import { SYNC_MARKER_PATH, connectSyncRepo, discoverSyncRepos } from "./sync-settings.js";

/** Sequence-scripted fetch recording method+url+body per call. */
function makeFetch(script) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({
            method: init?.method ?? "GET",
            url: String(url),
            body: init?.body !== undefined ? JSON.parse(init.body) : undefined,
        });
        const next = script.shift() ?? { status: 500, body: { message: "script exhausted" } };
        if (next.status === 204) return new Response(null, { status: 204 });
        return new Response(JSON.stringify(next.body ?? {}), { status: next.status });
    };
    return { fetchImpl, calls };
}

const repo = (fullName, opts = {}) => ({
    full_name: fullName,
    private: opts.private ?? true,
    permissions: { push: opts.push ?? true },
});

describe("discoverSyncRepos", () => {
    it("returns pushable repos and stops at a short page", async () => {
        const { fetchImpl, calls } = makeFetch([
            {
                status: 200,
                body: [
                    repo("u/agex-sync"),
                    repo("u/read-only", { push: false }),
                    repo("u/public-one", { private: false }),
                ],
            },
        ]);
        const repos = await discoverSyncRepos("tok", { fetchImpl });
        expect(repos).toEqual([
            { fullName: "u/agex-sync", private: true },
            { fullName: "u/public-one", private: false },
        ]);
        expect(calls.length).toBe(1);
        expect(calls[0].url).toContain("/user/repos?per_page=100&page=1");
    });

    it("translates 401 into actionable wording", async () => {
        const { fetchImpl } = makeFetch([{ status: 401, body: { message: "Bad credentials" } }]);
        await expect(discoverSyncRepos("bad", { fetchImpl })).rejects.toThrow(/rejected the token/);
    });
});

describe("connectSyncRepo", () => {
    it("connects via single-repo discovery, validates main, writes the marker", async () => {
        const { fetchImpl, calls } = makeFetch([
            { status: 200, body: [repo("u/agex-sync")] }, // discovery
            { status: 200, body: { object: { sha: "m1" } } }, // getRef main
            { status: 404, body: { message: "Not Found" } }, // marker absent
            { status: 201, body: { content: { sha: "x" } } }, // PUT marker
        ]);
        const result = await connectSyncRepo("tok", { fetchImpl });
        expect(result).toEqual({
            ok: true,
            repo: "u/agex-sync",
            isPrivate: true,
            markerCreated: true,
        });
        const put = calls.find((c) => c.method === "PUT");
        expect(put.url).toContain(`/repos/u/agex-sync/contents/${SYNC_MARKER_PATH}`);
        const written = JSON.parse(atob(put.body.content));
        expect(written).toEqual({ format: 1, tool: "agex-studio" });
    });

    it("leaves an existing marker alone", async () => {
        const markerB64 = btoa(JSON.stringify({ format: 1, tool: "agex-studio" }));
        const { fetchImpl, calls } = makeFetch([
            { status: 200, body: [repo("u/agex-sync")] },
            { status: 200, body: { object: { sha: "m1" } } },
            {
                status: 200,
                body: { content: markerB64, encoding: "base64", sha: "s", size: 40 },
            },
        ]);
        const result = await connectSyncRepo("tok", { fetchImpl });
        expect(result.ok).toBe(true);
        expect(result.markerCreated).toBe(false);
        expect(calls.some((c) => c.method === "PUT")).toBe(false);
    });

    it("asks the caller to choose among several repos, then honors the choice", async () => {
        const { fetchImpl } = makeFetch([
            { status: 200, body: [repo("u/agex-sync"), repo("u/other")] },
        ]);
        const first = await connectSyncRepo("tok", { fetchImpl });
        expect(first.ok).toBe(false);
        expect(first.reason).toBe("choose");
        expect(first.choices.map((c) => c.fullName)).toEqual(["u/agex-sync", "u/other"]);

        // Explicit repo skips discovery entirely.
        const second = makeFetch([
            { status: 200, body: { object: { sha: "m1" } } },
            { status: 404, body: { message: "Not Found" } },
            { status: 201, body: {} },
        ]);
        const result = await connectSyncRepo("tok", {
            repo: "u/agex-sync",
            fetchImpl: second.fetchImpl,
        });
        expect(result.ok).toBe(true);
        expect(second.calls.every((c) => !c.url.includes("/user/repos"))).toBe(true);
    });

    it("reports an empty grant with wizard-step guidance", async () => {
        const { fetchImpl } = makeFetch([{ status: 200, body: [] }]);
        const result = await connectSyncRepo("tok", { fetchImpl });
        expect(result.reason).toBe("no-repos");
        expect(result.message).toMatch(/Only select repositories/);
    });

    it("explains the README bootstrap when main is missing", async () => {
        const { fetchImpl } = makeFetch([
            { status: 200, body: [repo("u/agex-sync")] },
            { status: 404, body: { message: "Not Found" } }, // no main ref
        ]);
        const result = await connectSyncRepo("tok", { fetchImpl });
        expect(result.reason).toBe("no-main");
        expect(result.message).toMatch(/README/);
    });

    it("maps token-without-write to a permission message", async () => {
        const { fetchImpl } = makeFetch([
            { status: 200, body: [repo("u/agex-sync")] },
            { status: 200, body: { object: { sha: "m1" } } },
            { status: 404, body: { message: "Not Found" } },
            {
                status: 403,
                body: { message: "Resource not accessible by personal access token" },
            }, // PUT rejected
        ]);
        const result = await connectSyncRepo("tok", { fetchImpl });
        expect(result.ok).toBe(false);
        expect(result.reason).toBe("permission");
        expect(result.message).toMatch(/read and write/);
    });
});
