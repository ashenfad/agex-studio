/**
 * The guards every filter passes before it applies: how many rules it may
 * have, what its selectors, patterns and request filters may name, and
 * what none of them may touch (the page's root, the site's own pages).
 *
 * Each check returns a sentence saying what is wrong, for the agent to
 * act on, or null when the value passes.
 */

/** At most this many hide rules in a filter. */
export const MAX_HIDE = 200;
/** At most this many block rules in a filter. */
export const MAX_BLOCK = 100;
/** A selector, an `upward` selector included, is at most this long. */
export const MAX_SELECTOR = 1000;
/** A pattern (`hasText`, `matchesAttr.pattern`) is at most this long. */
export const MAX_PATTERN = 300;
/** An `upward` count is at most this many ancestors. */
export const MAX_UPWARD = 20;
/** A `urlFilter` is at most this long. */
export const MAX_URL_FILTER = 500;
/** A `why` is at most this long. */
export const MAX_WHY = 500;

/** The resource types a block rule may name: every one but `main_frame`,
 *  so no rule blocks a page from loading. */
export const BLOCK_TYPES = /** @type {const} */ ([
    "sub_frame", "stylesheet", "script", "image", "font", "object", "xmlhttprequest",
    "ping", "csp_report", "media", "websocket", "webtransport", "webbundle", "other",
]);

/**
 * The bare page a hide rule's selector is tried on: its root, its body,
 * the body's one wrapper (an app's mount point) and its `main`. A
 * selector that matches any of them would hide the page, or most of it,
 * on any site.
 */
const BARE_PAGE = "<div><main><div><p>text</p></div></main></div>";
const BARE_NAMES = "html > body > div > main";

/** @type {Document | null} */
let scratch = null;

/** The scratch page selectors are parsed on, made once. */
function bare() {
    if (scratch) return scratch;
    const impl = globalThis.document?.implementation;
    if (!impl) throw new Error("checking a filter needs a DOM (a page, or an offscreen document)");
    scratch = impl.createHTMLDocument("");
    scratch.body.innerHTML = BARE_PAGE;
    return scratch;
}

/** The registrable domain a filter is for, as `new URL(...).hostname`
 *  spells it (lower case, punycode), with a dot in it. @param {unknown} site @returns {site is string} */
export function isSite(site) {
    if (typeof site !== "string" || site === "" || /[^a-z0-9.-]/.test(site)) return false;
    if (site.startsWith(".") || site.endsWith(".") || !site.includes(".")) return false;
    try {
        return new URL(`https://${site}/`).hostname === site;
    } catch {
        return false;
    }
}

/**
 * Why `selector` is no selector a rule may use, or null: it must parse,
 * be bounded, and not name the extension's own marks (`data-agex-*`,
 * which a capture puts on every element and the applier on what it hides).
 *
 * @param {unknown} selector
 * @returns {string | null}
 */
export function selectorProblem(selector) {
    if (typeof selector !== "string" || selector.trim() === "") return "must be a CSS selector, a non-empty string";
    if (selector.length > MAX_SELECTOR) return `is ${selector.length} characters; at most ${MAX_SELECTOR}`;
    if (/data-agex/i.test(selector)) return "names the extension's own data-agex-* attributes, which are on every captured element; select by the page's own markup";
    try {
        bare().querySelector(selector);
    } catch (e) {
        return `not a valid CSS selector (${e instanceof Error ? e.message : String(e)})`;
    }
    return null;
}

/**
 * Why `selector` would hide the page's root, or null: on a bare page
 * (`html > body > div > main`) it matches the root, the body, the body's
 * wrapper or the `main`. Call it with a selector `selectorProblem`
 * passed.
 *
 * @param {string} selector
 * @returns {string | null}
 */
export function rootProblem(selector) {
    const page = bare();
    const roots = [page.documentElement, page.body, page.body.firstElementChild, page.querySelector("main")];
    const hit = roots.find((el) => el?.matches(selector));
    if (!hit) return null;
    return `matches <${hit.tagName.toLowerCase()}> on a bare page (${BARE_NAMES}), so it would hide the page or most of it; narrow it to the items to hide`;
}

/**
 * Why `pattern` is no pattern a rule may use, or null: a regular
 * expression's source (no slashes, no flags; `(?i:...)` for a part that
 * ignores case), bounded, that compiles, and with no quantified group
 * that is itself quantified (`(a+)+`), which can take a page's thread
 * for seconds on a long text.
 *
 * @param {unknown} pattern
 * @returns {string | null}
 */
export function patternProblem(pattern) {
    if (typeof pattern !== "string" || pattern === "") return "must be a regular expression's source, a non-empty string";
    if (pattern.length > MAX_PATTERN) return `is ${pattern.length} characters; at most ${MAX_PATTERN}`;
    try {
        new RegExp(pattern);
    } catch (e) {
        return `not a valid regular expression (${e instanceof Error ? e.message : String(e)})`;
    }
    if (nestedRepeat(pattern)) {
        return "has a repeated group that itself repeats (like (a+)+), which can stall the page; write it without the outer repeat";
    }
    return null;
}

/**
 * Whether `pattern` repeats a group that repeats inside, at any depth
 * (`(a+)+`, `((a+))*`, `(x(a*)y){2,}`): the shape that can backtrack for
 * seconds. Read conservatively: any `+`, `*` or `{` inside a group that
 * is itself followed by one counts.
 *
 * @param {string} pattern
 */
function nestedRepeat(pattern) {
    /** for each group open, whether something inside it repeats @type {boolean[]} */
    const groups = [];
    let inClass = false;
    for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i];
        if (ch === "\\") {
            i++;
            continue;
        }
        if (inClass) {
            if (ch === "]") inClass = false;
            continue;
        }
        if (ch === "[") inClass = true;
        else if (ch === "(") groups.push(false);
        else if (ch === ")") {
            const inside = groups.pop() ?? false;
            const repeated = "+*{".includes(pattern[i + 1] ?? "");
            if (inside && repeated) return true;
            if (groups.length > 0 && (inside || repeated)) groups[groups.length - 1] = true;
        } else if ("+*{".includes(ch) && groups.length > 0) groups[groups.length - 1] = true;
    }
    return false;
}

/**
 * Why `urlFilter` is no request filter a block rule may use, or null: a
 * `declarativeNetRequest` `urlFilter` (ASCII, `||` only at its start, `|`
 * only at either end), bounded, naming something (three characters or
 * more besides `|`, `*`, `^` and a scheme), and not the site's own hosts whole
 * (`||reddit.com^`), which would block the site's own requests.
 *
 * @param {unknown} urlFilter
 * @param {string} site
 * @returns {string | null}
 */
export function urlFilterProblem(urlFilter, site) {
    if (typeof urlFilter !== "string" || urlFilter === "") return "must be a declarativeNetRequest urlFilter, a non-empty string";
    if (urlFilter.length > MAX_URL_FILTER) return `is ${urlFilter.length} characters; at most ${MAX_URL_FILTER}`;
    if (!/^[\x21-\x7e]+$/.test(urlFilter)) return "must be printable ASCII with no spaces (punycode a host, percent-encode a path)";
    const body = urlFilter.startsWith("||") ? urlFilter.slice(2) : urlFilter.startsWith("|") ? urlFilter.slice(1) : urlFilter;
    const inner = body.endsWith("|") ? body.slice(0, -1) : body;
    if (inner.includes("|")) return "may have || only at its start and | only at its start or end";
    if (inner.replace(/[*^]/g, "").replace(/^(?:https?|wss?)(?::\/*)?/i, "").length < 3) return "matches nearly every request; name a host or a path";
    const own = ownHost(urlFilter);
    if (own !== null && (own === site || own.endsWith(`.${site}`))) {
        return `blocks every request to ${own}, the site's own host; add a path (||${own}/ads/)`;
    }
    return null;
}

/**
 * The host a `urlFilter` names whole, with nothing after it but
 * separators and wildcards (`||reddit.com^`, `|https://reddit.com/*`), or
 * null when it names a path or no host.
 *
 * @param {string} urlFilter
 */
function ownHost(urlFilter) {
    const m = /^(?:\|\||\|(?:https?|wss?):\/\/)([a-z0-9.-]+)([*^/|]*)$/i.exec(urlFilter);
    return m ? m[1].toLowerCase() : null;
}
