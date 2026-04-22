/**
 * Settings store — API key and model config, persisted to localStorage.
 */

const STORAGE_KEY = "agex-settings";

const DEFAULTS = {
    apiKey: "",
    model: "google/gemini-3-flash-preview",
    provider: "openai",
    baseUrl: "",
    chapteringTrigger: 150000,
    toolUseWireFormat: false,
};

/** @type {((s: Settings) => void)[]} */
let subscribers = [];

/**
 * @typedef {Object} Settings
 * @property {string} apiKey
 * @property {string} model
 * @property {"openai" | "anthropic"} provider
 * @property {string} baseUrl
 * @property {number} chapteringTrigger
 * @property {boolean} toolUseWireFormat — when true, the agex LLM client
 *     is configured with ToolUseWireFormat (provider-native function
 *     calling) instead of the default XmlWireFormat (XML tags in text).
 */

/** @type {Settings} */
let settings = load();

function load() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
    } catch {}
    return { ...DEFAULTS };
}

function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

function notify() {
    for (const fn of subscribers) fn(settings);
}

export const settingsStore = {
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
    save();
    notify();
}

/** @returns {boolean} */
export function isConfigured() {
    return settings.apiKey.length > 0;
}
