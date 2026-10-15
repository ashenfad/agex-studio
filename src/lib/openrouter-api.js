/**
 * OpenRouter's API for the studio's own tools (`web`, `media`): the key
 * they run on, and their requests.
 *
 * They run on OpenRouter whatever model the turns use, since the models
 * behind them (Perplexity's search, the image, speech and music models)
 * are reached there. So they need the settings' OpenRouter key: with a
 * custom endpoint there is none, and a call says so.
 *
 * And, for the settings, what OpenRouter says of a key: whether it
 * accepts it, and what it has spent.
 */

import { privacyOf } from "./openrouter-routing.js";
import { getSettings } from "./settings.js";

export const OPENROUTER_API = "https://openrouter.ai/api/v1";

/** Whether the settings hold an OpenRouter key, so `web` and `media`
 *  work: whatever model runs the turns.
 *  @param {import("./settings.js").Settings} [s] */
export function hasRouterKey(s = getSettings()) {
    return s.routerKey.trim() !== "";
}

/** The OpenRouter key, or a refusal naming what to change.
 *  @param {string} label the call, as code wrote it */
export function routerKey(label) {
    const s = getSettings();
    if (!hasRouterKey(s)) {
        throw new Error(
            `${label}: this runs on OpenRouter, and the settings hold no OpenRouter key; the person can add one in settings (beside any model)`,
        );
    }
    return s.routerKey.trim();
}

/**
 * POST `body` as JSON to OpenRouter's `path`, within `timeout` seconds:
 * the response, once it is a 200. A failure is an error naming `label`
 * and what went wrong, the start of an error page at most.
 *
 * @param {{ label: string, path: string, body: Record<string, any>, timeout: number, fetchImpl?: typeof fetch }} opts
 */
export async function routerPost({ label, path, body, timeout, fetchImpl = fetch }) {
    const key = routerKey(label);
    // the privacy settings hold for this request too, beside any
    // provider preferences the call sets itself
    const privacy = privacyOf(getSettings());
    const sent = Object.keys(privacy).length === 0 ? body : { ...body, provider: { ...body.provider, ...privacy } };
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
            body: JSON.stringify(sent),
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

/**
 * What OpenRouter says of a key: accepted, with what it has spent (in
 * dollars) and any limit on it; rejected; or no telling, when OpenRouter
 * couldn't be reached or answered otherwise.
 *
 * `byok` is what was spent through the person's own provider keys
 * (bring your own key), which those providers bill and OpenRouter counts
 * apart from its own.
 *
 * @typedef {{ today: number | null, week: number | null, month: number | null, total: number | null }} Spend
 * @typedef {{ ok: true, usage: Spend, byok: Spend, limit: number | null, remaining: number | null, freeTier: boolean }
 *     | { ok: false, reason: 'rejected' }
 *     | { ok: false, reason: 'unreachable', detail: string }} KeyCheck
 */

/** A figure OpenRouter gave, or null for one it left out.
 *  @param {unknown} v */
function amount(v) {
    return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Ask OpenRouter about `key` (`GET /key`), within `timeout` seconds. The
 * key goes only in the request's header: a detail never carries it.
 *
 * @param {string} key
 * @param {{ timeout?: number, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<KeyCheck>}
 */
export async function checkRouterKey(key, { timeout = 10, fetchImpl = fetch } = {}) {
    let r;
    try {
        r = await fetchImpl(`${OPENROUTER_API}/key`, {
            headers: { Authorization: `Bearer ${key.trim()}` },
            signal: AbortSignal.timeout(timeout * 1000),
        });
    } catch (e) {
        const timedOut = e instanceof Error && e.name === "TimeoutError";
        return { ok: false, reason: "unreachable", detail: timedOut ? `no answer within ${timeout}s` : `network error: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (r.status === 401 || r.status === 403) return { ok: false, reason: "rejected" };
    if (r.status !== 200) return { ok: false, reason: "unreachable", detail: `HTTP ${r.status}` };
    let data;
    try {
        data = (await r.json())?.data;
    } catch {
        return { ok: false, reason: "unreachable", detail: "the response was not JSON" };
    }
    if (data === null || typeof data !== "object") return { ok: false, reason: "unreachable", detail: "the response held no key" };
    return {
        ok: true,
        usage: {
            today: amount(data.usage_daily),
            week: amount(data.usage_weekly),
            month: amount(data.usage_monthly),
            total: amount(data.usage),
        },
        byok: {
            today: amount(data.byok_usage_daily),
            week: amount(data.byok_usage_weekly),
            month: amount(data.byok_usage_monthly),
            total: amount(data.byok_usage),
        },
        limit: amount(data.limit),
        remaining: amount(data.limit_remaining),
        freeTier: data.is_free_tier === true,
    };
}

/** Dollars to the cent: `$7.30`, `$1,250.00`, and `<$0.01` for less
 *  than a cent that isn't nothing.
 *  @param {number} n */
export function dollarLabel(n) {
    if (n > 0 && n < 0.01) return "<$0.01";
    return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** What an accepted key has spent today and this month, in a line.
 *  @param {Extract<KeyCheck, { ok: true }>} check */
export function keyUsageLine(check) {
    const { usage } = check;
    return [usage.today !== null ? `${dollarLabel(usage.today)} today` : null, usage.month !== null ? `${dollarLabel(usage.month)} this month` : null]
        .filter((part) => part !== null)
        .join(" · ");
}

/** The rest of what's known of an accepted key, for a tooltip: what
 *  went through the person's own provider keys (when anything did),
 *  what's left of any limit, and whether it's on the free tier.
 *  @param {Extract<KeyCheck, { ok: true }>} check */
export function keyUsageMore(check) {
    const { byok, limit, remaining } = check;
    const ownKeys = (byok.today ?? 0) > 0 || (byok.month ?? 0) > 0;
    return [
        ownKeys ? `Plus ${dollarLabel(byok.today ?? 0)} today, ${dollarLabel(byok.month ?? 0)} this month through your own provider keys` : null,
        limit !== null ? (remaining !== null ? `${dollarLabel(remaining)} left of a ${dollarLabel(limit)} limit` : `A ${dollarLabel(limit)} limit`) : null,
        check.freeTier ? "Free tier" : null,
    ]
        .filter((part) => part !== null)
        .join(". ");
}
