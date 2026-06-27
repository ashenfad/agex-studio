/**
 * OpenRouter discovery helpers — list the upstream providers (endpoints)
 * that serve a given model, so the user can hard-pin one.
 *
 * Provider routing (`provider.order` / `provider.only`) takes a provider
 * SLUG, which the endpoints API returns as `tag` (e.g. "deepinfra",
 * "fireworks"); `provider_name` is the display name ("DeepInfra"). We
 * surface both so the UI can show the name and pin by the slug.
 *
 * Docs: https://openrouter.ai/docs/api/api-reference/endpoints/list-endpoints
 */

const BASE = "https://openrouter.ai/api/v1";

/**
 * @typedef {{
 *   slug: string,
 *   name: string,
 *   label: string,
 *   supportsTools: boolean,
 *   status?: string,
 *   pricing?: Record<string, unknown>,
 * }} ProviderEndpoint
 */

/** Human label for an endpoint. `provider_name` alone collides when a
 *  provider serves a model from several regions / variants (Claude on
 *  Vertex: `google-vertex/europe`, `/us-east5`, `/global` all show as
 *  "Google"). The disambiguator is the `tag` suffix after the first `/`
 *  (a region like `europe`, a quantization like `fp8`, or an endpoint
 *  index). Bare tags (no `/`) just use the provider name. */
function _endpointLabel(providerName, tag) {
    const i = tag.indexOf("/");
    const variant = i >= 0 ? tag.slice(i + 1) : "";
    return variant ? `${providerName} (${variant})` : providerName;
}

/** @type {Map<string, Promise<Array<ProviderEndpoint>>>} */
const _cache = new Map();

/**
 * List the provider endpoints for an OpenRouter model id ("author/slug").
 * Cached per model id; a failed lookup is NOT cached, so a transient error
 * (offline, bad key) can be retried by calling again. Returns `[]` for an
 * empty id; rejects on network / non-2xx so callers can surface it.
 *
 * @param {string} modelId
 * @param {string} [apiKey]  Bearer auth — the list works without it, but
 *   include it when present for consistent rate limiting.
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<Array<ProviderEndpoint>>}
 */
export function listModelEndpoints(modelId, apiKey, opts = {}) {
    if (!modelId) return Promise.resolve([]);
    if (!opts.force && _cache.has(modelId)) return _cache.get(modelId);
    const p = _fetchEndpoints(modelId, apiKey).catch((e) => {
        _cache.delete(modelId); // don't cache a failure
        throw e;
    });
    _cache.set(modelId, p);
    return p;
}

async function _fetchEndpoints(modelId, apiKey) {
    const res = await fetch(`${BASE}/models/${modelId}/endpoints`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    if (!res.ok) {
        throw new Error(
            `OpenRouter endpoints ${res.status} ${res.statusText}`.trim(),
        );
    }
    const json = await res.json();
    // Tolerate both documented shapes: `{ data: { endpoints: [...] } }`
    // and a flatter `{ data: [...] }`.
    const data = json?.data;
    const endpoints = Array.isArray(data) ? data : (data?.endpoints ?? []);
    const seen = new Set();
    const out = [];
    for (const e of endpoints) {
        if (!e || typeof e.tag !== "string") continue;
        // Dedupe by routing slug — two entries with the same `tag` pin
        // identically, so showing both would be a confusing no-op.
        if (seen.has(e.tag)) continue;
        seen.add(e.tag);
        const name = e.provider_name || e.tag;
        out.push({
            slug: e.tag,
            name,
            label: _endpointLabel(name, e.tag),
            status: e.status,
            // agex requires tool calling — flag endpoints that can't do it
            // so the UI can warn / sort them down.
            supportsTools:
                Array.isArray(e.supported_parameters) &&
                (e.supported_parameters.includes("tools") ||
                    e.supported_parameters.includes("tool_choice")),
            pricing: e.pricing,
        });
    }
    return out;
}

/** Drop cached endpoint lists (e.g. on api-key change). */
export function clearEndpointCache() {
    _cache.clear();
}
