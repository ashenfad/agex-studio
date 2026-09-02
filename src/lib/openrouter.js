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

// Routes we've learned can't honor `tool_choice: "required"`. Once a route
// refuses, later calls relax up front instead of eating a failed request
// every turn. Module-lifetime — deliberately forgotten on reload, so a
// provider that gains support (or a lucky first draw that didn't) is
// re-probed next session at the cost of one cheap round trip.
const _noForcedTools = new Set();

/** Test hook: forget what we've learned about routes and forced tools. */
export function clearForcedToolMemo() {
    _noForcedTools.clear();
}

/** Memo key for a request body: `${model}|${pinnedProviderSlug}` under a hard
 *  provider pin, bare `${model}` when routing is open (no pin to name, so the
 *  refusal is remembered for the model as a whole). Null without a model.
 *
 *  Keying open routing by model alone is deliberately coarse: OpenRouter picks
 *  an endpoint per request, so one refusal downgrades the model for every turn
 *  this page load even though a different draw might have honored the force.
 *  The alternative — re-probing every turn — costs a failed request each time.
 *  Bounded by module lifetime, so the coarseness expires on reload. */
function _memoKey(body) {
    if (!body?.model) return null;
    const pinned =
        body.provider?.allow_fallbacks === false ? body.provider.order?.[0] : null;
    return pinned ? `${body.model}|${pinned}` : body.model;
}

// Statuses that can carry a forced-tool refusal. 404 is OpenRouter's own
// routing refusal ("No endpoints found that support the provided
// 'tool_choice' value"); 400 is an upstream provider rejecting the value
// after OpenRouter already routed to it — Meta on Muse Spark answers
// `only "auto" is supported for tool_choice`. Both are pre-stream HTTP
// responses, which is what makes them catchable here at all.
const _RETRY_STATUS = new Set([400, 404]);

/** Does this error body say the request failed over forced tool choice?
 *  Matched against the raw text: OpenRouter nests the upstream provider's
 *  error as an escaped JSON string, so a regex sees `tool_choice` at any
 *  depth without us having to unwrap the envelope. */
function _isForcedToolRefusal(text) {
    return /tool_choice/i.test(text) || /no endpoints found/i.test(text);
}

function _parseBody(b) {
    try {
        return JSON.parse(typeof b === "string" ? b : "");
    } catch {
        return null;
    }
}

/**
 * A `fetchImpl` for the OpenAI client that keeps an OpenRouter route working
 * when it can't do forced tool-calling.
 *
 * agex forces tool use (`tool_choice: "required"`), but some routes won't
 * serve the *forced* value for a given model, in two distinct shapes:
 *
 *   - OpenRouter refuses to route at all — `404 "No endpoints found that
 *     support the provided 'tool_choice' value"`. Under a hard pin
 *     (`allow_fallbacks: false`) there's no eligible endpoint left; Baidu on
 *     GLM-5.2 is the case that first surfaced this.
 *   - OpenRouter routes fine and the *upstream provider* rejects the value —
 *     `400 only "auto" is supported for tool_choice`, which is Meta on Muse
 *     Spark. Note this can't be predicted from the endpoints API: Meta
 *     declares `tool_choice` in `supported_parameters`, since that lists
 *     parameter *names*, not which values each one accepts.
 *
 * Either way, rather than fail the turn we relax the forced tool choice and
 * retry with `tool_choice: "auto"`, which the route *can* serve. Any provider
 * pin is preserved untouched — the user's choice is honored, the model just
 * isn't compelled to call a tool. The route is remembered (see `_memoKey`) so
 * later turns relax up front instead of re-paying the failed request.
 *
 * The retry is invisible to the caller: agex only inspects `response.ok`
 * after `fetchImpl` resolves, so it never sees the refusal. The cost is one
 * extra round trip on the first turn per route per page load, and a rejected
 * request bills no tokens. Note the retry shares the client's request timeout
 * rather than getting a fresh one — the timer isn't cleared until we resolve —
 * and it inherits `init.signal`, so a user cancel still aborts mid-handshake.
 *
 * Trade-off: under `auto` the model may answer with prose instead of a tool
 * call on some turns. Everything else — successes, unrelated 4xx, and requests
 * that weren't forcing tools — passes through untouched.
 *
 * Wired in via `OpenAI({ fetchImpl })`; the client hands us the fully-built
 * request whose JSON body already carries any merged `provider` pin.
 *
 * @param {string | URL | Request} url
 * @param {RequestInit} [init]  `init.body` is the JSON request string.
 * @returns {Promise<Response>}
 */
export async function forcedToolFallbackFetch(url, init) {
    let body = _parseBody(init?.body);
    const key = _memoKey(body);
    // Already known to reject forced tools → relax before we even ask.
    if (key && body.tool_choice === "required" && _noForcedTools.has(key)) {
        body = { ...body, tool_choice: "auto" };
        init = { ...init, body: JSON.stringify(body) };
    }
    const res = await fetch(url, init);
    if (!_RETRY_STATUS.has(res.status)) return res;
    // Only a request still forcing tools can be rescued this way.
    if (!key || body.tool_choice !== "required") return res;
    // Reading the body settles whether this is the forced-tool failure; either
    // way the caller must still be able to read it, so hand back a fresh copy.
    const text = await res.text();
    if (!_isForcedToolRefusal(text)) {
        return new Response(text, {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers,
        });
    }
    // This route can't force tools for this model. Keep everything else, drop
    // the force, and remember so we skip the wasted request next time. A retry
    // that fails too is returned as-is, so a genuine error still surfaces.
    _noForcedTools.add(key);
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
