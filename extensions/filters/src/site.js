/**
 * The site a page belongs to: its registrable domain, by the Public
 * Suffix List (`tldts`), so `old.reddit.com` is `reddit.com` and
 * `news.bbc.co.uk` is `bbc.co.uk`. A domain the list's private part
 * names (`foo.github.io`) is a site of its own: its owner isn't the
 * platform's.
 */

import { getDomain } from "tldts";

/**
 * The site of a page at `host`, or null for a host that isn't a site's
 * (an IP address, `localhost`, a browser page).
 *
 * @param {string} host
 * @returns {string | null}
 */
export function siteOfHost(host) {
    return getDomain(host, { allowPrivateDomains: true }) ?? null;
}
