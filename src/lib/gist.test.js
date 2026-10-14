import { describe, expect, it } from "vitest";
import { fetchGistBundle, latestRevision, parseGistParam, publishGist, runUrl, slugOf } from "./gist.js";

/** A fetch answering by `route(method, url, body)`; what it was sent. */
function github(/** @type {(method: string, url: string, body: any) => { status: number, json?: unknown, text?: string }} */ route) {
    /** @type {{ method: string, url: string, body: any, auth: string | undefined }[]} */
    const sent = [];
    const fetchImpl = /** @type {typeof fetch} */ (
        /** @type {unknown} */ (
            async (/** @type {string} */ url, /** @type {RequestInit} */ init = {}) => {
                const method = init.method ?? "GET";
                const body = init.body ? JSON.parse(String(init.body)) : undefined;
                sent.push({ method, url, body, auth: /** @type {any} */ (init.headers)?.Authorization });
                const r = route(method, url, body);
                return new Response(r.text ?? JSON.stringify(r.json ?? {}), { status: r.status });
            }
        )
    );
    return { fetchImpl, sent };
}

const made = (/** @type {string} */ id, /** @type {string} */ rev) => ({ id, owner: { login: "me" }, history: [{ version: rev }], html_url: `https://gist.github.com/${id}` });

describe("gist links", () => {
    it("are made and read back, following the latest or pinned to a revision", () => {
        const gist = { owner: "me", id: "abc123", slug: "a-counter", revision: "f".repeat(40) };
        expect(runUrl("https://agex.studio", gist, { play: true })).toBe("https://agex.studio/run/?gist=me/abc123/a-counter&play=1");
        expect(parseGistParam("me/abc123/a-counter")).toEqual({ owner: "me", id: "abc123", slug: "a-counter", revision: null });
        const pinned = new URL(runUrl("https://agex.studio", gist, { pinned: true })).searchParams.get("gist") ?? "";
        expect(parseGistParam(pinned)).toEqual(gist);
        expect(parseGistParam("me/not hex/x")).toBeNull();
        expect(slugOf("Budget: Q3 / draft!")).toBe("budget-q3-draft");
        expect(slugOf("")).toBe("session");
    });
});

describe("publishGist", () => {
    it("makes a secret gist of the bundle as base64", async () => {
        const { fetchImpl, sent } = github(() => ({ status: 201, json: made("g1", "r1") }));
        const out = await publishGist({ token: "t", title: "A counter", bytes: new Uint8Array([1, 2, 3]), fetchImpl });
        expect(out).toEqual({ owner: "me", id: "g1", slug: "a-counter", revision: "r1", url: "https://gist.github.com/g1", replaced: false });
        expect(sent[0]).toMatchObject({ method: "POST", url: "https://api.github.com/gists", auth: "Bearer t" });
        expect(sent[0]?.body).toEqual({ description: "A counter", public: false, files: { "a-counter.agex.b64": { content: "AQID" } } });
    });

    it("updates the gist it went to before, keeping its file", async () => {
        const { fetchImpl, sent } = github(() => ({ status: 200, json: made("g1", "r2") }));
        const existing = { owner: "me", id: "g1", slug: "old-name", revision: "r1" };
        const out = await publishGist({ token: "t", title: "Renamed", bytes: new Uint8Array([1]), existing, fetchImpl });
        expect(out).toMatchObject({ id: "g1", slug: "old-name", revision: "r2", replaced: false });
        expect(sent[0]).toMatchObject({ method: "PATCH", url: "https://api.github.com/gists/g1" });
        expect(Object.keys(sent[0]?.body.files)).toEqual(["old-name.agex.b64"]);
    });

    it("makes a new gist when the old one is gone", async () => {
        const { fetchImpl, sent } = github((method) => (method === "PATCH" ? { status: 404, json: { message: "Not Found" } } : { status: 201, json: made("g2", "r1") }));
        const out = await publishGist({ token: "t", title: "A counter", bytes: new Uint8Array([1]), existing: { owner: "me", id: "g1", slug: "a-counter", revision: "r0" }, fetchImpl });
        expect(out).toMatchObject({ id: "g2", replaced: true });
        expect(sent.map((r) => r.method)).toEqual(["PATCH", "POST"]);
    });

    it("says what a refusal means", async () => {
        const refuse = (/** @type {number} */ status, /** @type {string} */ message) => github(() => ({ status, json: { message } })).fetchImpl;
        await expect(publishGist({ token: "t", title: "x", bytes: new Uint8Array(), fetchImpl: refuse(401, "Bad credentials") })).rejects.toThrow("GitHub refused the token");
        await expect(publishGist({ token: "t", title: "x", bytes: new Uint8Array(), fetchImpl: refuse(403, "Forbidden") })).rejects.toThrow("needs the gist scope");
        await expect(publishGist({ token: "t", title: "x", bytes: new Uint8Array(), fetchImpl: refuse(422, "Gist content is too large") })).rejects.toThrow("too large for a gist");
    });
});

describe("reading a published session", () => {
    it("fetches the bundle from the gist's raw file, at the latest or a revision", async () => {
        const { fetchImpl, sent } = github(() => ({ status: 200, text: "AQID\n" }));
        expect([...(await fetchGistBundle({ owner: "me", id: "g1", slug: "a", revision: null }, fetchImpl))]).toEqual([1, 2, 3]);
        await fetchGistBundle({ owner: "me", id: "g1", slug: "a", revision: "r1" }, fetchImpl);
        expect(sent.map((r) => r.url)).toEqual([
            "https://gist.githubusercontent.com/me/g1/raw/a.agex.b64",
            "https://gist.githubusercontent.com/me/g1/raw/r1/a.agex.b64",
        ]);
    });

    it("finds the latest revision, and null for a gist that's gone", async () => {
        expect(await latestRevision("g1", { fetchImpl: github(() => ({ status: 200, json: made("g1", "r9") })).fetchImpl })).toBe("r9");
        expect(await latestRevision("g1", { fetchImpl: github(() => ({ status: 404, json: { message: "Not Found" } })).fetchImpl })).toBeNull();
        await expect(fetchGistBundle({ owner: "me", id: "g1", slug: "a", revision: null }, github(() => ({ status: 404 })).fetchImpl)).rejects.toThrow("the gist was deleted");
    });
});
