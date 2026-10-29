/**
 * Sites a session's agent may open in its browser tabs, as domains: a
 * grant for a domain covers it and every subdomain (`marriott.com` covers
 * `www.marriott.com`). The extension holds every page load in the
 * session's tabs to them (`extension/src/grants.js`, whose rule this is).
 */

import { granted, isDomain } from "../../extension/src/grants.js";

export { granted, isDomain };

/** The most domains one request asks for. */
export const SITES_MAX = 30;

/**
 * A domain from what an agent or a person typed: a domain, or a URL or
 * host it is read from, lower-cased, without a leading `www.` (the
 * domain covers it), or null when it isn't one (a top-level domain
 * alone, a wildcard, an address that isn't http or https).
 *
 * @param {unknown} input
 * @returns {string | null}
 */
export function domainOf(input) {
    if (typeof input !== "string") return null;
    let text = input.trim().toLowerCase();
    if (text === "") return null;
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(text)) {
        let url;
        try {
            url = new URL(text);
        } catch {
            return null;
        }
        if (url.protocol !== "https:" && url.protocol !== "http:") return null;
        text = url.hostname;
    } else {
        text = text.replace(/[/?#].*$/, "").replace(/:\d+$/, "");
        try {
            text = new URL(`https://${text}/`).hostname;
        } catch {
            return null;
        }
    }
    if (text.startsWith("www.") && isDomain(text.slice(4))) text = text.slice(4);
    return isDomain(text) ? text : null;
}

/**
 * Domains read from a list, each thing that isn't one said, duplicates
 * and domains another in the list covers dropped.
 *
 * @param {unknown} list
 * @returns {{ domains: string[], errors: string[] }}
 */
export function checkDomains(list) {
    const items = Array.isArray(list) ? list : typeof list === "string" ? [list] : [];
    /** @type {string[]} */
    const errors = [];
    /** @type {string[]} */
    const domains = [];
    for (const item of items) {
        const d = domainOf(item);
        if (d === null) errors.push(`domains: ${JSON.stringify(item)} isn't a domain; name one like "marriott.com"`);
        else if (!domains.includes(d)) domains.push(d);
    }
    if (errors.length === 0 && domains.length > SITES_MAX) errors.push(`domains: ask for ${SITES_MAX} or fewer at once`);
    return { domains: domains.filter((d) => !domains.some((o) => o !== d && d.endsWith(`.${o}`))), errors };
}

/**
 * Whether `domains` grant domain `d`: it, or one it is a subdomain of.
 *
 * @param {readonly string[]} domains @param {string} d
 */
export function covered(domains, d) {
    return granted(`https://${d}/`, domains);
}
