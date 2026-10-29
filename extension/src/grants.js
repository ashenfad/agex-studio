/**
 * The sites a session's agent may load in its tabs, as origins, and the
 * `declarativeNetRequest` rules that hold a tab's page loads to them.
 *
 * Only top-level page loads are held: what the agent reads and acts in.
 * A page's own requests (images, scripts, its `fetch`, its frames) go
 * as the page makes them.
 */

/**
 * An origin as the studio grants it: `scheme://host[:port]`, http or
 * https, already in its normal form (as `new URL(...).origin` spells it).
 *
 * @param {unknown} origin
 * @returns {origin is string}
 */
export function isOrigin(origin) {
    if (typeof origin !== "string") return false;
    let url;
    try {
        url = new URL(origin);
    } catch {
        return false;
    }
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === origin;
}

/**
 * A URL's origin, or null for one that isn't http or https (`about:blank`,
 * `data:`, ...), which loads nothing from a site.
 *
 * @param {string} url
 * @returns {string | null}
 */
export function originOf(url) {
    let u;
    try {
        u = new URL(url);
    } catch {
        return null;
    }
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
}

/**
 * Whether `url` loads from a granted origin. A URL with no origin
 * (`about:blank`) loads from nowhere, so it is allowed.
 *
 * @param {string} url
 * @param {readonly string[]} origins
 */
export function granted(url, origins) {
    const origin = originOf(url);
    return origin === null || origins.includes(origin);
}

/**
 * The session rules that hold `tab`'s page loads to `origins`: one rule
 * blocking every top-level load in the tab, and one per origin, of a
 * higher priority, letting that origin's through. Ids are taken from
 * `firstId` up.
 *
 * @param {number} tab
 * @param {readonly string[]} origins
 * @param {number} firstId
 * @returns {chrome.declarativeNetRequest.Rule[]}
 */
export function pageRules(tab, origins, firstId) {
    const main = /** @type {chrome.declarativeNetRequest.ResourceType[]} */ (["main_frame"]);
    return [
        {
            id: firstId,
            priority: 1,
            action: { type: /** @type {chrome.declarativeNetRequest.RuleActionType} */ ("block") },
            condition: { tabIds: [tab], resourceTypes: main },
        },
        ...origins.map((origin, i) => ({
            id: firstId + 1 + i,
            priority: 2,
            action: { type: /** @type {chrome.declarativeNetRequest.RuleActionType} */ ("allow") },
            // anchored at the start, and the path's slash ends the host:
            // `https://a.com/` doesn't match `https://a.com.evil.example/`
            // or `https://a.com@evil.example/`
            condition: { tabIds: [tab], resourceTypes: main, urlFilter: `|${origin}/` },
        })),
    ];
}
