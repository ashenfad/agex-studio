/**
 * OpenRouter's API for the studio's own tools (`web`, `media`): the key
 * they run on, and their requests.
 *
 * They run on OpenRouter whatever model the turns use, since the models
 * behind them (Perplexity's search, the image, speech and music models)
 * are reached there. So they need the settings' OpenRouter key: with a
 * custom endpoint there is none, and a call says so.
 */

import { getSettings } from "./settings.js";

export const OPENROUTER_API = "https://openrouter.ai/api/v1";

/** Whether the settings hold an OpenRouter key, so `web` and `media`
 *  work. @param {import("./settings.js").Settings} [s] */
export function hasRouterKey(s = getSettings()) {
    return s.accessMode === "openrouter" && s.apiKey.trim() !== "";
}

/** The OpenRouter key, or a refusal naming what to change.
 *  @param {string} label the call, as code wrote it */
export function routerKey(label) {
    const s = getSettings();
    if (!hasRouterKey(s)) {
        throw new Error(
            `${label}: this runs on OpenRouter, and the settings hold no OpenRouter key; the person can set the provider to OpenRouter in settings`,
        );
    }
    return s.apiKey.trim();
}

/**
 * POST `body` as JSON to OpenRouter's `path`, within `timeout` seconds:
 * the response, once it is a 200. A failure is an error naming `label`
 * and what went wrong, the start of an error page at most.
 *
 * @param {{ label: string, path: string, body: unknown, timeout: number, fetchImpl?: typeof fetch }} opts
 */
export async function routerPost({ label, path, body, timeout, fetchImpl = fetch }) {
    const key = routerKey(label);
    let r;
    try {
        r = await fetchImpl(`${OPENROUTER_API}${path}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${key}`,
                "HTTP-Referer": "https://agex.studio",
                "X-Title": "Agex Studio",
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeout * 1000),
        });
    } catch (e) {
        if (e instanceof Error && e.name === "TimeoutError") throw new Error(`${label}: no answer within ${timeout}s`);
        throw new Error(`${label}: network error: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (r.status !== 200) {
        const detail = (await r.text().catch(() => "")).slice(0, 300);
        throw new Error(`${label}: HTTP ${r.status}${detail ? `: ${detail}` : ""}`);
    }
    return r;
}

/** {@link routerPost}, its JSON. @param {Parameters<typeof routerPost>[0]} opts */
export async function routerJson(opts) {
    const r = await routerPost(opts);
    try {
        return await r.json();
    } catch {
        throw new Error(`${opts.label}: the response was not JSON`);
    }
}

/** What a call cost upstream, in dollars, or null. A bring-your-own-key
 *  call bills the provider, so OpenRouter's own figure reads 0 and the
 *  upstream cost is the real one.
 *  @param {any} usage */
export function costOf(usage) {
    const upstream = usage?.cost_details?.upstream_inference_cost;
    if (typeof upstream === "number" && upstream > 0) return upstream;
    return typeof usage?.cost === "number" ? usage.cost : null;
}
