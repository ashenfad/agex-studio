/**
 * Provider routing on OpenRouter: which of the providers serving a model
 * takes its requests.
 *
 * A model's providers come from `GET /api/v1/models/{id}/endpoints`
 * (public, no key, open to the browser), fetched when the settings show
 * that model and kept for the page's life. The route chosen for it, and
 * the account-wide privacy settings, become the `provider` object each
 * request carries; when all are left to OpenRouter, none is sent.
 */

import { perMillion, priceLabel } from "./openrouter-models.js";

/** @typedef {import("./settings.js").Settings} Settings */
/** @typedef {import("./settings.js").RouterRoute} RouterRoute */

/**
 * One provider's endpoint for a model, as the studio reads it.
 *
 * @typedef {Object} RouterEndpoint
 * @property {string} tag — what routing names it by (`google-vertex/global`)
 * @property {string} provider — the provider's name (`Google`)
 * @property {string | null} quantization — `fp8`, `bf16`; null when unknown
 * @property {number | null} context — its context window, in tokens
 * @property {number | null} input — dollars per million input tokens
 * @property {number | null} output — dollars per million output tokens
 * @property {number | null} uptime — percent of requests served in the
 *     last 30 minutes
 */

/** The route of a model nobody has set one for: OpenRouter's choice. */
export const AUTO = Object.freeze({ provider: null, only: false, sort: null });

const endpointsUrl = (/** @type {string} */ id) =>
    `https://openrouter.ai/api/v1/models/${id.split("/").map(encodeURIComponent).join("/")}/endpoints`;

/** A model's endpoints, fetched or in flight, by model id. A failed
 *  fetch is dropped, so the next asks again.
 *  @type {Map<string, Promise<RouterEndpoint[] | null>>} */
const fetched = new Map();

/**
 * One of a model's endpoints, as the studio reads it; null for one
 * without a tag, which routing can't name.
 *
 * @param {any} e
 * @returns {RouterEndpoint | null}
 */
export function readEndpoint(e) {
    if (typeof e?.tag !== "string" || e.tag === "") return null;
    const context = Number(e.context_length);
    const uptime = e.uptime_last_30m;
    const quantization = typeof e.quantization === "string" && e.quantization !== "unknown" && e.quantization !== "" ? e.quantization : null;
    return {
        tag: e.tag,
        provider: typeof e.provider_name === "string" && e.provider_name !== "" ? e.provider_name : e.tag,
        quantization,
        context: Number.isFinite(context) && context > 0 ? context : null,
        input: perMillion(e.pricing?.prompt),
        output: perMillion(e.pricing?.completion),
        uptime: typeof uptime === "number" && Number.isFinite(uptime) ? uptime : null,
    };
}

/**
 * The endpoints serving `id`, or null when OpenRouter doesn't list the
 * model.
 *
 * @param {string} id
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<RouterEndpoint[] | null>}
 */
export function loadEndpoints(id, { fetchImpl = fetch } = {}) {
    const key = id.trim();
    let pending = fetched.get(key);
    if (pending === undefined) {
        pending = (async () => {
            const r = await fetchImpl(endpointsUrl(key));
            if (r.status === 404) return null;
            if (!r.ok) throw new Error(`OpenRouter's providers answered ${r.status}`);
            const body = await r.json();
            const list = body?.data?.endpoints;
            return (Array.isArray(list) ? list : []).map(readEndpoint).filter((e) => e !== null);
        })();
        fetched.set(key, pending);
        pending.catch(() => fetched.delete(key));
    }
    return pending;
}

/**
 * An endpoint for a person, in a line: its provider (with the variant
 * its tag names, when the provider has several), price in and out per
 * million tokens, quantization and recent uptime when known.
 *
 * @param {RouterEndpoint} e
 * @param {readonly RouterEndpoint[]} all — the model's endpoints
 */
export function endpointLabel(e, all) {
    const shared = all.filter((o) => o.provider === e.provider).length > 1;
    const variant = e.tag.split("/").slice(1).join("/");
    return [
        shared && variant !== "" ? `${e.provider} (${variant})` : e.provider,
        e.input !== null ? `${priceLabel(e.input)} in, ${priceLabel(e.output)} out` : null,
        e.quantization,
        e.uptime !== null ? `${Math.round(e.uptime * 10) / 10}% up` : null,
    ]
        .filter((part) => part !== null)
        .join(" · ");
}

/** The route set for model `id`, else Auto.
 *  @param {Settings} s @param {string} id
 *  @returns {RouterRoute} */
export function routeOf(s, id) {
    return s.routerRouting[id.trim()] ?? AUTO;
}

/**
 * `routing` with model `id`'s route set to `route`, leaving every other
 * model's; a route back to Auto is dropped rather than kept.
 *
 * @param {Record<string, RouterRoute>} routing
 * @param {string} id
 * @param {RouterRoute} route
 * @returns {Record<string, RouterRoute>}
 */
export function withRoute(routing, id, route) {
    const key = id.trim();
    const { [key]: _, ...rest } = routing;
    const auto = route.provider === null && route.sort === null;
    return auto ? rest : { ...rest, [key]: { provider: route.provider, only: route.provider !== null && route.only, sort: route.provider === null ? route.sort : null } };
}

/**
 * The privacy settings as OpenRouter's provider preferences: they narrow
 * the providers for every request to OpenRouter, the model's and those
 * `web` and `media` make. Empty when neither is set.
 *
 * @param {Settings} s
 * @returns {{ data_collection?: "deny", zdr?: true }}
 */
export function privacyOf(s) {
    return {
        ...(s.routerDenyTraining && { data_collection: /** @type {const} */ ("deny") }),
        ...(s.routerZdr && { zdr: /** @type {const} */ (true) }),
    };
}

/**
 * The `provider` object an OpenRouter request carries for the model in
 * use, or undefined when everything is left to OpenRouter.
 *
 * - A chosen provider is asked first (`order`), with the others as a
 *   fallback unless it's that one only.
 * - With none chosen, a preference sorts them.
 * - Privacy settings narrow the providers, whatever the model.
 *
 * @param {Settings} s
 * @returns {import("@openrouter/ai-sdk-provider").OpenRouterChatSettings["provider"] | undefined}
 */
export function routingOf(s) {
    const route = routeOf(s, s.routerModel);
    /** @type {NonNullable<ReturnType<typeof routingOf>>} */
    const provider = {};
    if (route.provider !== null) {
        provider.order = [route.provider];
        provider.allow_fallbacks = !route.only;
    } else if (route.sort !== null) {
        provider.sort = route.sort;
    }
    Object.assign(provider, privacyOf(s));
    return Object.keys(provider).length > 0 ? provider : undefined;
}

/** @internal Forget the endpoints fetched (tests). */
export function _reset() {
    fetched.clear();
}
