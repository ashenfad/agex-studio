/**
 * The model a turn runs on, from the settings: an AI SDK model, which
 * agex-ts drives directly.
 *
 * - **OpenRouter:** the OpenRouter provider, with the key, and the
 *   provider routing set for the model (`openrouter-routing.js`).
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
import { ROUTER_HEADERS } from "./openrouter-api.js";
import { modelInfo } from "./openrouter-models.js";
import { routingOf } from "./openrouter-routing.js";

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
        const provider = routingOf(s);
        return createOpenRouter({
            apiKey: s.routerKey,
            headers: ROUTER_HEADERS,
            ...(opts.fetch && { fetch: opts.fetch }),
        })(modelOf(s), provider && { provider });
    }
    if (s.accessMode !== "custom") {
        throw new Error(`no model for access mode ${JSON.stringify(s.accessMode)}`);
    }
    if (s.wire === "anthropic") {
        return createAnthropic({
            apiKey: s.endpointKey || "none",
            baseURL: anthropicBaseUrl(s.baseUrl),
            headers: { "anthropic-dangerous-direct-browser-access": "true" },
            fetch: usesSessionAffinity(s)
                ? sessionAffinityFetch(opts.session, opts.fetch)
                : opts.fetch,
        })(modelOf(s));
    }
    return createOpenAICompatible({
        name: "custom",
        baseURL: s.baseUrl.trim().replace(/\/+$/, ""),
        ...(s.endpointKey && { apiKey: s.endpointKey }),
        ...(opts.fetch && { fetch: opts.fetch }),
    })(modelOf(s));
}

/** The settings' thinking as agex-ts takes it.
 *  @param {Settings} s */
export function thinkingOf(s) {
    return s.thinking === "off" ? false : s.thinking;
}

/** The model the settings' service is asked for.
 *  @param {Settings} s */
export function modelOf(s) {
    return (s.accessMode === "custom" ? s.endpointModel : s.routerModel).trim();
}

/** Whether the model in use takes images: on OpenRouter as its catalog
 *  says, else (a custom endpoint, a model it doesn't list) as the
 *  settings say. @param {Settings} s */
export function visionOf(s) {
    if (s.accessMode === "openrouter") {
        const info = modelInfo(s.routerModel);
        if (info !== null) return info.images;
    }
    return s.vision;
}

/** How much of a model's context window a conversation may fill before
 *  it's folded, past the setting: room for the reply and the next steps. */
export const WINDOW_SHARE = 0.75;

/** The size past which a conversation folds: the setting, kept within
 *  the model's window when OpenRouter's catalog says how large that is;
 *  0, folding off, stays 0. @param {Settings} s */
export function foldBudgetOf(s) {
    if (s.foldBudget <= 0) return 0;
    const window = s.accessMode === "openrouter" ? (modelInfo(s.routerModel)?.context ?? null) : null;
    return window === null ? s.foldBudget : Math.min(s.foldBudget, Math.floor(window * WINDOW_SHARE));
}

