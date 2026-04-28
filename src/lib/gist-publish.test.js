/**
 * Tests for the gist-publish module.
 *
 * Mocks ``fetch`` so we can verify request shape, response handling,
 * and error translation without hitting api.github.com.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GistPublishError, publishGistBundle } from "./gist-publish.js";

/** Build a Uint8Array from a UTF-8 string for test convenience. */
function bytesOf(text) {
    return new TextEncoder().encode(text);
}

/** A successful gist response shape, narrow enough for our consumer. */
function fakeGistResponse({ id = "abc123def456", owner = "test-user", htmlUrl } = {}) {
    return {
        id,
        owner: { login: owner },
        html_url: htmlUrl || `https://gist.github.com/${owner}/${id}`,
        files: {
            "manifest.json": {
                raw_url: `https://gist.githubusercontent.com/${owner}/${id}/raw/manifest.json`,
            },
            "bundle.agex.b64": {
                raw_url: `https://gist.githubusercontent.com/${owner}/${id}/raw/bundle.agex.b64`,
            },
        },
    };
}

describe("publishGistBundle", () => {
    let originalFetch;
    let fetchMock;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
        fetchMock = vi.fn();
        globalThis.fetch = fetchMock;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it("rejects empty PAT without making a request", async () => {
        await expect(
            publishGistBundle({
                pat: "",
                bytes: bytesOf("hello"),
                manifest: {},
            }),
        ).rejects.toThrow(GistPublishError);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects empty bundle without making a request", async () => {
        await expect(
            publishGistBundle({
                pat: "ghp_test",
                bytes: new Uint8Array(0),
                manifest: {},
            }),
        ).rejects.toThrow("Bundle is empty");
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("posts a secret gist with manifest + base64 bundle and returns the runtime URL", async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 201,
            json: async () => fakeGistResponse(),
        });
        const result = await publishGistBundle({
            pat: "ghp_test",
            bytes: bytesOf("bundle bytes"),
            manifest: { stats: { commits: 5 } },
            description: "My Session",
            origin: "https://agex.studio",
        });

        // Verify the request shape
        expect(fetchMock).toHaveBeenCalledOnce();
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe("https://api.github.com/gists");
        expect(init.method).toBe("POST");
        expect(init.headers.Authorization).toBe("token ghp_test");
        expect(init.headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
        const body = JSON.parse(init.body);
        expect(body.public).toBe(false);
        expect(body.description).toBe("My Session");
        expect(body.files["manifest.json"].content).toContain('"commits": 5');
        // The bundle filename is slugified from the description so a
        // publisher's gist profile shows differentiated filenames
        // instead of N copies of "bundle.agex.b64".
        expect(body.files["my-session.agex.b64"].content).toBe(
            btoa("bundle bytes"),
        );
        // No generic fallback file when a description is provided.
        expect(body.files["bundle.agex.b64"]).toBeUndefined();

        // Verify the returned URL shape:
        //   * gistId / gistHtmlUrl come straight from the API response
        //   * bundleRawUrl is the unversioned raw URL we construct
        //     ourselves (no commit SHA, so re-publish updates it),
        //     and uses the slugified filename
        //   * runtimeUrl uses the ``?gist=USER/ID/SLUG`` shorthand —
        //     self-describing and ~80 chars shorter than ``?src=``
        expect(result.gistId).toBe("abc123def456");
        expect(result.gistHtmlUrl).toContain("gist.github.com");
        expect(result.bundleRawUrl).toBe(
            "https://gist.githubusercontent.com/test-user/abc123def456/raw/my-session.agex.b64",
        );
        // No commit SHA in the URL — recipients pick up updates.
        expect(result.bundleRawUrl).not.toMatch(/\/raw\/[a-f0-9]{40}\//);
        expect(result.runtimeUrl).toBe(
            "https://agex.studio/run/?gist=test-user/abc123def456/my-session",
        );
    });

    it("falls back to a 'session' slug when description is empty", async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 201,
            json: async () => fakeGistResponse(),
        });
        const result = await publishGistBundle({
            pat: "ghp_test",
            bytes: bytesOf("x"),
            manifest: {},
            description: "",
            origin: "https://agex.studio",
        });
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.files["session.agex.b64"]).toBeDefined();
        expect(result.runtimeUrl).toBe(
            "https://agex.studio/run/?gist=test-user/abc123def456/session",
        );
    });

    it("caps the slug at 50 chars and trims trailing hyphens after slicing", async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 201,
            json: async () => fakeGistResponse(),
        });
        // 80-char description: well past the 50-char slug cap.
        const longDesc =
            "Quarterly Sales Dashboard for the North American Region — Final Draft";
        const result = await publishGistBundle({
            pat: "ghp_test",
            bytes: bytesOf("x"),
            manifest: {},
            description: longDesc,
            origin: "https://agex.studio",
        });
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        const filenames = Object.keys(body.files).filter((f) =>
            f.endsWith(".agex.b64"),
        );
        expect(filenames).toHaveLength(1);
        const slug = filenames[0].replace(/\.agex\.b64$/, "");
        expect(slug.length).toBeLessThanOrEqual(50);
        expect(slug.endsWith("-")).toBe(false);
        expect(result.runtimeUrl.endsWith(`/${slug}`)).toBe(true);
    });

    it("rejects responses missing owner.login or id", async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 201,
            json: async () => ({
                // No owner.
                id: "abc",
                files: { "bundle.agex.b64": { raw_url: "..." } },
            }),
        });
        await expect(
            publishGistBundle({
                pat: "ghp_test",
                bytes: bytesOf("x"),
                manifest: {},
            }),
        ).rejects.toThrow(/owner.*id/i);
    });

    it("translates 401 into a token-specific error message", async () => {
        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 401,
            text: async () => JSON.stringify({ message: "Bad credentials" }),
        });
        await expect(
            publishGistBundle({
                pat: "ghp_bad",
                bytes: bytesOf("x"),
                manifest: {},
            }),
        ).rejects.toThrow(/token isn't valid/i);
    });

    it("translates 403 rate-limit into a clear actionable message", async () => {
        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 403,
            text: async () =>
                JSON.stringify({ message: "API rate limit exceeded for ..." }),
        });
        await expect(
            publishGistBundle({
                pat: "ghp_test",
                bytes: bytesOf("x"),
                manifest: {},
            }),
        ).rejects.toThrow(/rate limit/i);
    });

    it("translates 422 size errors into the gist-ceiling message", async () => {
        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 422,
            text: async () =>
                JSON.stringify({ message: "Validation Failed: too large" }),
        });
        await expect(
            publishGistBundle({
                pat: "ghp_test",
                bytes: bytesOf("x"),
                manifest: {},
            }),
        ).rejects.toThrow(/too large for a gist/i);
    });

    it("surfaces network errors with status 0", async () => {
        fetchMock.mockRejectedValueOnce(new Error("network down"));
        try {
            await publishGistBundle({
                pat: "ghp_test",
                bytes: bytesOf("x"),
                manifest: {},
            });
            throw new Error("should have thrown");
        } catch (err) {
            expect(err).toBeInstanceOf(GistPublishError);
            expect(err.status).toBe(0);
            expect(err.message).toContain("Network error");
        }
    });

    it("can publish as a public gist when public:true is passed", async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 201,
            json: async () => fakeGistResponse(),
        });
        await publishGistBundle({
            pat: "ghp_test",
            bytes: bytesOf("x"),
            manifest: {},
            public: true,
        });
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.public).toBe(true);
    });
});
