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

// Hard-pinned (model, provider) pairs we've learned can't honor
// `tool_choice: "required"`. Once a pin proves it can't force tools for a
// model, later calls relax up front instead of eating a 404 every turn.
// Module-lifetime; a provider's tool-calling support effectively never changes.
const _pinNoForcedTools = new Set();

/** Test hook: forget what we've learned about pins and forced tools. */
export function clearForcedToolMemo() {
    _pinNoForcedTools.clear();
}

/** `${model}|${pinnedProviderSlug}` for a request body, or null when it isn't a
 *  hard provider pin we could rescue. */
function _pinKey(body) {
    if (body?.provider?.allow_fallbacks !== false) return null;
    const slug = body.provider.order?.[0];
    return body.model && slug ? `${body.model}|${slug}` : null;
}

function _parseBody(b) {
    try {
        return JSON.parse(typeof b === "string" ? b : "");
    } catch {
        return null;
    }
}

/**
 * A `fetchImpl` for the OpenAI client that keeps a hard provider pin working
 * when the pinned provider can't do forced tool-calling.
 *
 * agex forces tool use (`tool_choice: "required"`), but some OpenRouter
 * endpoints don't support the *forced* value for a given model — Baidu on
 * GLM-5.2, for one. With a hard pin (`allow_fallbacks: false`) that leaves
 * OpenRouter no eligible endpoint, so it returns `404 "No endpoints found"`.
 * Rather than abandon the provider the user explicitly chose, we relax the
 * forced tool choice: retry the same pinned request with `tool_choice: "auto"`,
 * which the provider *can* serve. The pin is honored; the model just isn't
 * compelled to call a tool on that turn. We remember the (model, provider) pair
 * so subsequent calls relax up front rather than paying the 404 each time.
 *
 * Trade-off: under `auto` the pinned model may answer with prose instead of a
 * tool call on some turns. Everything else — successes, unrelated 404s, and
 * requests with no hard pin — passes through untouched.
 *
 * Wired in via `OpenAI({ fetchImpl })`; the client hands us the fully-built
 * request whose JSON body already carries the merged `provider` pin.
 *
 * @param {string | URL | Request} url
 * @param {RequestInit} [init]  `init.body` is the JSON request string.
 * @returns {Promise<Response>}
 */
export async function pinFallbackFetch(url, init) {
    let body = _parseBody(init?.body);
    const key = _pinKey(body);
    // Already known to reject forced tools → relax before we even ask.
    if (key && body.tool_choice === "required" && _pinNoForcedTools.has(key)) {
        body = { ...body, tool_choice: "auto" };
        init = { ...init, body: JSON.stringify(body) };
    }
    const res = await fetch(url, init);
    if (res.status !== 404) return res;
    // Only a hard pin that's still forcing tools can be rescued this way.
    if (!key || body.tool_choice !== "required") return res;
    // Reading the body settles whether this is the forced-tool failure; either
    // way the caller must still be able to read it, so hand back a fresh copy.
    const text = await res.text();
    if (!/no endpoints found/i.test(text)) {
        return new Response(text, {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers,
        });
    }
    // The pinned provider can't force tools for this model. Keep the pin, drop
    // the force, and remember so we skip the wasted 404 next time.
    _pinNoForcedTools.add(key);
    const retried = JSON.stringify({ ...body, tool_choice: "auto" });
    return fetch(url, { ...init, body: retried });
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
