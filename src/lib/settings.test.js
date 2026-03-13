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
            model: "google/gemini-3-flash-preview",
            chapteringTrigger: 150000,
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
        expect(received.model).toBe("google/gemini-3-flash-preview");
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
});

describe("updateSettings", () => {
    it("notifies subscribers and persists to localStorage", async () => {
        const { settingsStore, updateSettings } = await loadSettings();
        const values = [];
        settingsStore.subscribe((s) => values.push({ ...s }));

        updateSettings({ apiKey: "sk-new" });

        expect(values).toHaveLength(2);
        expect(values[1].apiKey).toBe("sk-new");
        expect(values[1].model).toBe("google/gemini-3-flash-preview");

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
