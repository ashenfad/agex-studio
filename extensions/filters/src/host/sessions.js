/**
 * A session per site. A site is a registrable domain (`reddit.com`, which
 * covers `old.reddit.com`), and its session's name spells it with its
 * dots as underscores (`site-reddit_com`): a dotted name would read as a
 * delegate's, and no hostname holds an underscore, so the name maps back
 * to exactly one domain.
 */

const PREFIX = "site-";
/** A domain as a site may be: lowercase labels of letters, digits and
 *  hyphens, at least two. */
const DOMAIN = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

/** The session for site `domain`. @param {string} domain */
export function sessionOf(domain) {
    if (!DOMAIN.test(domain)) throw new Error(`not a site's domain: ${JSON.stringify(domain)}`);
    return PREFIX + domain.replaceAll(".", "_");
}

/** The site a session is for, or null for a session that isn't a site's.
 *  @param {string} session */
export function siteOf(session) {
    if (!session.startsWith(PREFIX)) return null;
    const domain = session.slice(PREFIX.length).replaceAll("_", ".");
    return DOMAIN.test(domain) ? domain : null;
}
