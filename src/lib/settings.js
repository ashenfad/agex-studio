/**
 * Settings: the model the studio talks to, and how, persisted to
 * localStorage on this device (each key never leaves it except to the
 * service it is for).
 */

export const STORAGE_KEY = "agex-studio-settings";

/**
 * @typedef {Object} Settings
 * @property {string} routerKey — an OpenRouter key: the model's, on
 *     OpenRouter; and `web` and `media`'s whatever the model, which run
 *     on OpenRouter.
 * @property {string} endpointKey — a custom endpoint's own key, if it
 *     needs one; it goes only to that endpoint.
 * @property {"openrouter" | "custom" | "scripted"} accessMode — which
 *     service: OpenRouter, an endpoint of the user's own (`baseUrl`, in
 *     the `wire` shape: a direct provider, a local Meridian, a
 *     self-hosted proxy), or, in dev builds only, a scripted model.
 * @property {string} model
 * @property {"anthropic" | "openai"} wire — a custom endpoint's shape.
 * @property {string} baseUrl — a custom endpoint's URL.
 * @property {"off" | "low" | "medium" | "high"} thinking — how hard the
 *     model thinks per turn, which each provider maps for its model.
 * @property {number} foldBudget — the request size, in tokens, past
 *     which earlier turns are folded into a summary; 0 never folds.
 * @property {boolean} vision — whether the model takes images: a
 *     screenshot `test_app` takes, or an image `view_image` reads, is
 *     sent to it only then.
 * @property {string} syncRepo — the GitHub repo sessions sync through
 *     (`owner/name`); empty when sync is off.
 * @property {string} syncToken — a token for that repo (fine-grained,
 *     Contents read and write).
 * @property {string} publishToken — a token that can write gists, to
 *     publish sessions; the sync token is tried when empty.
 * @property {boolean} notifyOnFinish — a desktop notification when a
 *     turn ends while the person isn't looking (see `notify.js`).
 */

/** @type {Settings} */
export const DEFAULTS = {
    routerKey: "",
    endpointKey: "",
    accessMode: "openrouter",
    model: "google/gemini-3.8-flash",
    wire: "anthropic",
    baseUrl: "",
    thinking: "medium",
    foldBudget: 150000,
    vision: true,
    syncRepo: "",
    syncToken: "",
    publishToken: "",
    notifyOnFinish: false,
};

/** @type {((s: Settings) => void)[]} */
let subscribers = [];

/** @type {Settings} */
let settings = load();

/** @returns {Settings} */
function load() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) return migrate({ ...DEFAULTS, ...JSON.parse(raw) });
    } catch {
        // unreadable or unavailable storage: start from the defaults
    }
    return { ...DEFAULTS };
}

/**
 * Settings saved with one `apiKey` for every service, as two keys: an
 * OpenRouter key goes to `routerKey` (on OpenRouter, or one that looks
 * like OpenRouter's left behind on a custom endpoint, which is never
 * sent to that endpoint again); a custom endpoint's own, to
 * `endpointKey`.
 *
 * @param {Settings & { apiKey?: unknown }} s
 * @returns {Settings}
 */
export function migrate(s) {
    const { apiKey, ...rest } = s;
    if (typeof apiKey !== "string" || apiKey.trim() === "") return rest;
    const forRouter = rest.accessMode === "openrouter" || apiKey.trim().startsWith("sk-or-");
    if (forRouter) return { ...rest, routerKey: rest.routerKey || apiKey };
    return { ...rest, endpointKey: rest.endpointKey || apiKey };
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
    return s.routerKey.trim() !== "";
}
