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
    toolUseWireFormat: true,
    reasoningEffort: "medium",
    githubPat: "",
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
 * @property {boolean} toolUseWireFormat — when true (default), the
 *     agex LLM client uses native model reasoning (Claude extended
 *     thinking, Gemini thought parts, OpenAI Responses, OpenRouter
 *     reasoning_details).  Set false for non-reasoning models / routes
 *     to fall back to narration-in-schema thinking.
 * @property {"low" | "medium" | "high"} reasoningEffort — how hard the
 *     model should think per turn when native reasoning is on.  Maps to
 *     OpenRouter's ``reasoning.effort`` and to an Anthropic
 *     ``budget_tokens`` (1024 / 2048 / 4096).  Ignored when
 *     toolUseWireFormat is false.
 * @property {string} githubPat — GitHub Personal Access Token with
 *     ``gist`` scope.  Used to publish artifact bundles as secret
 *     gists.  Stored locally; never sent anywhere except api.github.com.
 *     Empty string when the user hasn't connected GitHub yet.
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
