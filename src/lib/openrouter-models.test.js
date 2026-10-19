import { beforeEach, describe, expect, it, vi } from "vitest";

// an in-memory localStorage: Node's own global has none of the methods
beforeEach(() => {
    const items = new Map();
    vi.stubGlobal("localStorage", {
        getItem: (k) => items.get(k) ?? null,
        setItem: (k, v) => items.set(k, String(v)),
        clear: () => items.clear(),
    });
    vi.resetModules();
});

const entry = (over = {}) => ({
    id: "google/gemini-3.8-flash",
    name: "Google: Gemini 3.8 Flash",
    context_length: 1048576,
    architecture: { input_modalities: ["text", "image"] },
    pricing: { prompt: "0.00000075", completion: "0.000003" },
    supported_parameters: ["tools", "reasoning", "max_tokens"],
    ...over,
});
const answer = (data) => vi.fn(async () => new Response(JSON.stringify({ data })));

describe("OpenRouter's catalog", () => {
    it("reads a model's facts: context, price per million, images, tools, reasoning", async () => {
        const { readModel } = await import("./openrouter-models.js");
        expect(readModel(entry())).toEqual({
            id: "google/gemini-3.8-flash",
            name: "Google: Gemini 3.8 Flash",
            context: 1048576,
            input: 0.75,
            output: 3,
            images: true,
            tools: true,
            reasoning: true,
        });
        expect(readModel(entry({ architecture: { input_modalities: ["text"] }, supported_parameters: ["max_tokens"] }))).toMatchObject({ images: false, tools: false, reasoning: false });
        expect(readModel({ name: "no id" })).toBeNull();
    });

    it("is fetched once a day and kept, a failed fetch falling back to what was kept", async () => {
        const { loadModels, modelInfo, _reset } = await import("./openrouter-models.js");
        const fetchImpl = answer([entry(), { id: "x/text", name: "Text", supported_parameters: [] }]);
        expect((await loadModels({ fetchImpl, now: 1000 })).map((m) => m.id)).toEqual(["google/gemini-3.8-flash", "x/text"]);
        await loadModels({ fetchImpl, now: 2000 });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(modelInfo("google/gemini-3.8-flash")?.images).toBe(true);
        expect(modelInfo("unknown/model")).toBeNull();
        // a new page: the kept catalog answers at once, before any fetch
        _reset();
        expect(modelInfo("x/text")?.tools).toBe(false);
        // stale, and the fetch fails: the kept one still answers
        const failing = vi.fn(async () => new Response("down", { status: 503 }));
        expect((await loadModels({ fetchImpl: failing, now: 1000 + 2 * 86400000 })).length).toBe(2);
    });

    it("announces each catalog that arrives, so what read the old one reads again", async () => {
        const { catalogStore, loadModels } = await import("./openrouter-models.js");
        const seen = [];
        const stop = catalogStore.subscribe((n) => seen.push(n));
        await loadModels({ fetchImpl: answer([entry()]), now: 1000 });
        // still fresh: no fetch, no new arrival
        await loadModels({ fetchImpl: answer([entry()]), now: 2000 });
        stop();
        expect(seen).toEqual([0, 1]);
    });

    it("finds models by every word, those that call tools unless asked, best first", async () => {
        const { readModel, searchModels } = await import("./openrouter-models.js");
        const models = [
            entry({ id: "openai/gpt-x", name: "OpenAI: GPT X" }),
            entry({ id: "anthropic/claude-sonnet-5", name: "Anthropic: Claude Sonnet 5" }),
            entry({ id: "acme/claude-clone", name: "Claude Clone", supported_parameters: [] }),
        ].map((m) => /** @type {any} */ (readModel(m)));
        expect(searchModels(models, "claude").map((m) => m.id)).toEqual(["anthropic/claude-sonnet-5"]);
        // a name that starts with the query ranks above one that only holds it
        expect(searchModels(models, "claude", { all: true }).map((m) => m.id)).toEqual(["acme/claude-clone", "anthropic/claude-sonnet-5"]);
        expect(searchModels(models, "anthropic sonnet").map((m) => m.id)).toEqual(["anthropic/claude-sonnet-5"]);
        // an id that starts with the query comes first
        expect(searchModels(models, "openai").map((m) => m.id)[0]).toBe("openai/gpt-x");
    });

    it("labels context and price for a person", async () => {
        const { contextLabel, priceLabel } = await import("./openrouter-models.js");
        expect([contextLabel(1048576), contextLabel(200000), contextLabel(32768), contextLabel(null)]).toEqual(["1M", "200k", "33k", ""]);
        expect([priceLabel(0), priceLabel(0.75), priceLabel(15), priceLabel(null)]).toEqual(["free", "$0.75", "$15", ""]);
    });
});

describe("what the studio reads off the model in use", () => {
    it("takes vision and the fold budget's ceiling from OpenRouter's catalog, the settings elsewhere", async () => {
        const { loadModels } = await import("./openrouter-models.js");
        await loadModels({ fetchImpl: answer([entry(), entry({ id: "small/text", context_length: 32000, architecture: { input_modalities: ["text"] } })]), now: 1 });
        const { visionOf, foldBudgetOf, modelOf } = await import("./model.js");
        const { DEFAULTS } = await import("./settings.js");
        const router = (over) => ({ ...DEFAULTS, accessMode: "openrouter", ...over });
        expect(visionOf(router({ routerModel: "small/text", vision: true }))).toBe(false);
        expect(visionOf(router({ routerModel: "unlisted/model", vision: false }))).toBe(false);
        expect(visionOf({ ...DEFAULTS, accessMode: "custom", vision: true })).toBe(true);
        // a 32k window folds by 24k, whatever the setting; a large one keeps the setting
        expect(foldBudgetOf(router({ routerModel: "small/text", foldBudget: 150000 }))).toBe(24000);
        expect(foldBudgetOf(router({ routerModel: "google/gemini-3.8-flash", foldBudget: 150000 }))).toBe(150000);
        expect(foldBudgetOf(router({ routerModel: "small/text", foldBudget: 0 }))).toBe(0);
        expect(modelOf({ ...DEFAULTS, accessMode: "custom", endpointModel: " local " })).toBe("local");
    });
});
