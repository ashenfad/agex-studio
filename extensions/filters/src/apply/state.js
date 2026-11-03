/**
 * What the extension keeps of the filters the person accepted: one entry
 * per site (its registrable domain, `reddit.com`) with its filter,
 * whether it is on, the filter's version (one more at each accept), the
 * ids of its block rules and the filter it replaced (for an undo); and a
 * pause for every site at once. It is
 * kept in `chrome.storage.local` under `APPLIED`, written by the service
 * worker and read by the content script on each of the site's pages.
 *
 * Everything here is pure: the transitions return a new state and touch
 * no extension API, so they run in the worker, a content script or a test.
 */

import { checkFilter, toDnrRules } from "../filter/format.js";
import { MAX_HIDE, isSite } from "../filter/guards.js";

/** The `chrome.storage.local` key the state is kept under. */
export const APPLIED = "applied";

/** The prefix of the ids of the content scripts registered for sites. */
export const SCRIPT_PREFIX = "filters:";

/**
 * @typedef {{
 *   filter: import("../filter/format.js").Filter,
 *   on: boolean,
 *   version: number,
 *   rules: number[],
 *   previous?: import("../filter/format.js").Filter,
 * }} SiteEntry
 *   `filter`: the accepted filter, as the worker's check returned it.
 *   `on`: whether it applies (the person's per-site switch).
 *   `version`: 1 at its first accept, one more at each since.
 *   `rules`: the ids of its `declarativeNetRequest` rules, one per block
 *   rule, consecutive, none shared with another site.
 *   `previous`: the filter this one replaced, which an undo goes back
 *   to; none for a site's first, whose undo removes it.
 */

/** @typedef {{ paused: boolean, sites: Record<string, SiteEntry> }} State */

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** The state before anything is accepted. @returns {State} */
export const emptyState = () => ({ paused: false, sites: {} });

/**
 * `raw`, as storage holds it, as a state: what isn't a state's is left
 * out (an entry under a key that isn't a site, a filter that isn't an
 * object), and a missing value reads as nothing accepted.
 *
 * @param {unknown} raw
 * @returns {State}
 */
export function readState(raw) {
    const state = emptyState();
    if (!isRecord(raw)) return state;
    state.paused = raw.paused === true;
    if (!isRecord(raw.sites)) return state;
    for (const [site, entry] of Object.entries(raw.sites)) {
        if (!isSite(site) || !isRecord(entry) || !isRecord(entry.filter)) continue;
        const version = Number.isInteger(entry.version) && /** @type {number} */ (entry.version) > 0 ? /** @type {number} */ (entry.version) : 1;
        const rules = Array.isArray(entry.rules) ? entry.rules.filter((id) => Number.isInteger(id) && id > 0) : [];
        state.sites[site] = {
            filter: /** @type {SiteEntry["filter"]} */ (/** @type {unknown} */ (entry.filter)),
            on: entry.on !== false,
            version,
            rules,
            ...(isRecord(entry.previous) && { previous: /** @type {SiteEntry["filter"]} */ (/** @type {unknown} */ (entry.previous)) }),
        };
    }
    return state;
}

/**
 * The site among `sites` whose pages `host` is one of: the site itself or
 * a subdomain of it, matched on a dot boundary (`old.reddit.com` is
 * `reddit.com`'s, `notreddit.com` isn't), the longest when more than one
 * is; or null.
 *
 * @param {string} host a page's `location.hostname`
 * @param {Iterable<string>} sites
 * @returns {string | null}
 */
export function siteOfHost(host, sites) {
    const h = host.toLowerCase().replace(/\.$/, "");
    /** @type {string | null} */
    let best = null;
    for (const site of sites) {
        if ((h === site || h.endsWith(`.${site}`)) && (best === null || site.length > best.length)) best = site;
    }
    return best;
}

/** The match patterns of a site's pages: the site and its subdomains, any scheme and port.
 *  @param {string} site @returns {string[]} */
export const matchesOf = (site) => [`*://${site}/*`, `*://*.${site}/*`];

/** The id of the content script registered for `site`. @param {string} site */
export const scriptId = (site) => `${SCRIPT_PREFIX}${site}`;

/** The site a registered content script's id is for, or null when it is no site's.
 *  @param {string} id @returns {string | null} */
export const siteOfScript = (id) => (id.startsWith(SCRIPT_PREFIX) ? id.slice(SCRIPT_PREFIX.length) : null);

/**
 * The check a context with no DOM (the service worker) can make of a
 * filter: its shape and its block rules, in full (`checkFilter`), and
 * that its hide rules are a list of at most `MAX_HIDE` objects. A hide
 * rule's selectors need a DOM to parse, so the content script checks the
 * whole filter again, on the page, before it hides anything.
 *
 * @param {unknown} filter
 * @param {string} site
 * @returns {import("../filter/format.js").Checked}
 */
export function checkWithoutDom(filter, site) {
    if (!isRecord(filter)) return checkFilter(filter, { site });
    const { hide } = filter;
    /** @type {string[]} */
    const errors = [];
    if (hide !== undefined && !Array.isArray(hide)) errors.push("hide: must be a list of rules");
    else if (Array.isArray(hide)) {
        if (hide.length > MAX_HIDE) errors.push(`hide: has ${hide.length} rules; at most ${MAX_HIDE}`);
        hide.forEach((rule, i) => {
            if (!isRecord(rule)) errors.push(`hide[${i}]: must be an object with a selector`);
        });
    }
    const rest = checkFilter({ ...filter, hide: [] }, { site });
    if ("errors" in rest) return { ok: false, errors: [...errors, ...rest.errors] };
    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, filter: { ...rest.filter, hide: /** @type {any[]} */ (hide ?? []) } };
}

/**
 * The lowest `count` consecutive rule ids, from 1, that no site but
 * `site` holds.
 *
 * @param {State} state
 * @param {string} site
 * @param {number} count
 * @returns {number[]}
 */
export function freeIds(state, site, count) {
    if (count === 0) return [];
    const used = new Set(Object.entries(state.sites).flatMap(([s, e]) => (s === site ? [] : e.rules)));
    let first = 1;
    for (;;) {
        let clash = -1;
        for (let id = first; id < first + count; id++) {
            if (used.has(id)) {
                clash = id;
                break;
            }
        }
        if (clash < 0) return Array.from({ length: count }, (_, i) => first + i);
        first = clash + 1;
    }
}

/** A copy of `state`, its sites copied too. @param {State} state @returns {State} */
const copy = (state) => ({ paused: state.paused, sites: { ...state.sites } });

/** @param {State} state @param {string} site */
function entryOf(state, site) {
    const entry = Object.hasOwn(state.sites, site) ? state.sites[site] : undefined;
    if (!entry) throw new Error(`no filter is accepted for ${site}`);
    return entry;
}

/**
 * `filter` accepted as `site`'s filter, on, replacing the one before
 * (kept, for an undo): its version one more than that one's, its block
 * rules given ids no other site holds.
 *
 * @param {State} state
 * @param {string} site
 * @param {import("../filter/format.js").Filter} filter a checked filter
 * @returns {State}
 */
export function acceptFilter(state, site, filter) {
    const next = copy(state);
    const before = Object.hasOwn(state.sites, site) ? state.sites[site] : undefined;
    next.sites[site] = {
        filter,
        on: true,
        version: (before?.version ?? 0) + 1,
        rules: freeIds(state, site, filter.block.length),
        ...(before !== undefined && { previous: before.filter }),
    };
    return next;
}

/**
 * `site`'s last accept undone: the filter it replaced back, on, as a new
 * version (with nothing before it to go back to), or, when it replaced
 * none, `site`'s filter gone.
 *
 * @param {State} state
 * @param {string} site
 * @returns {State}
 */
export function undoAccept(state, site) {
    const { previous, version } = entryOf(state, site);
    if (previous === undefined) return removeSite(state, site);
    const next = copy(state);
    next.sites[site] = { filter: previous, on: true, version: version + 1, rules: freeIds(state, site, previous.block.length) };
    return next;
}

/** `site`'s filter turned on or off. @param {State} state @param {string} site @param {boolean} on @returns {State} */
export function setOn(state, site, on) {
    const next = copy(state);
    next.sites[site] = { ...entryOf(state, site), on };
    return next;
}

/** `site`'s filter forgotten. @param {State} state @param {string} site @returns {State} */
export function removeSite(state, site) {
    const next = copy(state);
    delete next.sites[site];
    return next;
}

/** Every site paused, or resumed. @param {State} state @param {boolean} paused @returns {State} */
export function setPaused(state, paused) {
    return { ...copy(state), paused };
}

/**
 * The `declarativeNetRequest` rules `state` wants installed: each site's
 * block rules, under its ids, while it is on and nothing is paused. A
 * site whose filter no longer passes the check, or whose ids don't fit
 * its rules or are another site's, has none.
 *
 * @param {State} state
 * @returns {chrome.declarativeNetRequest.Rule[]}
 */
export function wantedRules(state) {
    if (state.paused) return [];
    /** @type {Set<number>} */
    const taken = new Set();
    return Object.entries(state.sites).flatMap(([site, entry]) => {
        if (!entry.on) return [];
        const checked = checkWithoutDom(entry.filter, site);
        if (!checked.ok || checked.filter.block.length === 0) return [];
        if (!fitsIds(entry.rules, checked.filter.block.length) || entry.rules.some((id) => taken.has(id))) return [];
        for (const id of entry.rules) taken.add(id);
        return toDnrRules(checked.filter, { site, firstId: entry.rules[0] });
    });
}

/** Whether `ids` are `count` consecutive ids. @param {number[]} ids @param {number} count */
function fitsIds(ids, count) {
    return ids.length === count && ids.every((id, i) => id === ids[0] + i);
}
