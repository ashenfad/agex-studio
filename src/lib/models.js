/**
 * Model preset lists, gated by access mode + provider.
 *
 * Two consumers today:
 *   - SettingsDrawer: full settings UI (API key, model, baseUrl, etc.)
 *   - ChatInput: quick model-swap picker on the toolbar
 *
 * Both call `presetsFor(accessMode, provider)` to get the list to
 * render. Adding a new model means editing ONE place.
 *
 * The lists encode IDs that are NOT portable across shapes:
 *   - OpenRouter wants `<provider>/<model>` IDs (`anthropic/claude-...`)
 *   - Direct-OpenAI wants bare `gpt-...`
 *   - Direct-Anthropic wants `claude-...` (Anthropic-style hyphens)
 *
 * The label is the agent-facing short form (Claude Opus 4.7), used
 * in the picker UI. The id is what's stored in `settings.model` and
 * passed to the LLM client.
 */

/** @typedef {{ id: string, label: string, extras?: Record<string, unknown> }} ModelPreset
 *  `extras` flows into the LLM client's `extras` option, which the
 *  client merges into the request body. Today's only use is pinning
 *  OpenRouter provider routing for models that have provider-specific
 *  capability constraints (e.g. only some endpoints support
 *  `tool_choice`). */

/** @type {ReadonlyArray<ModelPreset>} */
export const OPENROUTER_MODELS = [
    { id: "openai/gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { id: "openai/gpt-5.6-terra", label: "GPT-5.6 Terra" },
    { id: "openai/gpt-5.6-luna", label: "GPT-5.6 Luna" },
    { id: "anthropic/claude-fable-5.1", label: "Claude Fable 5.1" },
    { id: "anthropic/claude-opus-5", label: "Claude Opus 5" },
    { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5" },
    { id: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5" },
    { id: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
    { id: "google/gemini-3.8-flash", label: "Gemini 3.8 Flash" },
    { id: "google/gemini-3.5-flash-lite", label: "Gemini 3.5 Flash Lite" },
    { id: "z-ai/glm-5.3", label: "GLM 5.3" },
    { id: "z-ai/glm-5.3-flash", label: "GLM 5.3 Flash" },
    { id: "meta/muse-spark-1.3", label: "Muse Spark 1.3" },
];

/** @type {ReadonlyArray<ModelPreset>} */
export const OPENAI_MODELS = [
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
];

/** @type {ReadonlyArray<ModelPreset>} */
export const ANTHROPIC_MODELS = [
    { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
    { id: "claude-opus-5", label: "Claude Opus 5" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
];

/**
 * Return the active preset list for the given access mode + provider.
 * @param {string} mode - 'openrouter' | 'custom'
 * @param {string} prov - 'openai' | 'anthropic'
 * @returns {ReadonlyArray<ModelPreset>}
 */
export function presetsFor(mode, prov) {
    if (mode === "openrouter") return OPENROUTER_MODELS;
    return prov === "anthropic" ? ANTHROPIC_MODELS : OPENAI_MODELS;
}

/**
 * Look up the short label for a model ID, walking all preset lists.
 * Falls back to the ID itself when not in any preset (custom model).
 * @param {string} id
 * @returns {string}
 */
export function labelFor(id) {
    if (!id) return "";
    for (const list of [OPENROUTER_MODELS, OPENAI_MODELS, ANTHROPIC_MODELS]) {
        const hit = list.find((m) => m.id === id);
        if (hit) return hit.label;
    }
    return id;
}

/**
 * Per-model `extras` to fold into the LLM client (request body).
 * Returns an empty object when the model has no extras or isn't in
 * any preset list (custom models). Caller decides whether to honor —
 * today we only inject these in OpenRouter mode, since the only
 * recognized keys (`provider`) are OpenRouter-specific.
 * @param {string} id
 * @returns {Record<string, unknown>}
 */
export function extrasFor(id) {
    if (!id) return {};
    for (const list of [OPENROUTER_MODELS, OPENAI_MODELS, ANTHROPIC_MODELS]) {
        const hit = list.find((m) => m.id === id);
        if (hit) return hit.extras ?? {};
    }
    return {};
}

/**
 * Models that CANNOT see images — text-only. Drives the no-vision note in
 * the agent primer (the agent stops reaching for screenshots / image
 * observations it can't read). Keyed by model id; list both the OpenRouter
 * (`author/slug`) and bare (custom-mode) forms when both are plausible.
 *
 * A static list is deliberate — reliable and offline. (OpenRouter's
 * `architecture.input_modalities` could augment this later, but a model's
 * vision support doesn't change underneath a fixed id.)
 *
 * @type {ReadonlySet<string>}
 */
const NO_VISION = new Set([
    // GLM's flagship line is text-only. Note `glm-5.3-flash` is NOT — the
    // Flash sibling takes image and video input, so listing the family by
    // prefix would wrongly strip vision from it.
    "z-ai/glm-5.3",
    "glm-5.3",
    "z-ai/glm-5.2",
    "glm-5.2",
]);

/**
 * Does this model accept image input? Unknown / unlisted models default to
 * `true` (most modern models are multimodal) — only models KNOWN to be
 * text-only are gated, so we never wrongly strip vision from a capable one.
 *
 * @param {string} modelId
 * @returns {boolean}
 */
export function hasVision(modelId) {
    return !NO_VISION.has(modelId);
}
