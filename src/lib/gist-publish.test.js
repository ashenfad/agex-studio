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
function fakeGistResponse({ id = "abc123def456", htmlUrl, bundleRawUrl } = {}) {
    return {
        id,
        html_url: htmlUrl || `https://gist.github.com/test-user/${id}`,
        files: {
            "manifest.json": {
                raw_url: `https://gist.githubusercontent.com/test-user/${id}/raw/manifest.json`,
            },
            "bundle.agex.b64": {
                raw_url:
                    bundleRawUrl ||
                    `https://gist.githubusercontent.com/test-user/${id}/raw/bundle.agex.b64`,
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
            description: "My session",
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
        expect(body.description).toBe("My session");
        expect(body.files["manifest.json"].content).toContain('"commits": 5');
        // Base64 of "bundle bytes" should land in bundle.agex.b64
        expect(body.files["bundle.agex.b64"].content).toBe(
            btoa("bundle bytes"),
        );

        // Verify the returned URL shape
        expect(result.gistId).toBe("abc123def456");
        expect(result.gistHtmlUrl).toContain("gist.github.com");
        expect(result.bundleRawUrl).toContain("bundle.agex.b64");
        expect(result.runtimeUrl).toBe(
            `https://agex.studio/run/?src=${encodeURIComponent(result.bundleRawUrl)}`,
        );
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
