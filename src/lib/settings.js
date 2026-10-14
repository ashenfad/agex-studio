/**
 * Settings: the model the studio talks to, and how, persisted to
 * localStorage on this device (the key never leaves it except to the
 * endpoint it is for).
 */

export const STORAGE_KEY = "agex-studio-settings";

/**
 * @typedef {Object} Settings
 * @property {string} apiKey
 * @property {"openrouter" | "custom" | "scripted"} accessMode — which
 *     service: OpenRouter, an endpoint of the user's own (`baseUrl`, in
 *     the `wire` shape: a direct provider, a local Meridian, a
 *     self-hosted proxy), or, in dev builds only, a scripted model.
 * @property {string} model
 * @property {"anthropic" | "openai"} wire — a custom endpoint's shape.
 * @property {string} baseUrl — a custom endpoint's URL.
 * @property {"off" | "low" | "medium" | "high"} thinking — how hard the
 *     model thinks per turn, which each provider maps for its model.
 */

/** @type {Settings} */
export const DEFAULTS = {
    apiKey: "",
    accessMode: "openrouter",
    model: "google/gemini-3.8-flash",
    wire: "anthropic",
    baseUrl: "",
    thinking: "medium",
};

/** @type {((s: Settings) => void)[]} */
let subscribers = [];

/** @type {Settings} */
let settings = load();

/** @returns {Settings} */
function load() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
    } catch {
        // unreadable or unavailable storage: start from the defaults
    }
    return { ...DEFAULTS };
}

/** Settings as a Svelte store. */
export const settingsStore = {
    /** @param {(s: Settings) => void} fn */
    subscribe(fn) {
        subscribers.push(fn);
        fn(settings);
        return () => {
            subscribers = subscribers.filter((s) => s !== fn);
        };
    },
};

/** @param {Partial<Settings>} patch */
export function updateSettings(patch) {
    settings = { ...settings, ...patch };
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
        // kept for this page's life only
    }
    for (const fn of subscribers) fn(settings);
}

/** The settings now: a snapshot, replaced (never changed) by updates.
 *  @returns {Settings} */
export function getSettings() {
    return settings;
}

/** Whether the settings can reach a model.
 *  @param {Settings} s */
export function isConfigured(s) {
    if (s.accessMode === "scripted") return true;
    if (s.model.trim() === "") return false;
    if (s.accessMode === "custom") return s.baseUrl.trim() !== "";
    return s.apiKey.trim() !== "";
}
