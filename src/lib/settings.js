/**
 * Settings store — API key and model config, persisted to localStorage.
 */

const STORAGE_KEY = "agex-settings";

const DEFAULTS = {
    apiKey: "",
    model: "google/gemini-3-flash-preview",
    // ``accessMode`` is the user-facing primary control: which service
    // we're talking to.  Two modes:
    //   "openrouter" — managed: fixed base URL, key + model is enough.
    //   "custom"     — bring-your-own endpoint: user-supplied URL plus
    //                  a wire-format choice (OpenAI / Anthropic shape).
    //                  Covers Anthropic direct (browser-friendly with
    //                  the dangerous-direct-browser-access header),
    //                  self-hosted vLLM / Ollama / LiteLLM proxies,
    //                  any OpenAI-compatible third-party endpoint.
    //                  OpenAI's own direct API has no browser CORS
    //                  support, so it is not a viable mode here.
    accessMode: "openrouter",
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
 * @property {"openrouter" | "custom"} accessMode — which service we're
 *     talking to.  ``openrouter`` is the managed default; ``custom``
 *     means a user-supplied URL with a chosen wire format (covers
 *     Anthropic direct, self-hosted vLLM / Ollama / LiteLLM, and any
 *     OpenAI-compatible third-party endpoint).  Drives placeholders,
 *     model presets, and which fields the drawer surfaces.
 * @property {"openai" | "anthropic"} provider — wire format / Python
 *     LLM client (PyfetchOpenAI vs PyfetchAnthropic).  In Custom mode
 *     this is the user's explicit shape choice.  In OpenRouter mode
 *     it defaults to ``openai`` and can be overridden in Advanced
 *     for routes that prefer Anthropic's format.
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
        if (raw) {
            const stored = JSON.parse(raw);
            const merged = { ...DEFAULTS, ...stored };
            // Migrate pre-accessMode settings: infer the mode from the
            // stored ``provider`` + ``baseUrl`` so existing users don't
            // get bumped to the OpenRouter default with the wrong key.
            // Anything that isn't clearly OpenRouter lands on "custom"
            // (preserving the stored provider + baseUrl as the
            // configured shape / endpoint).
            if (stored.accessMode === undefined) {
                if (merged.provider === "anthropic" || merged.baseUrl) {
                    merged.accessMode = /openrouter/i.test(merged.baseUrl || "")
                        ? "openrouter"
                        : "custom";
                } else {
                    // No baseUrl + provider=openai pre-migration almost
                    // always meant OpenRouter (the only flow we shipped
                    // before direct providers were on the table).
                    merged.accessMode = "openrouter";
                }
            } else if (
                stored.accessMode === "openai" ||
                stored.accessMode === "anthropic"
            ) {
                // Earlier brief 3-mode iteration ("openrouter" /
                // "openai" / "anthropic") collapsed into 2.  Both
                // direct-provider modes fold into "custom"; preserve
                // the wire format via ``provider``.
                merged.accessMode = "custom";
            }
            return merged;
        }
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

/** Resolve the effective LLM base URL from a settings object.
 *
 *  Custom mode: the user's explicit `baseUrl` wins.
 *  OpenRouter mode: maps to OpenRouter's OpenAI-compatible endpoint.
 *  Anything else (no mode + no URL): empty string, which signals
 *  "use the underlying client's default" to the kernel adapter.
 *
 *  Centralizing here means both kernels see the same URL — the
 *  resolution doesn't depend on which client library happens to
 *  have which default (agex-py's `PyfetchOpenAI` defaults to
 *  OpenRouter; agex-ts's `OpenAI` defaults to api.openai.com).
 *
 *  @param {{ baseUrl?: string, accessMode?: string }} s
 *  @returns {string}
 */
export function resolveBaseUrl(s) {
    if (s.baseUrl) return s.baseUrl;
    if (s.accessMode === "openrouter") return "https://openrouter.ai/api/v1";
    return "";
}

/** Resolve the effective LLM wire-format provider from a settings object.
 *
 *  Custom mode: the user's explicit `provider` choice wins.
 *  OpenRouter mode: pick wire shape from the model ID. Anthropic models
 *    (`anthropic/claude-…`) route to OpenRouter's Anthropic-shape
 *    endpoint (`/v1/messages`) so `cache_control` markers flow
 *    through — the OpenAI-shape endpoint silently drops them.
 *    Everything else (OpenAI, Gemini, Meta, Mistral, …) uses the
 *    OpenAI shape; Gemini's implicit caching still works there.
 *
 *  Caller must omit `agex-anthropic`'s default `anthropic-version`
 *  header when targeting OpenRouter (their CORS allow-list rejects
 *  it). See `_buildLlmClient` in `ts-agent.js` / `_llmConfig` in
 *  `agent.js` for the per-target header overrides.
 *
 *  The `<provider>/<model>` ID convention is enforced consistently
 *  on OpenRouter, so prefix-matching `anthropic/` is reliable.
 *
 *  @param {{ provider?: string, accessMode?: string, model?: string }} s
 *  @returns {"openai" | "anthropic"}
 */
export function resolveProvider(s) {
    if (s.accessMode === "openrouter") {
        if (s.model && s.model.startsWith("anthropic/")) {
            return "anthropic";
        }
        return "openai";
    }
    return s.provider === "anthropic" ? "anthropic" : "openai";
}
