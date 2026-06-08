/**
 * Favicon status badge — a small colored dot overlaid on the tab icon to
 * mirror the session drawer's status dots, but in the browser tab where
 * it's visible after the user has tabbed away.
 *
 *   'working' → red dot   (var(--accent),  #e94560 — a turn is in flight)
 *   'unseen'  → green dot (var(--success), #4caf50 — finished, not viewed)
 *   null      → plain icon (restores the shipped /favicon.svg)
 *
 * The base art is fetched from the real `/favicon.svg` (once, cached) so
 * the badge stays in sync with the shipped icon; we just splice a couple
 * of `<circle>`s in before `</svg>` and set the `<link>` to the resulting
 * data URL. Idle restores the original href, so the un-badged tab is
 * always pixel-identical to the asset.
 *
 * SVG data-URL favicons work in Chrome/Firefox/Edge. Safari ignores them
 * and keeps the default icon — acceptable degradation (no badge, no
 * breakage).
 */

/** Dot colors — kept in sync with --accent / --success in app.css. */
const STATUS_COLORS = {
    working: "#e94560",
    unseen: "#4caf50",
};

/** @type {Promise<string | null> | null} */
let _baseSvgPromise = null;
/** @type {string | null} */
let _originalHref = null;
/** Last status written, to skip redundant DOM/data-URL work. */
let _current = "__init__";

function _loadBaseSvg() {
    if (!_baseSvgPromise) {
        _baseSvgPromise = fetch("/favicon.svg")
            .then((r) => (r.ok ? r.text() : null))
            .catch(() => null);
    }
    return _baseSvgPromise;
}

/** @param {HTMLLinkElement | null} */
function _ensureLink() {
    if (typeof document === "undefined") return null;
    let link = /** @type {HTMLLinkElement | null} */ (
        document.querySelector('link[rel~="icon"]')
    );
    if (!link) {
        link = document.createElement("link");
        link.rel = "icon";
        document.head.appendChild(link);
    }
    if (_originalHref === null) _originalHref = link.getAttribute("href") || "";
    return link;
}

/** Bottom-right badge: the status-colored dot with a thin, translucent
 *  white outline — just enough to lift it off the glyph without a heavy
 *  halo. Coordinates are in the icon's 24×24 viewBox. */
function _dotMarkup(status) {
    const color = STATUS_COLORS[status];
    return (
        `<circle cx="17" cy="17" r="5" fill="${color}" ` +
        `stroke="#ffffff" stroke-opacity="0.5" stroke-width="1.2"/>`
    );
}

/**
 * Set (or clear) the favicon status badge. Idempotent — repeated calls
 * with the same status are no-ops. Safe to call before the base SVG has
 * loaded (it awaits internally) and races are guarded.
 *
 * @param {'working' | 'unseen' | null} status
 */
export async function setFaviconStatus(status) {
    const next = status || null;
    if (next === _current) return;
    _current = next;
    const link = _ensureLink();
    if (!link) return;
    if (!next) {
        // Idle — restore the shipped icon exactly.
        link.setAttribute("href", _originalHref || "/favicon.svg");
        return;
    }
    const base = await _loadBaseSvg();
    // Bail if the fetch failed, or the status changed while we awaited.
    if (!base || _current !== next) return;
    const badged = base.replace("</svg>", `${_dotMarkup(next)}</svg>`);
    link.setAttribute("type", "image/svg+xml");
    link.setAttribute("href", `data:image/svg+xml,${encodeURIComponent(badged)}`);
}
