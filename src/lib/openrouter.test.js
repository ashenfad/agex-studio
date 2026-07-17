import { describe, it, expect, vi, beforeEach } from "vitest";
import {
    listModelEndpoints,
    clearEndpointCache,
    pinFallbackFetch,
    clearForcedToolMemo,
} from "./openrouter.js";

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

describe("pinFallbackFetch", () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        clearForcedToolMemo();
    });

    const URL = "https://openrouter.ai/api/v1/chat/completions";
    const hardPinBody = (extra = {}) =>
        JSON.stringify({
            model: "z-ai/glm-5.2",
            tool_choice: "required",
            provider: { order: ["baidu/fp8"], allow_fallbacks: false },
            ...extra,
        });
    const noEndpoints = () =>
        new Response(
            JSON.stringify({ error: { message: "No endpoints found for z-ai/glm-5.2.", code: 404 } }),
            { status: 404, statusText: "Not Found" },
        );

    it("keeps the pin but relaxes forced tools on 'No endpoints found'", async () => {
        const ok = new Response("stream", { status: 200 });
        const fetchMock = vi.fn().mockResolvedValueOnce(noEndpoints()).mockResolvedValueOnce(ok);
        global.fetch = fetchMock;

        const res = await pinFallbackFetch(URL, { method: "POST", body: hardPinBody() });

        expect(res.status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        // retry keeps the hard pin untouched, only drops the forced tool choice
        const retryBody = JSON.parse(fetchMock.mock.calls[1][1].body);
        expect(retryBody.provider).toEqual({ order: ["baidu/fp8"], allow_fallbacks: false });
        expect(retryBody.tool_choice).toBe("auto");
    });

    it("memoizes: after one failure it relaxes up front, no wasted 404", async () => {
        global.fetch = vi
            .fn()
            .mockResolvedValueOnce(noEndpoints()) // first call: force fails
            .mockResolvedValue(new Response("stream", { status: 200 }));

        await pinFallbackFetch(URL, { method: "POST", body: hardPinBody() }); // learns it
        const second = vi.fn().mockResolvedValue(new Response("stream", { status: 200 }));
        global.fetch = second;

        await pinFallbackFetch(URL, { method: "POST", body: hardPinBody() });

        // single request, already relaxed — no 404 round-trip
        expect(second).toHaveBeenCalledTimes(1);
        expect(JSON.parse(second.mock.calls[0][1].body).tool_choice).toBe("auto");
    });

    it("passes a successful response straight through without reading it", async () => {
        const ok = new Response("stream", { status: 200 });
        const fetchMock = vi.fn().mockResolvedValue(ok);
        global.fetch = fetchMock;

        const res = await pinFallbackFetch(URL, { method: "POST", body: hardPinBody() });

        expect(res).toBe(ok); // same object → body still unconsumed for the streamer
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does not retry an unrelated 404, but keeps its body readable", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue(new Response("model not found", { status: 404, statusText: "Not Found" }));
        global.fetch = fetchMock;

        const res = await pinFallbackFetch(URL, { method: "POST", body: hardPinBody() });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(res.status).toBe(404);
        expect(await res.text()).toBe("model not found");
    });

    it("does not retry when there is no hard pin", async () => {
        const fetchMock = vi.fn().mockResolvedValue(noEndpoints());
        global.fetch = fetchMock;

        const body = JSON.stringify({ model: "z-ai/glm-5.2" }); // no provider pin
        const res = await pinFallbackFetch(URL, { method: "POST", body });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(res.status).toBe(404);
    });
});
