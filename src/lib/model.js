/**
 * The model a turn runs on, from the settings: an AI SDK model, which
 * agex-ts drives directly.
 *
 * - **OpenRouter:** the OpenRouter provider, with the key.
 * - **A custom endpoint:** Anthropic-shaped (a direct key, a local
 *   Meridian, a proxy) or OpenAI-compatible (vLLM, Ollama, LiteLLM).
 * - **A scripted model,** in dev builds only, for the driver's checks.
 *
 * An Anthropic-shaped custom endpoint gets an `x-session-affinity` key
 * per conversation: Meridian resumes a backing session for each, which
 * keeps its prompt cache warm. A model is built per session, so the key
 * can name it.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { fittingImages } from "./image-fit.js";

/** @typedef {import("./settings.js").Settings} Settings */

/** Anthropic-shaped traffic to a custom endpoint other than Anthropic's
 *  own: a proxy like Meridian, which keys its sessions by
 *  `x-session-affinity`. Never sent to api.anthropic.com or OpenRouter,
 *  whose CORS allow-lists would refuse the header.
 *  @param {Settings} s */
export function usesSessionAffinity(s) {
    if (s.accessMode !== "custom" || s.wire !== "anthropic") return false;
    try {
        return new URL(anthropicBaseUrl(s.baseUrl)).hostname !== "api.anthropic.com";
    } catch {
        return false;
    }
}

/** An Anthropic-shaped endpoint's API root, ending in `/v1`, as the AI
 *  SDK takes it: `http://localhost:3456` and `http://localhost:3456/v1/`
 *  are both `http://localhost:3456/v1`.
 *  @param {string} url */
export function anthropicBaseUrl(url) {
    const trimmed = url.trim().replace(/\/+$/, "");
    return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/** Origins whose CORS refused `x-session-affinity`: requests to them go
 *  without it until reload. */
const affinityRefused = new Set();

/**
 * `agex-studio:<session>:<first tool_use id>`, or null before the
 * conversation has one. A key must not span two histories (Meridian
 * refuses a key whose history stops matching), and the first tool_use
 * id is the provider's own, unique per generation and fixed once it is
 * in the history; a fold that rewrites the history drops it, and the
 * conversation after starts a fresh key. The opening request goes
 * untagged.
 *
 * @param {string} session
 * @param {unknown} body
 * @returns {string | null}
 */
export function conversationKey(session, body) {
    if (typeof body !== "string") return null;
    let messages;
    try {
        messages = JSON.parse(body).messages;
    } catch {
        return null;
    }
    if (!Array.isArray(messages)) return null;
    for (const message of messages) {
        if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
        for (const part of message.content) {
            if (part?.type === "tool_use" && typeof part.id === "string") {
                return `agex-studio:${session}:${part.id}`;
            }
        }
    }
    return null;
}

/**
 * `fetch` tagging each request with its conversation's affinity key. A
 * proxy whose CORS allow-list lacks the header fails the request as a
 * network error does (a `TypeError`), so a failed tagged request is
 * retried untagged, and the origin stops getting the header only if the
 * retry succeeds: when it fails too, the network is the problem.
 *
 * @param {string} session
 * @param {typeof fetch} [baseFetch]
 * @returns {typeof fetch}
 */
export function sessionAffinityFetch(session, baseFetch = (url, init) => fetch(url, init)) {
    return async (url, init) => {
        const origin = new URL(String(url)).origin;
        const key = affinityRefused.has(origin) ? null : conversationKey(session, init?.body);
        if (key === null) return baseFetch(url, init);
        try {
            return await baseFetch(url, {
                ...init,
                headers: { .../** @type {Record<string, string>} */ (init?.headers), "x-session-affinity": key },
            });
        } catch (err) {
            if (!(err instanceof TypeError) || init?.signal?.aborted) throw err;
            const response = await baseFetch(url, init);
            affinityRefused.add(origin);
            console.warn(`[model] ${origin} refused x-session-affinity; sending requests without it`);
            return response;
        }
    };
}

/**
 * The AI SDK model for `session`'s turns, the images in its requests
 * fitted to what a model takes (`image-fit.js`). `scripted` (dev only)
 * is built by the caller, which holds the script.
 *
 * @param {Settings} s
 * @param {{ session: string, fetch?: typeof fetch }} opts
 */
export function buildModel(s, opts) {
    return fittingImages(baseModel(s, opts));
}

/** The provider's model, as `buildModel` gives it before fitting.
 *  @param {Settings} s @param {{ session: string, fetch?: typeof fetch }} opts */
function baseModel(s, opts) {
    if (s.accessMode === "openrouter") {
        return createOpenRouter({
            apiKey: s.apiKey,
            headers: { "X-Title": "agex studio" },
            ...(opts.fetch && { fetch: opts.fetch }),
        })(s.model);
    }
    if (s.accessMode !== "custom") {
        throw new Error(`no model for access mode ${JSON.stringify(s.accessMode)}`);
    }
    if (s.wire === "anthropic") {
        return createAnthropic({
            apiKey: s.apiKey || "none",
            baseURL: anthropicBaseUrl(s.baseUrl),
            headers: { "anthropic-dangerous-direct-browser-access": "true" },
            fetch: usesSessionAffinity(s)
                ? sessionAffinityFetch(opts.session, opts.fetch)
                : opts.fetch,
        })(s.model);
    }
    return createOpenAICompatible({
        name: "custom",
        baseURL: s.baseUrl.trim().replace(/\/+$/, ""),
        ...(s.apiKey && { apiKey: s.apiKey }),
        ...(opts.fetch && { fetch: opts.fetch }),
    })(s.model);
}

/** The settings' thinking as agex-ts takes it.
 *  @param {Settings} s */
export function thinkingOf(s) {
    return s.thinking === "off" ? false : s.thinking;
}
