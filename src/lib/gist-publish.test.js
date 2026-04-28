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

    /** Helper: queue a POST response + a PATCH response on the
     * shared fetchMock.  The PATCH is a non-fatal description update;
     * tests that don't care about it can still let it complete by
     * queuing a default success. */
    function mockPostAndPatch(opts = {}) {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 201,
            json: async () => fakeGistResponse(opts),
        });
        // PATCH response — ignored in happy paths.
        fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
    }

    it("posts a secret gist with manifest + base64 bundle and returns the runtime URL", async () => {
        mockPostAndPatch();
        const result = await publishGistBundle({
            pat: "ghp_test",
            bytes: bytesOf("bundle bytes"),
            manifest: { stats: { commits: 5 } },
            name: "My Session",
            origin: "https://agex.studio",
        });

        // Two requests now: POST (create) + PATCH (description update
        // with the runtime URL we couldn't know before the gist ID
        // came back from the POST).
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe("https://api.github.com/gists");
        expect(init.method).toBe("POST");
        expect(init.headers.Authorization).toBe("token ghp_test");
        expect(init.headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
        const body = JSON.parse(init.body);
        expect(body.public).toBe(false);
        // Initial description is just the name — runtime URL not yet
        // knowable.  PATCH updates it below.
        expect(body.description).toBe("My Session");
        expect(body.files["manifest.json"].content).toContain('"commits": 5');
        // The bundle filename is slugified from the name so a
        // publisher's gist profile shows differentiated filenames
        // instead of N copies of "bundle.agex.b64".
        expect(body.files["my-session.agex.b64"].content).toBe(
            btoa("bundle bytes"),
        );
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
        expect(result.bundleRawUrl).not.toMatch(/\/raw\/[a-f0-9]{40}\//);
        expect(result.runtimeUrl).toBe(
            "https://agex.studio/run/?gist=test-user/abc123def456/my-session",
        );

        // PATCH includes the runtime URL appended to the description.
        const [patchUrl, patchInit] = fetchMock.mock.calls[1];
        expect(patchUrl).toBe(
            "https://api.github.com/gists/abc123def456",
        );
        expect(patchInit.method).toBe("PATCH");
        const patchBody = JSON.parse(patchInit.body);
        expect(patchBody.description).toContain("My Session");
        expect(patchBody.description).toContain(result.runtimeUrl);
    });

    it("includes the optional session description in the gist description", async () => {
        mockPostAndPatch();
        const result = await publishGistBundle({
            pat: "ghp_test",
            bytes: bytesOf("x"),
            manifest: {},
            name: "Q3 Sales",
            description: "A breakdown of regional sales for Q3 2026.",
            origin: "https://agex.studio",
        });
        // Initial POST description has both name and description.
        const postBody = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(postBody.description).toContain("Q3 Sales");
        expect(postBody.description).toContain("A breakdown of regional sales");
        // PATCH adds the runtime URL on top.
        const patchBody = JSON.parse(fetchMock.mock.calls[1][1].body);
        expect(patchBody.description).toContain("Q3 Sales");
        expect(patchBody.description).toContain("A breakdown of regional sales");
        expect(patchBody.description).toContain(result.runtimeUrl);
    });

    it("succeeds when the PATCH update fails (publish is already done)", async () => {
        const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 201,
            json: async () => fakeGistResponse(),
        });
        // PATCH errors out — we should still get a successful return.
        fetchMock.mockRejectedValueOnce(new Error("network blip"));
        const result = await publishGistBundle({
            pat: "ghp_test",
            bytes: bytesOf("x"),
            manifest: {},
            name: "My Session",
            origin: "https://agex.studio",
        });
        expect(result.runtimeUrl).toBe(
            "https://agex.studio/run/?gist=test-user/abc123def456/my-session",
        );
        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining("Failed to update gist description"),
            expect.any(Error),
        );
        consoleSpy.mockRestore();
    });

    it("falls back to a 'session' slug when name is empty", async () => {
        mockPostAndPatch();
        const result = await publishGistBundle({
            pat: "ghp_test",
            bytes: bytesOf("x"),
            manifest: {},
            name: "",
            origin: "https://agex.studio",
        });
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        // ``agex-studio artifact`` is the empty-name fallback, which
        // slugifies to ``agex-studio-artifact``.
        const filenames = Object.keys(body.files).filter((f) =>
            f.endsWith(".agex.b64"),
        );
        expect(filenames).toHaveLength(1);
        expect(filenames[0]).toBe("agex-studio-artifact.agex.b64");
        expect(result.runtimeUrl).toBe(
            "https://agex.studio/run/?gist=test-user/abc123def456/agex-studio-artifact",
        );
    });

    it("caps the slug at 50 chars and trims trailing hyphens after slicing", async () => {
        mockPostAndPatch();
        // 80-char name: well past the 50-char slug cap.
        const longName =
            "Quarterly Sales Dashboard for the North American Region — Final Draft";
        const result = await publishGistBundle({
            pat: "ghp_test",
            bytes: bytesOf("x"),
            manifest: {},
            name: longName,
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
