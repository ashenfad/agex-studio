/**
 * Web-search helper backing the TS-side `search` agent.fn.
 *
 * Always hits OpenRouter's `/api/v1/chat/completions` (regardless of
 * the user's chosen LLM endpoint) because the Perplexity Sonar
 * models live there. The user's `apiKey` is sent as the bearer —
 * needs to be valid against OpenRouter for search to work. In
 * Custom mode where the LLM key is for a different service (vLLM,
 * Anthropic direct, etc.), search fails with a 401; the error
 * message explains the OpenRouter requirement.
 *
 * Model picks: `perplexity/sonar` for single-shot,
 * `perplexity/sonar-pro-search` when the agent passes `deep: true`.
 *
 * Counterpart of agex-py's `search` helper in `agent_helpers.py`. We
 * skip py-side's `llm._adapter.fetch_json` reuse because agex-ts's
 * client doesn't expose a generic fetch wrapper — calling `fetch`
 * directly is simpler and the credential plumbing is one header.
 */

import { getSettings } from "./settings.js";

/** OpenRouter's OpenAI-compatible chat-completions endpoint.
 *  Hardcoded because the Perplexity Sonar models the agent search
 *  helper targets are OpenRouter-routed; no other endpoint in the
 *  studio's supported list fronts them. */
const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

const SEARCH_MODELS = {
    shallow: "perplexity/sonar",
    deep: "perplexity/sonar-pro-search",
};

const SYSTEM_PROMPT =
    "Answer the user's question using web search. Be thorough and include source URLs.";

/**
 * Run a single web-search request. Pure orchestrator: `fetch` is
 * injected so tests can stub HTTP without touching the network or
 * the global. Throws on missing API key, transport failure, non-2xx
 * response, and malformed payloads — the agent surfaces the throw
 * verbatim on its next turn.
 *
 * @param {{
 *   query: string,
 *   deep?: boolean,
 *   settings: { apiKey: string },
 *   fetchImpl?: typeof fetch,
 * }} opts
 * @returns {Promise<string>} The model's text response (sources cited inline by perplexity).
 */
export async function runSearch(opts) {
    const { query, deep = false, settings, fetchImpl = fetch } = opts;

    if (!query || typeof query !== "string") {
        throw new Error("search: query must be a non-empty string");
    }
    if (!settings?.apiKey) {
        throw new Error(
            "search: no API key configured — set one in the settings drawer",
        );
    }

    const url = OPENROUTER_CHAT_URL;
    const model = deep ? SEARCH_MODELS.deep : SEARCH_MODELS.shallow;

    const body = {
        model,
        messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: query },
        ],
    };

    let response;
    try {
        response = await fetchImpl(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${settings.apiKey}`,
                // OpenRouter app attribution — match the LLM client so search
                // calls show as "Agex Studio" in the dashboard, not "unknown".
                "HTTP-Referer": "https://agex.studio",
                "X-Title": "Agex Studio",
            },
            body: JSON.stringify(body),
        });
    } catch (e) {
        throw new Error(`search: network error — ${e?.message || String(e)}`);
    }

    if (!response.ok) {
        // Special-case 401 to call out OpenRouter explicitly — the
        // raw upstream body for an unauthorized request is rarely
        // illuminating, and Custom-mode users whose LLM key isn't
        // an OpenRouter key would otherwise see a vague "HTTP 401
        // Unauthorized" and have no obvious path forward.
        if (response.status === 401) {
            throw new Error(
                "search: HTTP 401 — web search uses OpenRouter (Perplexity Sonar); " +
                    "the configured API key isn't valid for OpenRouter. " +
                    "Switch the provider to OpenRouter or use an OpenRouter key.",
            );
        }
        let detail = "";
        try {
            detail = await response.text();
        } catch {
            // ignore — we'll surface just the status
        }
        // Truncate the upstream error so a verbose HTML 502 page
        // doesn't blow out the agent's next-turn observation.
        const trimmed = detail.length > 500 ? detail.slice(0, 500) + "…" : detail;
        throw new Error(
            `search: HTTP ${response.status} ${response.statusText}` +
                (trimmed ? ` — ${trimmed}` : ""),
        );
    }

    let data;
    try {
        data = await response.json();
    } catch (e) {
        throw new Error(
            `search: response was not valid JSON — ${e?.message || String(e)}`,
        );
    }

    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
        throw new Error(
            `search: response missing choices[0].message.content (got: ${
                JSON.stringify(data).slice(0, 200)
            })`,
        );
    }
    return content;
}

/**
 * Convenience wrapper that pulls current settings from the studio's
 * settings store and uses the global `fetch`. This is what the
 * `agent.fn` registration in `ts-agent.js` calls; the test suite
 * exercises `runSearch` directly with stubs.
 *
 * @param {string} query
 * @param {boolean} [deep=false]
 * @returns {Promise<string>}
 */
export function search(query, deep = false) {
    return runSearch({ query, deep, settings: getSettings() });
}
