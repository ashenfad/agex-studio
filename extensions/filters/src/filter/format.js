/**
 * A site's filter: what it hides on the site's pages and which requests
 * the site's pages make that it blocks.
 *
 * ```json
 * {
 *   "version": 1,
 *   "hide": [
 *     { "selector": "shreddit-ad-post", "why": "promoted posts" },
 *     { "selector": "article", "hasText": "Promoted", "why": "native ads in the feed" },
 *     { "selector": "span.badge", "hasText": "Sponsored", "upward": "article" }
 *   ],
 *   "block": [
 *     { "urlFilter": "||ads.example^", "types": ["script", "image"], "why": "ad requests" }
 *   ]
 * }
 * ```
 *
 * A filter is data an agent writes, so nothing applies it until
 * `checkFilter` has passed it, and what applies is the filter it
 * returns, not the one it was given.
 */

import {
    BLOCK_TYPES, MAX_BLOCK, MAX_HIDE, MAX_UPWARD, MAX_WHY, isSite, patternProblem,
    rootProblem, selectorProblem, urlFilterProblem,
} from "./guards.js";

/** The format's version: a filter says which it is written in. */
export const FILTER_VERSION = 1;

/**
 * @typedef {{
 *   selector: string,
 *   hasText?: string,
 *   upward?: number | string,
 *   matchesAttr?: { name: string, pattern: string },
 *   why?: string,
 * }} HideRule
 *   `selector`: what to hide, a CSS selector, run in the page and in each
 *   of its open shadow roots.
 *   `hasText`: only a match whose text, as a person sees it, this pattern
 *   (a regular expression's source) finds.
 *   `matchesAttr`: only a match with the attribute `name` whose value
 *   `pattern` finds.
 *   `upward`: hide an ancestor of the match instead: this many levels up,
 *   or the nearest one this selector matches (out of a shadow root to
 *   its host and on).
 */

/**
 * @typedef {{
 *   urlFilter: string,
 *   types?: (typeof BLOCK_TYPES)[number][],
 *   why?: string,
 * }} BlockRule
 *   `urlFilter`: the requests to block, in `declarativeNetRequest`'s
 *   syntax, held to those the site's own pages make.
 *   `types`: only requests for these resources; every kind but a page
 *   itself when left out.
 */

/** @typedef {{ version: 1, hide: HideRule[], block: BlockRule[] }} Filter */

/** @typedef {{ ok: true, filter: Filter } | { ok: false, errors: string[] }} Checked */

const FILTER_FIELDS = ["version", "hide", "block"];
const HIDE_FIELDS = ["selector", "hasText", "upward", "matchesAttr", "why"];
const BLOCK_FIELDS = ["urlFilter", "types", "why"];
const ATTR_NAME = /^[^\s"'>/=\x00-\x1f]+$/;

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Whether `filter` is a filter `site` may apply, and the filter to apply
 * (only the fields the format has, `hide` and `block` always there), or
 * every reason it isn't, each naming the field (`hide[3].selector: ...`).
 *
 * @param {unknown} filter
 * @param {{ site: string }} opts the registrable domain it is for (`reddit.com`)
 * @returns {Checked}
 */
export function checkFilter(filter, { site }) {
    if (!isSite(site)) return { ok: false, errors: [`site: ${JSON.stringify(site)} is not a domain (like reddit.com)`] };
    if (!isRecord(filter)) return { ok: false, errors: ["the filter must be an object: { version: 1, hide: [...], block: [...] }"] };
    /** @type {string[]} */
    const errors = [];
    for (const key of Object.keys(filter)) {
        if (!FILTER_FIELDS.includes(key)) errors.push(`${key}: not a field of a filter (${FILTER_FIELDS.join(", ")})`);
    }
    if (filter.version !== FILTER_VERSION) errors.push(`version: must be ${FILTER_VERSION}`);

    const hide = listOf(filter.hide, "hide", MAX_HIDE, errors);
    const block = listOf(filter.block, "block", MAX_BLOCK, errors);
    const hideRules = hide.map((rule, i) => hideRule(rule, `hide[${i}]`, errors));
    const blockRules = block.map((rule, i) => blockRule(rule, `block[${i}]`, site, errors));

    if (errors.length > 0) return { ok: false, errors };
    return {
        ok: true,
        filter: {
            version: FILTER_VERSION,
            hide: /** @type {HideRule[]} */ (hideRules),
            block: /** @type {BlockRule[]} */ (blockRules),
        },
    };
}

/**
 * `value` as a list of rules (none when left out), noting in `errors`
 * when it isn't one or has more than `max`.
 *
 * @param {unknown} value
 * @param {string} at
 * @param {number} max
 * @param {string[]} errors
 * @returns {unknown[]}
 */
function listOf(value, at, max, errors) {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
        errors.push(`${at}: must be a list of rules`);
        return [];
    }
    if (value.length > max) errors.push(`${at}: has ${value.length} rules; at most ${max}`);
    return value;
}

/**
 * @param {Record<string, unknown>} rule
 * @param {string} at
 * @param {readonly string[]} fields
 * @param {string} kind
 * @param {string[]} errors
 */
function unknownFields(rule, at, fields, kind, errors) {
    for (const key of Object.keys(rule)) {
        if (!fields.includes(key)) errors.push(`${at}.${key}: not a field of a ${kind} rule (${fields.join(", ")})`);
    }
}

/**
 * @param {unknown} why
 * @param {string} at
 * @param {string[]} errors
 */
function checkWhy(why, at, errors) {
    if (why === undefined) return;
    if (typeof why !== "string") errors.push(`${at}.why: must be a string`);
    else if (why.length > MAX_WHY) errors.push(`${at}.why: is ${why.length} characters; at most ${MAX_WHY}`);
}

/**
 * The hide rule `rule` normalized, or null, its problems noted in `errors`.
 *
 * @param {unknown} rule
 * @param {string} at
 * @param {string[]} errors
 * @returns {HideRule | null}
 */
function hideRule(rule, at, errors) {
    if (!isRecord(rule)) {
        errors.push(`${at}: must be an object with a selector`);
        return null;
    }
    const before = errors.length;
    unknownFields(rule, at, HIDE_FIELDS, "hide", errors);
    const { selector, hasText, upward, matchesAttr, why } = rule;

    const bad = selectorProblem(selector);
    if (bad) errors.push(`${at}.selector: ${bad}`);
    else {
        const root = rootProblem(/** @type {string} */ (selector));
        if (root) errors.push(`${at}.selector: ${root}`);
    }

    if (hasText !== undefined) {
        const p = patternProblem(hasText);
        if (p) errors.push(`${at}.hasText: ${p}`);
    }

    if (upward !== undefined) {
        if (typeof upward === "number") {
            if (!Number.isInteger(upward) || upward < 1 || upward > MAX_UPWARD) {
                errors.push(`${at}.upward: a count must be a whole number from 1 to ${MAX_UPWARD}`);
            }
        } else if (typeof upward === "string") {
            const p = selectorProblem(upward) ?? rootProblem(upward);
            if (p) errors.push(`${at}.upward: ${p}`);
        } else {
            errors.push(`${at}.upward: must be a count of ancestors (1, 2, ...) or a CSS selector for the nearest matching one`);
        }
    }

    if (matchesAttr !== undefined) {
        if (!isRecord(matchesAttr)) {
            errors.push(`${at}.matchesAttr: must be { name, pattern }`);
        } else {
            unknownFields(matchesAttr, `${at}.matchesAttr`, ["name", "pattern"], "matchesAttr", errors);
            const { name, pattern } = matchesAttr;
            if (typeof name !== "string" || !ATTR_NAME.test(name)) errors.push(`${at}.matchesAttr.name: must be an attribute's name (like href or data-testid)`);
            else if (/^data-agex/i.test(name)) errors.push(`${at}.matchesAttr.name: names the extension's own data-agex-* attributes; match the page's own`);
            const p = patternProblem(pattern);
            if (p) errors.push(`${at}.matchesAttr.pattern: ${p}`);
        }
    }

    checkWhy(why, at, errors);
    if (errors.length > before) return null;

    /** @type {HideRule} */
    const out = { selector: /** @type {string} */ (selector) };
    if (hasText !== undefined) out.hasText = /** @type {string} */ (hasText);
    if (upward !== undefined) out.upward = /** @type {number | string} */ (upward);
    if (matchesAttr !== undefined) {
        const m = /** @type {{ name: string, pattern: string }} */ (matchesAttr);
        out.matchesAttr = { name: m.name.toLowerCase(), pattern: m.pattern };
    }
    if (why !== undefined) out.why = /** @type {string} */ (why);
    return out;
}

/**
 * The block rule `rule` normalized (its types deduplicated), or null, its
 * problems noted in `errors`.
 *
 * @param {unknown} rule
 * @param {string} at
 * @param {string} site
 * @param {string[]} errors
 * @returns {BlockRule | null}
 */
function blockRule(rule, at, site, errors) {
    if (!isRecord(rule)) {
        errors.push(`${at}: must be an object with a urlFilter`);
        return null;
    }
    const before = errors.length;
    unknownFields(rule, at, BLOCK_FIELDS, "block", errors);
    const { urlFilter, types, why } = rule;

    const p = urlFilterProblem(urlFilter, site);
    if (p) errors.push(`${at}.urlFilter: ${p}`);

    /** @type {BlockRule["types"]} */
    let kinds;
    if (types !== undefined) {
        if (!Array.isArray(types) || types.length === 0) {
            errors.push(`${at}.types: must be a non-empty list of resource types (${BLOCK_TYPES.join(", ")}), or left out for all of them`);
        } else {
            for (const t of types) {
                if (t === "main_frame") errors.push(`${at}.types: main_frame would block the site's own pages; no block rule may name it`);
                else if (!BLOCK_TYPES.includes(/** @type {any} */ (t))) errors.push(`${at}.types: ${JSON.stringify(t)} is not a resource type (${BLOCK_TYPES.join(", ")})`);
            }
            kinds = [...new Set(/** @type {BlockRule["types"] & {}} */ (types))];
        }
    }

    checkWhy(why, at, errors);
    if (errors.length > before) return null;

    /** @type {BlockRule} */
    const out = { urlFilter: /** @type {string} */ (urlFilter) };
    if (kinds) out.types = kinds;
    if (why !== undefined) out.why = /** @type {string} */ (why);
    return out;
}

/**
 * A checked filter's block rules as `declarativeNetRequest` rules, ids
 * from `firstId` up. Each is held to requests the site's own pages make
 * (`initiatorDomains: [site]`, which covers its subdomains) and never
 * blocks a page itself (no `main_frame`), whatever the filter says.
 *
 * @param {Filter} filter
 * @param {{ site: string, firstId: number }} opts
 * @returns {chrome.declarativeNetRequest.Rule[]}
 */
export function toDnrRules(filter, { site, firstId }) {
    if (!isSite(site)) throw new Error(`not a site: ${JSON.stringify(site)}`);
    return filter.block.map((rule, i) => {
        const types = (rule.types ?? BLOCK_TYPES).filter((t) => BLOCK_TYPES.includes(t));
        return {
            id: firstId + i,
            priority: 1,
            action: { type: /** @type {chrome.declarativeNetRequest.RuleActionType} */ ("block") },
            condition: {
                urlFilter: rule.urlFilter,
                initiatorDomains: [site],
                resourceTypes: /** @type {chrome.declarativeNetRequest.ResourceType[]} */ ([...types]),
            },
        };
    });
}
