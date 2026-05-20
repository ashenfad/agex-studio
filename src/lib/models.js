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
    { id: "openai/gpt-5.4", label: "GPT-5.4" },
    { id: "openai/gpt-5.4-mini", label: "GPT-5.4 Mini" },
    { id: "openai/gpt-5.4-nano", label: "GPT-5.4 Nano" },
    { id: "anthropic/claude-opus-4.7", label: "Claude Opus 4.7" },
    { id: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6" },
    { id: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5" },
    { id: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
    { id: "google/gemini-3.5-flash", label: "Gemini 3.5 Flash" },
    { id: "google/gemini-3.1-flash-lite-preview", label: "Gemini 3.1 Flash Lite" },
    { id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro" },
    {
        id: "qwen/qwen3.6-35b-a3b",
        label: "Qwen 3.6 35B A3B",
        // Pin to AkashML — other OpenRouter endpoints for this model
        // don't expose `tool_choice`, which agex needs to force the
        // task_success / task_fail call.
        extras: { provider: { only: ["akashml"] } },
    },
    { id: "google/gemma-4-31b-it", label: "Gemma 4 31B" },
];

/** @type {ReadonlyArray<ModelPreset>} */
export const OPENAI_MODELS = [
    { id: "gpt-5.4", label: "GPT-5.4" },
    { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
    { id: "gpt-5.4-nano", label: "GPT-5.4 Nano" },
];

/** @type {ReadonlyArray<ModelPreset>} */
export const ANTHROPIC_MODELS = [
    { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
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
