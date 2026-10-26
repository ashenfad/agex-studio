/**
 * The studio's end of `agex.fetch`: an app's request that carries a
 * secret, sent from the studio with the viewer's key filled in.
 *
 * A request without a secret never comes here: the page's shim makes it
 * with the app's own `fetch`, from the app's origin. One that names a
 * secret (`${NAME}`, as in `Authorization: Bearer ${STRIPE_KEY}`) is
 * posted as `agex-fetch` (`id`, `url`, `method`, `headers` as pairs,
 * `body`: a string, bytes or null), and answered with
 * `agex-fetch-result` (`id`, and `status`, `statusText`, `url`,
 * `headers` as pairs and `body` as bytes, or `error`: why it failed or
 * was refused). An `agex-fetch-cancel` (`id`) from the app aborts it,
 * and a page that is replaced or closed has its requests aborted
 * (`cancelFetches`).
 *
 * The rules a request is held to, from what `app/agex.json` declares
 * (`app-needs.js`):
 *
 * - a secret is filled only into its declared header, and a reference
 *   anywhere else (the URL, its query, the body, another header) is
 *   refused, not sent as written;
 * - it goes only to an origin the secret declares, over `https:`, never
 *   to the studio's or its apps' origins;
 * - only a secret the app declares, and the viewer granted, is filled;
 * - the request carries no credentials (`credentials: 'omit'`) and
 *   follows no redirect.
 *
 * The request itself is the world's `request`: a size cap, no redirect
 * followed while it carries a bound secret, and a key the response
 * echoes replaced by its reference before the app sees it.
 */

import { Secrets, request } from "@agex-ts/world";
import { NEEDS_PATH, originRefusal } from "./app-needs.js";
import { replyToApp } from "./apps-origin.js";

/**
 * What a request may carry: its secrets' needs, and how to get the
 * value each was granted (null: none). The value is filled in and
 * never given to the app.
 *
 * @typedef {{
 *   needs: import("./app-needs.js").AppNeeds,
 *   grantFor: (need: import("./app-needs.js").SecretNeed) => Promise<string | null>,
 *   signal?: AbortSignal,
 *   fetch?: typeof globalThis.fetch,
 *   studioOrigins?: Iterable<string>,
 * }} FetchContext
 */

/**
 * Answers one `agex-fetch` message with the reply to post, aborted by
 * `signal`.
 *
 * @typedef {(data: Record<string, unknown>, signal: AbortSignal) => Promise<Record<string, unknown>>} FetchAnswer
 */

/** A reference to a secret, as the world's `request` fills one:
 *  `${NAME}`, or `$NAME`. */
const REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/** Statuses a `Response` is built with: anything else is refused. */
const MIN_STATUS = 200;
const MAX_STATUS = 599;

/** A request refused, with the message the app gets. */
class FetchRefused extends Error {
    /** @param {string} message */
    constructor(message) {
        super(`agex.fetch: ${message}`);
        this.name = "FetchRefused";
    }
}

/**
 * The references in `text` that count, each by name, where it is, and
 * whether it is bare: every `${NAME}`, and a bare `$NAME` when NAME is a
 * declared secret. A reference is written `${NAME}` (the page sends only
 * those here); a bare one is refused, since the world's `request` would
 * fill it all the same.
 *
 * @param {string} text @param {Set<string>} declared
 * @returns {{ name: string, at: number, bare: boolean }[]}
 */
function referencesIn(text, declared) {
    /** @type {{ name: string, at: number, bare: boolean }[]} */
    const found = [];
    for (const m of text.matchAll(REF)) {
        const braced = m[1];
        const bare = m[2];
        if (braced !== undefined) found.push({ name: braced, at: m.index, bare: false });
        else if (bare !== undefined && declared.has(bare)) found.push({ name: bare, at: m.index, bare: true });
    }
    return found;
}

/** `${NAME}`, as an app writes it. @param {string} name */
const ref = (name) => `\${${name}}`;

/** A reference somewhere a secret never goes, refused.
 *  @param {string} name @param {string} where */
const misplaced = (name, where) =>
    new FetchRefused(`${ref(name)} is in ${where}; a secret goes in one request header only (the one ${NEEDS_PATH} declares for it), never a URL, query or body`);

/** Where a secret goes, said for a refusal. @param {import("./app-needs.js").SecretNeed} need */
const itsPlace = (need) => `in its ${need.header} header only, as ${NEEDS_PATH} declares`;

/**
 * The request's URL, every way it may be read: as written, as parsed,
 * and percent-decoded.
 *
 * @param {string} raw @param {URL} url
 */
function urlForms(raw, url) {
    return [raw, ...decodedToo(url.href)];
}

/**
 * `text`, and it percent-decoded (a form's fields, a URL's path), when
 * that differs.
 *
 * @param {string} text
 */
function decodedToo(text) {
    try {
        const decoded = decodeURIComponent(text.replace(/\+/g, " "));
        return decoded === text ? [text] : [text, decoded];
    } catch {
        // a stray % isn't an escape: the text is all there is
        return [text];
    }
}

/**
 * Check the request's shape, as the page posts it.
 *
 * @param {Record<string, unknown>} data
 * @returns {{ url: string, method: string, headers: [string, string][], body: string | Uint8Array | null }}
 */
function readRequest(data) {
    if (typeof data.url !== "string") throw new FetchRefused("the URL must be a string");
    const method = data.method === undefined || data.method === null ? "GET" : data.method;
    if (typeof method !== "string" || method === "") throw new FetchRefused("the method must be a string, like \"GET\"");
    const headers = data.headers ?? [];
    if (!Array.isArray(headers) || !headers.every((h) => Array.isArray(h) && h.length === 2 && typeof h[0] === "string" && typeof h[1] === "string")) {
        throw new FetchRefused("the headers must be [name, value] pairs of strings");
    }
    const body = data.body ?? null;
    if (body !== null && typeof body !== "string" && !(body instanceof Uint8Array)) {
        throw new FetchRefused("the body must be a string or bytes");
    }
    if (body !== null && /^(GET|HEAD)$/i.test(method)) throw new FetchRefused(`a ${method.toUpperCase()} request can't have a body`);
    return { url: data.url, method, headers: /** @type {[string, string][]} */ (headers), body: /** @type {string | Uint8Array | null} */ (body) };
}

/**
 * Answer one `agex-fetch` message: check the request against the app's
 * needs, fill its secrets from their grants, send it, and return the
 * reply to post (`agex-fetch-result`), the response or why it failed.
 *
 * @param {Record<string, unknown>} data
 * @param {FetchContext} ctx
 * @returns {Promise<Record<string, unknown>>}
 */
export async function answerFetch(data, ctx) {
    const id = data.id;
    /** @type {Secrets | null} */
    let secrets = null;
    try {
        const req = readRequest(data);
        const byName = new Map(ctx.needs.secrets.map((n) => [n.name, n]));
        const declared = new Set(byName.keys());

        /** @type {URL} */
        let url;
        try {
            url = new URL(req.url);
        } catch {
            throw new FetchRefused(`${JSON.stringify(req.url)} isn't an absolute URL; a request with a secret goes to one of its origins, like "https://api.example.com/v1/..."`);
        }

        // a reference anywhere but a header is refused: the URL and the
        // body are never filled, and services echo them
        for (const form of urlForms(req.url, url)) {
            const [first] = referencesIn(form, declared);
            if (first === undefined) continue;
            const q = form.indexOf("?");
            throw misplaced(first.name, q >= 0 && first.at > q ? "the query" : "the URL");
        }
        if (req.body !== null) {
            const text = typeof req.body === "string" ? req.body : new TextDecoder().decode(req.body);
            for (const form of decodedToo(text)) {
                const [first] = referencesIn(form, declared);
                if (first !== undefined) throw misplaced(first.name, "the body");
            }
        }

        // each reference in a header: a declared secret, in its own header
        /** @type {Map<string, import("./app-needs.js").SecretNeed>} */
        const used = new Map();
        for (const [name, value] of req.headers) {
            for (const { name: secret, bare } of referencesIn(value, declared)) {
                if (bare) throw new FetchRefused(`$${secret} in the ${name} header: write it as ${ref(secret)}`);
                const need = byName.get(secret);
                if (need === undefined) {
                    throw new FetchRefused(`${ref(secret)} isn't a secret ${NEEDS_PATH} declares; declare it under needs.secrets, with its origins and the header it goes in`);
                }
                if (need.header.toLowerCase() !== name.toLowerCase()) {
                    throw new FetchRefused(`${ref(secret)} is in the ${name} header; it goes ${itsPlace(need)}`);
                }
                used.set(secret, need);
            }
        }
        if (used.size === 0) {
            throw new FetchRefused("the request names no secret; without one, agex.fetch is the app's own fetch");
        }

        // where it goes: https:, never the studio's, and each secret's own origins
        if (url.username !== "" || url.password !== "") {
            throw new FetchRefused(`the URL has credentials in it; give the URL alone, and the key as a secret in its header`);
        }
        if (url.protocol !== "https:") {
            throw new FetchRefused(`${url.origin === "null" ? JSON.stringify(req.url) : url.origin} isn't https:; a request with a secret goes over https: only`);
        }
        const refusal = originRefusal(url.origin, ctx.studioOrigins === undefined ? {} : { studioOrigins: ctx.studioOrigins });
        if (refusal !== null) throw new FetchRefused(refusal);
        for (const need of used.values()) {
            if (!need.origins.includes(url.origin)) {
                throw new FetchRefused(`${need.name} may go to ${need.origins.join(", ")} only, not ${url.origin} (${NEEDS_PATH} lists its origins)`);
            }
        }

        // the values, from the app's grants
        /** @type {Record<string, { value: string, origins: string[] }>} */
        const specs = {};
        for (const need of used.values()) {
            const value = await ctx.grantFor(need);
            if (value === null) {
                throw new FetchRefused(`this app has no key for ${need.name}: the viewer hasn't granted one`);
            }
            specs[need.name] = { value, origins: need.origins };
        }
        secrets = new Secrets(specs);

        const fetchFn = ctx.fetch ?? globalThis.fetch;
        const res = await request(
            { url: url.href, method: req.method, headers: req.headers, ...(req.body !== null && { body: req.body }), follow: false },
            secrets,
            { fetch: (input, init) => fetchFn(input, { ...init, credentials: "omit" }) },
            ctx.signal,
        );
        if (res.hiddenRedirect) {
            throw new FetchRefused(`${url.origin} answered with a redirect, which a request with a secret doesn't follow`);
        }
        if (res.status < MIN_STATUS || res.status > MAX_STATUS) {
            throw new FetchRefused(`${url.origin} answered with status ${res.status}, which a response can't carry`);
        }
        return {
            type: "agex-fetch-result",
            id,
            status: res.status,
            statusText: res.statusText,
            url: res.url,
            headers: Object.entries(res.headers),
            body: res.bytes,
            error: null,
        };
    } catch (e) {
        const message = e instanceof FetchRefused ? e.message : `agex.fetch: ${e instanceof Error ? e.message : String(e)}`;
        // a message never carries a key, even one a service put in its error
        return { type: "agex-fetch-result", id, error: secrets === null ? message : secrets.scrub(message) };
    }
}

/** The requests each frame's page has running, by id: their stops.
 *  @type {WeakMap<object, Map<string, AbortController>>} */
const running = new WeakMap();

/**
 * Answer the `agex-fetch` message `data` from the page in `frame` with
 * `answer`, and post the reply back.
 *
 * @param {HTMLIFrameElement} frame
 * @param {Record<string, unknown>} data
 * @param {FetchAnswer | null} answer null: no request with a secret is answered here
 * @returns {Promise<void>} settles once the reply is posted
 */
export async function relayFetch(frame, data, answer) {
    const id = String(data.id);
    const stop = new AbortController();
    const calls = running.get(frame) ?? new Map();
    running.set(frame, calls);
    // an id still running is stopped first: only the newest could be
    // cancelled by it
    calls.get(id)?.abort();
    calls.set(id, stop);
    /** @type {Record<string, unknown>} */
    let reply;
    try {
        reply = answer === null
            ? { type: "agex-fetch-result", id: data.id, error: "agex.fetch: a request with a secret isn't available here" }
            : await answer(data, stop.signal);
    } catch (e) {
        reply = { type: "agex-fetch-result", id: data.id, error: `agex.fetch: ${e instanceof Error ? e.message : String(e)}` };
    } finally {
        if (calls.get(id) === stop) calls.delete(id);
    }
    replyToApp(frame, reply);
}

/** Abort the request `id` of the page in `frame`, as its app asked.
 *  @param {HTMLIFrameElement} frame @param {unknown} id */
export function cancelFetch(frame, id) {
    running.get(frame)?.get(String(id))?.abort();
}

/** Abort every request of the page in `frame`: it was replaced or
 *  closed. @param {HTMLIFrameElement} frame */
export function cancelFetches(frame) {
    const calls = running.get(frame);
    if (calls === undefined) return;
    for (const stop of calls.values()) stop.abort();
    calls.clear();
}
