/**
 * OpenRouter's catalog of models (`GET /api/v1/models`: public, no key,
 * open to the browser), for the settings' model picker and for what the
 * studio reads off the model chosen: whether it takes images, whether it
 * reasons, how large its context is.
 *
 * Fetched at most once a day, and kept in localStorage, so the facts
 * about the model in use are at hand at once, before any fetch.
 */

import { readLocalJson, writeLocalJson } from "./local.js";

const CATALOG_URL = "https://openrouter.ai/api/v1/models";
const STORAGE_KEY = "agex-openrouter-models";
/** How long a fetched catalog is fresh. */
const FRESH_MS = 24 * 60 * 60 * 1000;

/**
 * A model as the studio reads it.
 *
 * @typedef {Object} RouterModel
 * @property {string} id — what the settings hold (`google/gemini-3.8-flash`)
 * @property {string} name
 * @property {number | null} context — its context window, in tokens
 * @property {number | null} input — dollars per million input tokens
 * @property {number | null} output — dollars per million output tokens
 * @property {boolean} images — it takes images
 * @property {boolean} tools — it calls tools, which an agent needs
 * @property {boolean} reasoning — it reasons, so thinking applies
 */

/** @type {{ at: number, models: RouterModel[] } | null} */
let catalog = null;
/** @type {Promise<RouterModel[]> | null} */
let loading = null;

/** How many catalogs have arrived in this page. */
let arrivals = 0;
/** @type {((n: number) => void)[]} */
let listeners = [];

/** The catalog's arrivals, as a Svelte store: what reads facts off the
 *  catalog (`modelInfo`) depends on it, so it reads them again once a
 *  fetched catalog is in. */
export const catalogStore = {
    /** @param {(n: number) => void} fn */
    subscribe(fn) {
        listeners.push(fn);
        fn(arrivals);
        return () => {
            listeners = listeners.filter((l) => l !== fn);
        };
    },
};

/** Per token, as OpenRouter prices, to per million; null when unpriced.
 *  @param {unknown} price */
export function perMillion(price) {
    const n = typeof price === "string" || typeof price === "number" ? Number(price) : NaN;
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1e4) / 1e4 : null;
}

/**
 * One entry of OpenRouter's catalog, as the studio reads it; null for
 * one without an id.
 *
 * @param {any} m
 * @returns {RouterModel | null}
 */
export function readModel(m) {
    if (typeof m?.id !== "string" || m.id === "") return null;
    const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
    const inputs = Array.isArray(m.architecture?.input_modalities) ? m.architecture.input_modalities : [];
    const context = Number(m.context_length ?? m.top_provider?.context_length);
    return {
        id: m.id,
        name: typeof m.name === "string" && m.name !== "" ? m.name : m.id,
        context: Number.isFinite(context) && context > 0 ? context : null,
        input: perMillion(m.pricing?.prompt),
        output: perMillion(m.pricing?.completion),
        images: inputs.includes("image"),
        tools: params.includes("tools"),
        reasoning: params.includes("reasoning") || params.includes("include_reasoning"),
    };
}

/** The catalog kept from an earlier fetch, if there is one. */
function stored() {
    const kept = readLocalJson(STORAGE_KEY);
    return Array.isArray(kept?.models) && typeof kept.at === "number" ? kept : null;
}

/** The catalog at hand: this page's, else the one kept. */
function current() {
    catalog ??= stored();
    return catalog;
}

/**
 * The catalog: the one at hand while it's fresh, else fetched (and
 * kept). A failed fetch falls back to a stale one when there is one.
 *
 * @param {{ fetchImpl?: typeof fetch, now?: number }} [opts]
 * @returns {Promise<RouterModel[]>}
 */
export function loadModels({ fetchImpl = fetch, now = Date.now() } = {}) {
    const have = current();
    if (have !== null && now - have.at < FRESH_MS) return Promise.resolve(have.models);
    loading ??= (async () => {
        try {
            const r = await fetchImpl(CATALOG_URL);
            if (!r.ok) throw new Error(`OpenRouter's model list answered ${r.status}`);
            const body = await r.json();
            const models = (Array.isArray(body?.data) ? body.data : []).map(readModel).filter((m) => m !== null);
            catalog = { at: now, models };
            arrivals += 1;
            for (const fn of listeners) fn(arrivals);
            writeLocalJson(STORAGE_KEY, catalog);
            return models;
        } catch (e) {
            if (have !== null) return have.models;
            throw e;
        } finally {
            loading = null;
        }
    })();
    return loading;
}

/** What the catalog at hand says of `id`, or null: before any fetch, or
 *  for a model it doesn't list. @param {string} id */
export function modelInfo(id) {
    const key = id.trim();
    return current()?.models.find((m) => m.id === key) ?? null;
}

/**
 * The models matching `query` (every word in the id or name), the ones
 * that call tools unless `all`, best first: an id that starts with the
 * query, then a name that does, then the rest, in the catalog's order.
 *
 * @param {readonly RouterModel[]} models
 * @param {string} query
 * @param {{ all?: boolean, limit?: number }} [opts]
 */
export function searchModels(models, query, { all = false, limit = 60 } = {}) {
    const words = query.toLowerCase().split(/\s+/).filter((w) => w !== "");
    const q = query.trim().toLowerCase();
    const hits = models.filter((m) => {
        if (!all && !m.tools) return false;
        const hay = `${m.id} ${m.name}`.toLowerCase();
        return words.every((w) => hay.includes(w));
    });
    const rank = (/** @type {RouterModel} */ m) => (q === "" ? 2 : m.id.toLowerCase().startsWith(q) ? 0 : m.name.toLowerCase().startsWith(q) ? 1 : 2);
    return hits
        .map((m, i) => ({ m, i, r: rank(m) }))
        .sort((a, b) => a.r - b.r || a.i - b.i)
        .slice(0, limit)
        .map((x) => x.m);
}

/** A context size for a person: `1M`, `200k`, `32k`. @param {number | null} n */
export function contextLabel(n) {
    if (n === null) return "";
    if (n >= 1e6) return `${Number((n / 1e6).toFixed(1))}M`;
    return `${Math.round(n / 1000)}k`;
}

/** A price per million tokens for a person: `$0.10`, `$15`, `free`.
 *  @param {number | null} n */
export function priceLabel(n) {
    if (n === null) return "";
    if (n === 0) return "free";
    return n >= 10 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`;
}

/** @internal Forget the catalog at hand (tests). */
export function _reset() {
    catalog = null;
    loading = null;
}
