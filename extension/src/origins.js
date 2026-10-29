/**
 * Which pages may open the port: the manifest's
 * `externally_connectable.matches`, read as origins. Chrome already
 * refuses a page they don't match; the service worker checks the
 * sender's origin again, so a manifest widened by mistake doesn't widen
 * what the extension answers.
 */

/**
 * The origins a list of match patterns allows. A pattern's host matches
 * on any port (as Chrome's match patterns do), so `http://localhost/*`
 * allows every local dev server. A wildcard host isn't read: the
 * extension names each origin it answers.
 *
 * @param {readonly string[]} patterns like `https://agex.studio/*`
 * @returns {(origin: string | undefined) => boolean}
 */
export function originMatcher(patterns) {
    const allowed = patterns.map((p) => {
        const m = /^(https?):\/\/([^/:*]+)\/\*$/.exec(p);
        if (m === null) throw new Error(`origins: "${p}" isn't scheme://host/*`);
        return { scheme: `${m[1]}:`, host: m[2] };
    });
    return (origin) => {
        if (origin === undefined) return false;
        let url;
        try {
            url = new URL(origin);
        } catch {
            return false;
        }
        return allowed.some((a) => a.scheme === url.protocol && a.host === url.hostname);
    };
}
