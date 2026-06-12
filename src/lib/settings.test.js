import { describe, it, expect, vi, beforeEach } from "vitest";

// localStorage stub
const store = {};
vi.stubGlobal("localStorage", {
    getItem: (k) => store[k] ?? null,
    setItem: (k, v) => {
        store[k] = v;
    },
    removeItem: (k) => {
        delete store[k];
    },
});

beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    vi.resetModules();
});

async function loadSettings() {
    return await import("./settings.js");
}

describe("settingsStore", () => {
    it("emits defaults when no saved settings", async () => {
        const { settingsStore } = await loadSettings();
        let received;
        const unsub = settingsStore.subscribe((s) => {
            received = s;
        });
        expect(received).toEqual({
            apiKey: "",
            model: "google/gemini-3.5-flash",
            accessMode: "openrouter",
            provider: "openai",
            baseUrl: "",
            chapteringTrigger: 150000,
            toolUseWireFormat: true,
            reasoningEffort: "medium",
            serviceTier: "standard",
            githubPat: "",
            syncRepo: "",
            syncPat: "",
            syncRepoIsPrivate: true,
            syncAppState: true,
            keepAwake: false,
            notifyOnFinish: false,
            publishShape: "full",
        });
        unsub();
    });

    it("loads saved settings from localStorage", async () => {
        store["agex-settings"] = JSON.stringify({
            apiKey: "sk-test",
            model: "openai/gpt-5.4",
        });
        const { settingsStore } = await loadSettings();
        let received;
        settingsStore.subscribe((s) => {
            received = s;
        });
        expect(received.apiKey).toBe("sk-test");
        expect(received.model).toBe("openai/gpt-5.4");
    });

    it("merges partial saved settings with defaults", async () => {
        store["agex-settings"] = JSON.stringify({ apiKey: "sk-partial" });
        const { settingsStore } = await loadSettings();
        let received;
        settingsStore.subscribe((s) => {
            received = s;
        });
        expect(received.apiKey).toBe("sk-partial");
        expect(received.model).toBe("google/gemini-3.5-flash");
    });

    it("handles corrupt localStorage gracefully", async () => {
        store["agex-settings"] = "not json!!!";
        const { settingsStore } = await loadSettings();
        let received;
        settingsStore.subscribe((s) => {
            received = s;
        });
        expect(received.apiKey).toBe("");
    });

    /** Migration: pre-accessMode settings that were already going through
     * OpenRouter (the only flow we shipped before direct providers were
     * an option) should land on accessMode="openrouter" — not get bumped
     * to "custom" with no URL set, which would be unusable. */
    it("infers accessMode='openrouter' for legacy settings with empty baseUrl", async () => {
        store["agex-settings"] = JSON.stringify({
            apiKey: "sk-or-legacy",
            model: "openai/gpt-5.4",
            provider: "openai",
            baseUrl: "",
        });
        const { settingsStore } = await loadSettings();
        let received;
        settingsStore.subscribe((s) => { received = s });
        expect(received.accessMode).toBe("openrouter");
    });

    it("infers accessMode='custom' from a legacy provider='anthropic'", async () => {
        store["agex-settings"] = JSON.stringify({
            apiKey: "sk-ant-legacy",
            provider: "anthropic",
            baseUrl: "",
        });
        const { settingsStore } = await loadSettings();
        let received;
        settingsStore.subscribe((s) => { received = s });
        // Anthropic-direct users land on "custom" so the URL field is
        // surfaced (Anthropic-direct needs an explicit URL even though
        // it's still browser-friendly).
        expect(received.accessMode).toBe("custom");
        expect(received.provider).toBe("anthropic");
    });

    it("infers accessMode='openrouter' from a legacy openrouter baseUrl", async () => {
        store["agex-settings"] = JSON.stringify({
            apiKey: "sk-or-legacy",
            provider: "openai",
            baseUrl: "https://openrouter.ai/api/v1",
        });
        const { settingsStore } = await loadSettings();
        let received;
        settingsStore.subscribe((s) => { received = s });
        expect(received.accessMode).toBe("openrouter");
    });

    it("collapses the brief-iteration accessMode='openai'/'anthropic' into 'custom'", async () => {
        store["agex-settings"] = JSON.stringify({
            apiKey: "sk-test",
            accessMode: "anthropic",
            provider: "anthropic",
            baseUrl: "",
        });
        const { settingsStore } = await loadSettings();
        let received;
        settingsStore.subscribe((s) => { received = s });
        expect(received.accessMode).toBe("custom");
        expect(received.provider).toBe("anthropic");
    });
});

describe("updateSettings", () => {
    it("notifies subscribers and persists to localStorage", async () => {
        const { settingsStore, updateSettings } = await loadSettings();
        const values = [];
        settingsStore.subscribe((s) => values.push({ ...s }));

        updateSettings({ apiKey: "sk-new" });

        expect(values).toHaveLength(2);
        expect(values[1].apiKey).toBe("sk-new");
        expect(values[1].model).toBe("google/gemini-3.5-flash");

        const saved = JSON.parse(store["agex-settings"]);
        expect(saved.apiKey).toBe("sk-new");
    });

    it("unsubscribe stops notifications", async () => {
        const { settingsStore, updateSettings } = await loadSettings();
        const values = [];
        const unsub = settingsStore.subscribe((s) => values.push({ ...s }));
        unsub();

        updateSettings({ apiKey: "sk-ignored" });
        expect(values).toHaveLength(1);
    });
});

describe("resolveProvider", () => {
    it("auto-detects anthropic in OpenRouter mode for anthropic/* models", async () => {
        const { resolveProvider } = await loadSettings();
        expect(
            resolveProvider({
                accessMode: "openrouter",
                model: "anthropic/claude-sonnet-4.6",
            }),
        ).toBe("anthropic");
        expect(
            resolveProvider({
                accessMode: "openrouter",
                model: "anthropic/claude-haiku-4.5",
            }),
        ).toBe("anthropic");
    });

    it("returns openai in OpenRouter mode for non-anthropic models", async () => {
        const { resolveProvider } = await loadSettings();
        for (const model of [
            "google/gemini-3.5-flash",
            "openai/gpt-5.4",
            "meta-llama/llama-4",
            "mistralai/mistral-large",
        ]) {
            expect(
                resolveProvider({ accessMode: "openrouter", model }),
            ).toBe("openai");
        }
    });

    it("ignores stored provider in OpenRouter mode (model-prefix wins)", async () => {
        const { resolveProvider } = await loadSettings();
        expect(
            resolveProvider({
                accessMode: "openrouter",
                provider: "anthropic", // stored, but should be ignored
                model: "google/gemini-3.5-flash",
            }),
        ).toBe("openai");
        expect(
            resolveProvider({
                accessMode: "openrouter",
                provider: "openai", // stored, but should be ignored
                model: "anthropic/claude-sonnet-4.6",
            }),
        ).toBe("anthropic");
    });

    it("respects explicit provider in Custom mode", async () => {
        const { resolveProvider } = await loadSettings();
        expect(
            resolveProvider({
                accessMode: "custom",
                provider: "anthropic",
                model: "claude-sonnet-4.6",
            }),
        ).toBe("anthropic");
        expect(
            resolveProvider({
                accessMode: "custom",
                provider: "openai",
                model: "gpt-5.4",
            }),
        ).toBe("openai");
    });

    it("defaults to openai when neither openrouter nor custom-provider is set", async () => {
        const { resolveProvider } = await loadSettings();
        expect(resolveProvider({})).toBe("openai");
        expect(resolveProvider({ accessMode: "custom" })).toBe("openai");
        expect(resolveProvider({ accessMode: "openrouter" })).toBe("openai");
    });

    it("handles empty / missing model gracefully in OpenRouter mode", async () => {
        const { resolveProvider } = await loadSettings();
        expect(
            resolveProvider({ accessMode: "openrouter", model: "" }),
        ).toBe("openai");
        expect(resolveProvider({ accessMode: "openrouter" })).toBe("openai");
    });
});
