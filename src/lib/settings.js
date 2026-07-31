/**
 * Settings store — API key and model config, persisted to localStorage.
 */

export const STORAGE_KEY = "agex-settings";

const RETIRED_OPENROUTER_MODEL = "google/gemini-3.5-flash";
const DEFAULT_OPENROUTER_MODEL = "google/gemini-3.6-flash";

const DEFAULTS = {
    apiKey: "",
    model: DEFAULT_OPENROUTER_MODEL,
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
    // OpenRouter's `service_tier` passthrough. `standard` means
    // "don't send the field"; `flex` opts into the lower-cost,
    // higher-latency tier (OpenAI: ~50% off gpt-5 last we checked);
    // `priority` opts into faster + costlier. Only honored by
    // OpenAI and Google models — see `supportsServiceTier` in
    // models.js for the gating rule.
    serviceTier: "standard",
    // OpenRouter provider pins, keyed by model id ("author/slug"). When
    // set, the user has chosen a specific upstream provider for that model;
    // `_buildLlmClient` hard-pins it (`provider.order` + no fallbacks). A
    // model absent from the map (or in custom mode) routes normally.
    providerPins: {},
    githubPat: "",
    // Session sync (cross-device, via a dedicated GitHub repo). Both
    // empty = not connected. `syncPat` is a fine-grained token scoped
    // to ONLY `syncRepo` with Contents read/write — deliberately a
    // separate credential from `githubPat` (classic, gist scope):
    // different trust levels, independently revocable. Set by the
    // connect wizard in SettingsDrawer via sync-settings.js.
    syncRepo: "",
    syncPat: "",
    // Whether syncRepo is private, captured at connect time. False
    // drives a persistent world-readable warning in the drawer; null
    // (unknown — privacy lookup failed) is treated as private rather
    // than crying wolf. Reset to true on disconnect.
    syncRepoIsPrivate: true,
    // Sync app save data (the iframe localStorage bag) alongside the
    // session. Default on — repo growth is handled structurally by
    // the engine's orphan-squash of app-state history.
    syncAppState: true,
    // Hold a screen wake lock while any session has a turn in flight, so
    // the display doesn't dim during long agent turns. Surfaced in the
    // session drawer; auto-released when the tab is hidden (the browser
    // does this) and re-acquired on return.
    keepAwake: false,
    // Fire a desktop notification when a session finishes a turn while
    // its result isn't on screen (different session foreground, or tab
    // hidden). Surfaced in the session drawer; gated on the browser
    // notification permission grant in addition to this flag.
    notifyOnFinish: false,
    // Last-used publish shape ('full' | 'flat' | 'flat-downsample' |
    // 'flat-strip') — remembered across publishes so an image-heavy
    // workflow isn't re-choosing every time.
    publishShape: "full",
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
 * @property {"standard" | "flex" | "priority"} serviceTier — OpenRouter
 *     `service_tier` passthrough.  ``standard`` omits the field entirely
 *     (use the provider's default tier).  ``flex`` opts into the lower-
 *     cost / higher-latency tier; ``priority`` opts into faster + more
 *     expensive.  Only meaningful for OpenAI and Google models per
 *     OpenRouter's documentation; gated in the UI via
 *     ``supportsServiceTier`` in models.js.
 * @property {string} githubPat — GitHub Personal Access Token with
 *     ``gist`` scope.  Used to publish artifact bundles as secret
 *     gists.  Stored locally; never sent anywhere except api.github.com.
 *     Empty string when the user hasn't connected GitHub yet.
 * @property {string} syncRepo — ``owner/name`` of the dedicated session
 *     sync repo, or empty when sync isn't connected.  Set by the
 *     connect wizard after discovery + validation (sync-settings.js).
 * @property {string} syncPat — fine-grained PAT scoped to ONLY
 *     ``syncRepo`` with Contents read/write.  Deliberately separate
 *     from ``githubPat`` (different trust level, independently
 *     revocable).  Stored locally; sent only to api.github.com.
 * @property {boolean} syncRepoIsPrivate — privacy of ``syncRepo`` as
 *     observed at connect time.  False renders a persistent
 *     world-readable warning next to the connected state.
 * @property {boolean} syncAppState — replicate app save data across
 *     devices as an app-state sidecar.  Toggle in the Sync section.
 * @property {boolean} keepAwake — hold a screen wake lock while a session
 *     has a turn in flight (display won't dim during long turns).
 * @property {boolean} notifyOnFinish — fire a desktop notification when a
 *     session finishes a turn while its result isn't on screen. Also
 *     gated on the browser notification permission.
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
            // Move existing OpenRouter users off the retired Gemini model.
            // Custom model IDs remain user-controlled, so only migrate this
            // exact retired preset when it is stored.
            if (
                merged.accessMode === "openrouter" &&
                merged.model === RETIRED_OPENROUTER_MODEL
            ) {
                merged.model = DEFAULT_OPENROUTER_MODEL;
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

/** Return a snapshot of the current settings object.
 *
 *  Use over the Svelte-store `subscribe` contract when you need a
 *  one-shot read inside a non-reactive code path (e.g. an `agent.fn`
 *  handler that runs each time the agent calls it). The returned
 *  reference is the live module-level object — callers must not
 *  mutate it. `updateSettings` always assigns a fresh object, so the
 *  snapshot is safe to retain locally for the duration of one call.
 *
 *  @returns {Settings}
 */
export function getSettings() {
    return settings;
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
 *  Caller must omit `@agex-ts/anthropic`'s default `anthropic-version`
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
