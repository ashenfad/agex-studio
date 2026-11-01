/**
 * The sites a session's agent may load in its tabs, as domains, and the
 * `declarativeNetRequest` rules that hold a tab's page loads to them.
 *
 * A grant for a domain covers it and every subdomain of it, over http or
 * https and on any port: `marriott.com` covers `www.marriott.com`, which
 * most sites redirect to, and `book.marriott.com`.
 *
 * Only top-level page loads are held: what the agent reads and acts in.
 * A page's own requests (images, scripts, its `fetch`, its frames) go
 * as the page makes them.
 */

/**
 * A domain as the studio grants it: a host name in its normal form
 * (lower case, punycode, as `new URL(...).hostname` spells it), with no
 * scheme, port or wildcard, and with a dot in it (`localhost` aside), so
 * no grant is for a whole top-level domain.
 *
 * @param {unknown} domain
 * @returns {domain is string}
 */
export function isDomain(domain) {
    if (typeof domain !== "string" || domain === "" || /[^a-z0-9.-]/.test(domain)) return false;
    let url;
    try {
        url = new URL(`https://${domain}/`);
    } catch {
        return false;
    }
    if (url.hostname !== domain || domain.startsWith(".") || domain.endsWith(".")) return false;
    return domain === "localhost" || domain.includes(".");
}

/**
 * A URL's host, or null for one that isn't http or https (`about:blank`,
 * `data:`, ...), which loads nothing from a site.
 *
 * @param {string} url
 * @returns {string | null}
 */
export function hostOf(url) {
    let u;
    try {
        u = new URL(url);
    } catch {
        return null;
    }
    return u.protocol === "https:" || u.protocol === "http:" ? u.hostname : null;
}

/**
 * Whether `url` loads from a granted domain, or a subdomain of one. A
 * URL with no host (`about:blank`) loads from nowhere, so it is allowed.
 *
 * @param {string} url
 * @param {readonly string[]} domains
 */
export function granted(url, domains) {
    const host = hostOf(url);
    return host === null || domains.some((d) => host === d || host.endsWith(`.${d}`));
}

/**
 * The session rules that hold `tab`'s page loads to `domains`: one rule
 * blocking every top-level load in the tab, and one, of a higher
 * priority, letting the domains' through (`requestDomains` matches a
 * domain and its subdomains, as a grant does); and one more for each of
 * `exact`, a host let through alone, not its subdomains. Ids are taken
 * from `firstId` up.
 *
 * @param {number} tab
 * @param {readonly string[]} domains
 * @param {number} firstId
 * @param {readonly string[]} [exact]
 * @returns {chrome.declarativeNetRequest.Rule[]}
 */
export function pageRules(tab, domains, firstId, exact = []) {
    const main = /** @type {chrome.declarativeNetRequest.ResourceType[]} */ (["main_frame"]);
    const block = {
        id: firstId,
        priority: 1,
        action: { type: /** @type {chrome.declarativeNetRequest.RuleActionType} */ ("block") },
        condition: { tabIds: [tab], resourceTypes: main },
    };
    const allow = /** @type {chrome.declarativeNetRequest.RuleActionType} */ ("allow");
    const rules = [block];
    if (domains.length > 0) rules.push({ id: firstId + 1, priority: 2, action: { type: allow }, condition: { tabIds: [tab], resourceTypes: main, requestDomains: [...domains] } });
    for (const [i, host] of exact.entries()) {
        const regexFilter = `^https?://${host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(:[0-9]+)?(/|$)`;
        rules.push({ id: firstId + 2 + i, priority: 2, action: { type: allow }, condition: { tabIds: [tab], resourceTypes: main, regexFilter } });
    }
    return rules;
}
