/**
 * The tab's icon, badged with the studio's status (see `status.js`): a
 * dot in its corner, colored as the session list's dots are, so a person
 * in another tab sees a turn running, one gone wrong, or one finished.
 * With nothing to say, the icon is the shipped one, its link's href put
 * back exactly.
 *
 * The badged icon is the shipped SVG, fetched once, with a circle
 * spliced in before `</svg>`, set as a data URL. Browsers that ignore
 * SVG favicons (Safari) keep the plain icon.
 */

/** @typedef {import("./status.js").Status} Status */

/** The dots' colors: app.css's --accent, --caution and --success. */
export const STATUS_COLORS = /** @type {const} */ ({
    working: "#e94560",
    attention: "#d9a441",
    unseen: "#4caf50",
});

/** The shipped icon's markup, fetched once; a failed fetch is tried
 *  again on the next badge. @type {Promise<string | null> | null} */
let baseSvg = null;
/** The icon link's href as the page shipped it. @type {string | null} */
let originalHref = null;
/** The status last set, so setting it again does nothing.
 *  @type {Status | null | undefined} */
let shown = undefined;

/** @param {string} url */
function loadBase(url) {
    baseSvg ??= fetch(url)
        .then((r) => (r.ok ? r.text() : null))
        .catch(() => null)
        .then((text) => {
            if (text === null) baseSvg = null;
            return text;
        });
    return baseSvg;
}

/** The page's icon link, made if it has none; its href as shipped is
 *  remembered the first time. */
function iconLink() {
    if (typeof document === "undefined") return null;
    let link = /** @type {HTMLLinkElement | null} */ (document.querySelector('link[rel~="icon"]'));
    if (link === null) {
        link = document.createElement("link");
        link.rel = "icon";
        document.head.appendChild(link);
    }
    originalHref ??= link.getAttribute("href") ?? "";
    return link;
}

/**
 * The shipped icon's markup with a status dot in its bottom-right
 * corner, in its 24×24 viewBox; a thin translucent white edge lifts it
 * off the glyph.
 *
 * @param {string} svg @param {Status} status
 */
export function badged(svg, status) {
    const dot = `<circle cx="17" cy="17" r="5" fill="${STATUS_COLORS[status]}" stroke="#ffffff" stroke-opacity="0.5" stroke-width="1.2"/>`;
    return svg.replace("</svg>", `${dot}</svg>`);
}

/**
 * Badge the tab's icon with `status`, or, with null, put the shipped
 * icon back. Setting the status already shown does nothing; a status
 * set while the icon is still being fetched wins over an earlier one.
 *
 * @param {Status | null} status
 */
export async function setFaviconStatus(status) {
    if (status === shown) return;
    shown = status;
    const link = iconLink();
    if (link === null) return;
    if (status === null) {
        link.setAttribute("href", originalHref || "/favicon.svg");
        return;
    }
    const svg = await loadBase(originalHref || "/favicon.svg");
    if (shown !== status) return;
    // the icon stays plain; setting this status again tries again
    if (svg === null) {
        shown = undefined;
        return;
    }
    link.setAttribute("type", "image/svg+xml");
    link.setAttribute("href", `data:image/svg+xml,${encodeURIComponent(badged(svg, status))}`);
}
