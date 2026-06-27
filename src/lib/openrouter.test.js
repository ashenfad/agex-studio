import { describe, it, expect, vi, beforeEach } from "vitest";
import { listModelEndpoints, clearEndpointCache } from "./openrouter.js";

// Mirrors the real `anthropic/claude-sonnet-4.6` shape: several providers,
// some serving the model from multiple regions (same provider_name, distinct
// `tag`), a duplicate tag, and a tag-less entry.
const RESPONSE = {
    data: {
        id: "anthropic/claude-sonnet-4.6",
        endpoints: [
            { provider_name: "Google", tag: "google-vertex/europe", supported_parameters: ["tools"], status: "online" },
            { provider_name: "Google", tag: "google-vertex/us-east5", supported_parameters: ["tools"], status: "online" },
            { provider_name: "Anthropic", tag: "anthropic", supported_parameters: ["temperature"], status: "online" },
            // duplicate routing slug → collapsed
            { provider_name: "Anthropic", tag: "anthropic", supported_parameters: ["tools"], status: "online" },
            // no `tag` → can't be pinned → dropped
            { provider_name: "Mystery" },
        ],
    },
};

describe("listModelEndpoints", () => {
    beforeEach(() => {
        clearEndpointCache();
        vi.restoreAllMocks();
    });

    it("disambiguates same-provider regions via the tag variant, dedups by slug", async () => {
        global.fetch = vi.fn(async () => ({ ok: true, json: async () => RESPONSE }));
        const eps = await listModelEndpoints("anthropic/claude-sonnet-4.6", "key");
        expect(eps.map((e) => e.label)).toEqual([
            "Google (europe)",
            "Google (us-east5)",
            "Anthropic", // bare tag → no variant suffix; the dup is collapsed
        ]);
        expect(eps.map((e) => e.slug)).toEqual([
            "google-vertex/europe",
            "google-vertex/us-east5",
            "anthropic",
        ]);
    });

    it("flags tool-call support per endpoint", async () => {
        global.fetch = vi.fn(async () => ({ ok: true, json: async () => RESPONSE }));
        const eps = await listModelEndpoints("anthropic/claude-sonnet-4.6");
        expect(eps.find((e) => e.slug === "google-vertex/europe").supportsTools).toBe(true);
        expect(eps.find((e) => e.slug === "anthropic").supportsTools).toBe(false);
    });

    it("hits the endpoints URL with Bearer auth when a key is given", async () => {
        const fetchMock = vi.fn(async () => ({ ok: true, json: async () => RESPONSE }));
        global.fetch = fetchMock;
        await listModelEndpoints("z-ai/glm-5.2", "sk-test");
        const [url, opts] = fetchMock.mock.calls[0];
        expect(url).toBe("https://openrouter.ai/api/v1/models/z-ai/glm-5.2/endpoints");
        expect(opts.headers.Authorization).toBe("Bearer sk-test");
    });

    it("caches per model id — repeated calls fetch once", async () => {
        const fetchMock = vi.fn(async () => ({ ok: true, json: async () => RESPONSE }));
        global.fetch = fetchMock;
        await listModelEndpoints("z-ai/glm-5.2");
        await listModelEndpoints("z-ai/glm-5.2");
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does not cache a failure — retries on the next call", async () => {
        let n = 0;
        global.fetch = vi.fn(async () => {
            n += 1;
            return n === 1
                ? { ok: false, status: 500, statusText: "err" }
                : { ok: true, json: async () => RESPONSE };
        });
        await expect(listModelEndpoints("m")).rejects.toThrow(/500/);
        const eps = await listModelEndpoints("m");
        expect(eps).toHaveLength(3);
    });

    it("returns [] for an empty model id without fetching", async () => {
        const fetchMock = vi.fn();
        global.fetch = fetchMock;
        expect(await listModelEndpoints("")).toEqual([]);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
