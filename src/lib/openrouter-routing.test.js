import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUTO, _reset, endpointLabel, loadEndpoints, readEndpoint, routeOf, routingOf, withRoute } from "./openrouter-routing.js";
import { DEFAULTS } from "./settings.js";

beforeEach(() => _reset());

const endpoint = (over = {}) => ({
    name: "Google | google/gemini-3.8-flash",
    provider_name: "Google",
    tag: "google-vertex/global",
    quantization: "unknown",
    context_length: 1048576,
    pricing: { prompt: "0.00000075", completion: "0.00000375" },
    status: 0,
    uptime_last_30m: 99.5,
    latency_last_30m: null,
    throughput_last_30m: null,
    ...over,
});
const answer = (endpoints, status = 200) =>
    vi.fn(async () => new Response(JSON.stringify(status === 200 ? { data: { id: "m", endpoints } } : { error: { code: status } }), { status }));

const router = (over = {}) => ({ ...DEFAULTS, accessMode: /** @type {const} */ ("openrouter"), routerModel: "google/gemini-3.8-flash", ...over });

describe("a model's providers", () => {
    it("reads an endpoint: tag, provider, price per million, quantization and uptime when known", () => {
        expect(readEndpoint(endpoint())).toEqual({
            tag: "google-vertex/global",
            provider: "Google",
            quantization: null,
            context: 1048576,
            input: 0.75,
            output: 3.75,
            uptime: 99.5,
        });
        expect(readEndpoint(endpoint({ quantization: "fp8", uptime_last_30m: null }))).toMatchObject({ quantization: "fp8", uptime: null });
        expect(readEndpoint(endpoint({ tag: "" }))).toBeNull();
    });

    it("are fetched once per model, by its id; a model OpenRouter doesn't list has none", async () => {
        const fetchImpl = answer([endpoint(), endpoint({ provider_name: "Google AI Studio", tag: "google-ai-studio" })]);
        const list = await loadEndpoints("google/gemini-3.8-flash", { fetchImpl });
        expect(list?.map((e) => e.tag)).toEqual(["google-vertex/global", "google-ai-studio"]);
        await loadEndpoints("google/gemini-3.8-flash", { fetchImpl });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(fetchImpl.mock.calls[0][0]).toBe("https://openrouter.ai/api/v1/models/google/gemini-3.8-flash/endpoints");
        expect(await loadEndpoints("nobody/nothing", { fetchImpl: answer([], 404) })).toBeNull();
    });

    it("are asked again after a failed fetch", async () => {
        await expect(loadEndpoints("x/y", { fetchImpl: answer([], 502) })).rejects.toThrow(/502/);
        expect(await loadEndpoints("x/y", { fetchImpl: answer([endpoint()]) })).toHaveLength(1);
    });

    it("are labelled by provider, with the variant when a provider has several", () => {
        const all = [
            readEndpoint(endpoint({ tag: "google-vertex/global" })),
            readEndpoint(endpoint({ tag: "google-vertex/global/flex", pricing: { prompt: "0.000000375", completion: "0.000001875" } })),
            readEndpoint(endpoint({ provider_name: "DeepInfra", tag: "deepinfra/turbo", quantization: "fp8", uptime_last_30m: 100 })),
        ].filter((e) => e !== null);
        expect(all.map((e) => endpointLabel(e, all))).toEqual([
            "Google (global) · $0.75 in, $3.75 out · 99.5% up",
            "Google (global/flex) · $0.38 in, $1.88 out · 99.5% up",
            "DeepInfra · $0.75 in, $3.75 out · fp8 · 100% up",
        ]);
    });
});

describe("routing", () => {
    it("sends nothing when everything is left to OpenRouter", () => {
        expect(routingOf(router())).toBeUndefined();
    });

    it("asks a chosen provider first, with fallback unless it's that one only", () => {
        const one = (only) => router({ routerRouting: { "google/gemini-3.8-flash": { provider: "google-vertex/global", only, sort: null } } });
        expect(routingOf(one(false))).toEqual({ order: ["google-vertex/global"], allow_fallbacks: true });
        expect(routingOf(one(true))).toEqual({ order: ["google-vertex/global"], allow_fallbacks: false });
    });

    it("sorts by a preference only when no provider is chosen", () => {
        expect(routingOf(router({ routerRouting: { "google/gemini-3.8-flash": { provider: null, only: false, sort: "price" } } }))).toEqual({ sort: "price" });
        expect(routingOf(router({ routerRouting: { "google/gemini-3.8-flash": { provider: "anthropic", only: false, sort: "latency" } } }))).toEqual({
            order: ["anthropic"],
            allow_fallbacks: true,
        });
    });

    it("adds the privacy settings, whatever the model", () => {
        expect(routingOf(router({ routerDenyTraining: true }))).toEqual({ data_collection: "deny" });
        expect(routingOf(router({ routerZdr: true }))).toEqual({ zdr: true });
        expect(
            routingOf(router({ routerDenyTraining: true, routerZdr: true, routerRouting: { "google/gemini-3.8-flash": { provider: null, only: false, sort: "throughput" } } })),
        ).toEqual({ sort: "throughput", data_collection: "deny", zdr: true });
    });

    it("is kept per model: one model's route leaves another's", () => {
        let routing = withRoute({}, "google/gemini-3.8-flash", { provider: "google-ai-studio", only: true, sort: null });
        routing = withRoute(routing, "anthropic/claude-sonnet-4.5", { provider: null, only: false, sort: "price" });
        const s = router({ routerRouting: routing });
        expect(routeOf(s, "google/gemini-3.8-flash")).toEqual({ provider: "google-ai-studio", only: true, sort: null });
        expect(routeOf(s, "anthropic/claude-sonnet-4.5")).toEqual({ provider: null, only: false, sort: "price" });
        expect(routeOf(s, "meta-llama/llama-3.3-70b-instruct")).toEqual(AUTO);
        expect(routingOf({ ...s, routerModel: "anthropic/claude-sonnet-4.5" })).toEqual({ sort: "price" });
        expect(routingOf({ ...s, routerModel: "meta-llama/llama-3.3-70b-instruct" })).toBeUndefined();
        // back to Auto drops the entry; only and sort apply only where they mean something
        expect(Object.keys(withRoute(routing, "google/gemini-3.8-flash", AUTO))).toEqual(["anthropic/claude-sonnet-4.5"]);
        expect(withRoute({}, "m", { provider: null, only: true, sort: "price" }).m).toEqual({ provider: null, only: false, sort: "price" });
        expect(withRoute({}, "m", { provider: "p", only: false, sort: "price" }).m).toEqual({ provider: "p", only: false, sort: null });
    });
});
