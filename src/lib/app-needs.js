/**
 * An app's needs: what `app/agex.json` says the app needs from its
 * viewer (their model, and keys for named services), parsed and checked.
 *
 *     { "needs": { "model": true, "secrets": [{ "name": "STRIPE_KEY",
 *       "origins": ["https://api.stripe.com"],
 *       "in": "header:Authorization", "why": "to look up prices" }] } }
 *
 * A secret goes to its origins only, in its one header, so the checks
 * here are strict: an origin is `https://host[:port]` alone, never the
 * studio's or its apps', and the header is one a page may set and a
 * service reads a key from. Unknown keys are mistakes, named, so a typo
 * doesn't quietly drop a need.
 */

import { APPS_ORIGIN } from "./apps-origin.js";

/** Where an app declares its needs. */
export const NEEDS_PATH = "app/agex.json";

/** The studio's domain: no secret goes to it or to anything under it. */
const STUDIO_DOMAIN = "agex.studio";

/** The longest `why` an app may give: a phrase for the panel, not a page. */
export const WHY_MAX = 200;

/**
 * @typedef {{ name: string, origins: string[], header: string, why: string }} SecretNeed
 * @typedef {{ model: boolean, secrets: SecretNeed[] }} AppNeeds
 */

/** An app that declares nothing. @returns {AppNeeds} */
export const noNeeds = () => ({ model: false, secrets: [] });

const NAME_RE = /^[A-Z][A-Z0-9_]*$/;
/** An HTTP header name: a token (RFC 9110). */
const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Request headers a page can't set (the fetch standard's forbidden
 *  request headers): the browser sets them itself, or drops them. */
const FORBIDDEN_HEADERS = new Set([
    "accept-charset",
    "accept-encoding",
    "access-control-request-headers",
    "access-control-request-method",
    "access-control-request-private-network",
    "connection",
    "content-length",
    "cookie",
    "cookie2",
    "date",
    "dnt",
    "expect",
    "host",
    "keep-alive",
    "origin",
    "referer",
    "set-cookie",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "via",
]);
const FORBIDDEN_PREFIXES = ["proxy-", "sec-"];

/** Request headers that say what the request is (its body's type, what
 *  it accepts, its method), which a service doesn't read a key from. */
const DESCRIPTIVE_HEADERS = new Set([
    "accept",
    "accept-language",
    "content-language",
    "content-type",
    "range",
    "x-http-method",
    "x-http-method-override",
    "x-method-override",
]);

const TOP_KEYS = ["needs"];
const NEEDS_KEYS = ["model", "secrets"];
const SECRET_KEYS = ["name", "origins", "in", "why"];

/**
 * Parse and check an app's `app/agex.json`. `null` (no file) is no
 * needs. Each error names the file, where in it, and what to write
 * instead; with any error, `needs` is no needs at all, so an app whose
 * declaration is broken is given nothing.
 *
 * `studioOrigins` are the origins a secret never goes to, beside the
 * studio's domain: by default the apps' origin and this page's own.
 *
 * @param {string | null} text
 * @param {{ studioOrigins?: Iterable<string> }} [opts]
 * @returns {{ needs: AppNeeds, errors: string[] }}
 */
export function parseNeeds(text, opts = {}) {
    if (text === null) return { needs: noNeeds(), errors: [] };
    /** @type {unknown} */
    let doc;
    try {
        doc = JSON.parse(text);
    } catch (e) {
        return { needs: noNeeds(), errors: [`${NEEDS_PATH}: invalid JSON: ${e instanceof Error ? e.message : String(e)}`] };
    }
    const studio = new Set(opts.studioOrigins ?? defaultStudioOrigins());
    /** @type {string[]} */
    const errors = [];
    const fail = (/** @type {string} */ where, /** @type {string} */ message) =>
        errors.push(`${NEEDS_PATH}: ${where ? `${where}: ` : ""}${message}`);
    const needs = noNeeds();

    if (!isObject(doc)) {
        fail("", `the file must be an object, like { "needs": { "model": true } }; got ${describe(doc)}`);
        return { needs: noNeeds(), errors };
    }
    unknownKeys(doc, TOP_KEYS, "", fail);
    const declared = doc.needs;
    if (declared !== undefined) {
        if (!isObject(declared)) {
            fail("needs", `must be an object, like { "model": true }; got ${describe(declared)}`);
        } else {
            unknownKeys(declared, NEEDS_KEYS, "needs", fail);
            if (declared.model !== undefined) {
                if (typeof declared.model === "boolean") needs.model = declared.model;
                else fail("needs.model", `must be true or false; got ${describe(declared.model)}`);
            }
            if (declared.secrets !== undefined) {
                if (!Array.isArray(declared.secrets)) {
                    fail("needs.secrets", `must be a list of secrets; got ${describe(declared.secrets)}`);
                } else {
                    /** @type {Set<string>} */
                    const names = new Set();
                    declared.secrets.forEach((entry, i) => {
                        const secret = checkSecret(entry, `needs.secrets[${i}]`, studio, fail);
                        if (secret === null) return;
                        if (names.has(secret.name)) {
                            fail(`needs.secrets[${i}].name`, `"${secret.name}" is declared twice; give each secret its own name`);
                            return;
                        }
                        names.add(secret.name);
                        needs.secrets.push(secret);
                    });
                }
            }
        }
    }
    return errors.length > 0 ? { needs: noNeeds(), errors } : { needs, errors };
}

/**
 * The origins a secret never goes to, beside the studio's domain: the
 * apps' origin, and the studio's own where it runs (a development
 * server's, say).
 *
 * @returns {string[]}
 */
function defaultStudioOrigins() {
    const here = globalThis.location?.origin;
    return [APPS_ORIGIN, ...(typeof here === "string" && here !== "null" ? [here] : [])];
}

/**
 * One secret, checked and normalized; null when it has an error.
 *
 * @param {unknown} entry
 * @param {string} at
 * @param {Set<string>} studio
 * @param {(where: string, message: string) => void} fail
 * @returns {SecretNeed | null}
 */
function checkSecret(entry, at, studio, fail) {
    if (!isObject(entry)) {
        fail(at, `must be an object with name, origins, in and why; got ${describe(entry)}`);
        return null;
    }
    const ok = unknownKeys(entry, SECRET_KEYS, at, fail);
    const name = checkName(entry.name, `${at}.name`, fail);
    const origins = checkOrigins(entry.origins, `${at}.origins`, studio, fail);
    const header = checkIn(entry.in, `${at}.in`, fail);
    const why = checkWhy(entry.why, `${at}.why`, fail);
    if (name === null || origins === null || header === null || why === null || !ok) return null;
    return { name, origins, header, why };
}

/**
 * @param {unknown} name @param {string} at
 * @param {(where: string, message: string) => void} fail
 * @returns {string | null}
 */
function checkName(name, at, fail) {
    if (name === undefined) {
        fail(at, `is missing; name the secret, like "STRIPE_KEY"`);
        return null;
    }
    if (typeof name !== "string") {
        fail(at, `must be a string, like "STRIPE_KEY"; got ${describe(name)}`);
        return null;
    }
    if (!NAME_RE.test(name)) {
        const suggested = name.toUpperCase().replace(/[^A-Z0-9_]+/g, "_").replace(/^[^A-Z]+/, "");
        const like = NAME_RE.test(suggested) ? `"${suggested}"` : `"STRIPE_KEY"`;
        fail(at, `"${name}" must be upper-case letters, digits and _, starting with a letter, like ${like}`);
        return null;
    }
    return name;
}

/**
 * @param {unknown} origins @param {string} at @param {Set<string>} studio
 * @param {(where: string, message: string) => void} fail
 * @returns {string[] | null}
 */
function checkOrigins(origins, at, studio, fail) {
    if (origins === undefined) {
        fail(at, `is missing; list the origins the secret may go to, like ["https://api.example.com"]`);
        return null;
    }
    if (!Array.isArray(origins)) {
        const hint = typeof origins === "string" ? `["${origins}"]` : `["https://api.example.com"]`;
        fail(at, `must be a list of origins, like ${hint}; got ${describe(origins)}`);
        return null;
    }
    if (origins.length === 0) {
        fail(at, `is empty; list the origins the secret may go to, like ["https://api.example.com"]`);
        return null;
    }
    /** @type {string[]} */
    const out = [];
    let ok = true;
    origins.forEach((raw, i) => {
        const origin = checkOrigin(raw, `${at}[${i}]`, studio, fail);
        if (origin === null) ok = false;
        else if (!out.includes(origin)) out.push(origin);
    });
    return ok ? out : null;
}

/**
 * One origin, normalized (`https://API.Example.com:443/` is
 * `https://api.example.com`); null when it isn't `https://host[:port]`
 * alone, or is one a secret never goes to.
 *
 * @param {unknown} raw @param {string} at @param {Set<string>} studio
 * @param {(where: string, message: string) => void} fail
 * @returns {string | null}
 */
function checkOrigin(raw, at, studio, fail) {
    if (typeof raw !== "string") {
        fail(at, `must be a string, like "https://api.example.com"; got ${describe(raw)}`);
        return null;
    }
    const shown = JSON.stringify(raw);
    if (raw.includes("*")) {
        fail(at, `${shown} has a wildcard; list each origin the secret may go to, like "https://api.example.com"`);
        return null;
    }
    /** @type {URL | null} */
    let url = null;
    try {
        url = new URL(raw);
    } catch {
        // not a URL: said below
    }
    if (url === null || !raw.includes("://")) {
        const host = raw.replace(/^[a-z]+:\/*/i, "").replace(/[/?#].*$/, "");
        fail(at, `${shown} isn't an origin; give the scheme and host, like "https://${host || "api.example.com"}"`);
        return null;
    }
    if (url.protocol === "http:") {
        fail(at, `${shown} is http:; a secret goes over https: only ("https://${url.host}")`);
        return null;
    }
    if (url.protocol !== "https:") {
        fail(at, `${shown} isn't an https: origin; give one like "https://api.example.com"`);
        return null;
    }
    const origin = url.origin;
    if (url.username !== "" || url.password !== "" || /^https:\/\/[^/?#]*@/i.test(raw)) {
        fail(at, `${shown} has credentials; give the origin alone ("${origin}") and the key as the secret`);
        return null;
    }
    /** @type {string[]} */
    const extra = [];
    if (url.pathname !== "/") extra.push("a path");
    if (raw.includes("?")) extra.push("a query");
    if (raw.includes("#")) extra.push("a fragment");
    if (extra.length > 0) {
        fail(at, `${shown} has ${extra.join(" and ")}; give the origin alone ("${origin}")`);
        return null;
    }
    const host = url.hostname.replace(/\.$/, "");
    if (host === STUDIO_DOMAIN || host.endsWith(`.${STUDIO_DOMAIN}`) || studio.has(origin)) {
        fail(at, `${shown} is the studio's own; a secret never goes to the studio or its apps`);
        return null;
    }
    return origin;
}

/**
 * The header named by `in`, as written; null when `in` isn't
 * `header:<Name>` with a name a key can go in.
 *
 * @param {unknown} where @param {string} at
 * @param {(where: string, message: string) => void} fail
 * @returns {string | null}
 */
function checkIn(where, at, fail) {
    if (where === undefined) {
        fail(at, `is missing; say which request header the secret goes in, like "header:Authorization"`);
        return null;
    }
    if (typeof where !== "string") {
        fail(at, `must be a string, like "header:Authorization"; got ${describe(where)}`);
        return null;
    }
    const shown = JSON.stringify(where);
    const m = /^header:(.*)$/.exec(where);
    if (m === null) {
        fail(at, `${shown}: a secret goes in one request header only, never a URL, query or body; write "header:<Name>", like "header:Authorization"`);
        return null;
    }
    const header = /** @type {string} */ (m[1]);
    if (!TOKEN_RE.test(header)) {
        const trimmed = header.trim();
        const like = TOKEN_RE.test(trimmed) ? `"header:${trimmed}"` : `"header:Authorization"`;
        fail(at, `${shown}: "${header}" isn't a header name (letters, digits and -, no spaces); write it like ${like}`);
        return null;
    }
    const lower = header.toLowerCase();
    if (FORBIDDEN_HEADERS.has(lower) || FORBIDDEN_PREFIXES.some((p) => lower.startsWith(p))) {
        fail(at, `${shown}: the browser sets ${header} itself and a page can't, so a secret can't go there; use the header the service reads its key from, like "header:Authorization"`);
        return null;
    }
    if (DESCRIPTIVE_HEADERS.has(lower)) {
        fail(at, `${shown}: ${header} describes the request, and a service doesn't read a key from it; use the header the service reads its key from, like "header:Authorization"`);
        return null;
    }
    return header;
}

/**
 * @param {unknown} why @param {string} at
 * @param {(where: string, message: string) => void} fail
 * @returns {string | null}
 */
function checkWhy(why, at, fail) {
    if (why === undefined) {
        fail(at, `is missing; say what the app uses the key for, like "to look up prices"`);
        return null;
    }
    if (typeof why !== "string") {
        fail(at, `must be a string, like "to look up prices"; got ${describe(why)}`);
        return null;
    }
    const trimmed = why.trim();
    if (trimmed === "") {
        fail(at, `is empty; say what the app uses the key for, like "to look up prices"`);
        return null;
    }
    if (trimmed.length > WHY_MAX) {
        fail(at, `is ${trimmed.length} characters; keep it to ${WHY_MAX} or fewer, a phrase the viewer reads before allowing`);
        return null;
    }
    return trimmed;
}

/**
 * Name each key of `obj` not in `known`; whether there were none.
 *
 * @param {Record<string, unknown>} obj @param {string[]} known @param {string} at
 * @param {(where: string, message: string) => void} fail
 */
function unknownKeys(obj, known, at, fail) {
    let ok = true;
    for (const key of Object.keys(obj)) {
        if (known.includes(key)) continue;
        ok = false;
        fail(at, `unknown key "${key}" (expected ${known.map((k) => `"${k}"`).join(", ")})`);
    }
    return ok;
}

/** @param {unknown} v @returns {v is Record<string, unknown>} */
function isObject(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A value, briefly, as an error shows what it got. @param {unknown} v */
function describe(v) {
    if (v === null) return "null";
    if (Array.isArray(v)) return "a list";
    if (typeof v === "object") return "an object";
    const text = JSON.stringify(v) ?? String(v);
    return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}
