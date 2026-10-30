/**
 * A page as the agent reads it: its text, line by line, with a numbered
 * ref on each thing that can be clicked or typed into
 * (`[12] button "Check availability"`).
 *
 * `outlinePage` runs in the page, in the extension's isolated world (it
 * sees the page's DOM, not its scripts' globals), so it is
 * self-contained: it is sent as its source text. It keeps the elements
 * its refs name in that world, and their names, under the outline's
 * version, for the actions that follow; a new document starts a new
 * world, without them.
 */

/**
 * @typedef {{
 *   version: number,
 *   url: string,
 *   title: string,
 *   blocker: "captcha" | "bot-check" | null,
 *   refs: { ref: number, kind: string, name: string }[],
 *   text: string,
 *   cut?: number,
 *   below?: number,
 * }} Outline
 *   `blocker`: the page is a CAPTCHA or a bot check, not the site.
 *   `refs`: each ref's kind and name, as its line in the text starts
 *   (`button`, `"Reserve"`), for code to find a ref by.
 *   `cut`: the text's full length, when it was cut to `maxChars`.
 *   `below`: how far the page goes on below what shows, in screenfuls,
 *   when it does: a list there may load more as it is scrolled.
 */

/**
 * @param {number} version this read's number, which an action must name
 * @param {{ maxChars?: number, hrefs?: boolean }} [opts]
 * @returns {Outline}
 */
export function outlinePage(version, { maxChars = 40_000, hrefs = false } = {}) {
    // challenge frames, as their sources name them
    const CHALLENGE = /recaptcha|hcaptcha|challenges\.cloudflare\.com|turnstile|captcha-delivery|px-captcha|perimeterx|arkoselabs|funcaptcha/i;
    const CHECK_TEXT = /just a moment|access denied|attention required|pardon our interruption|are you a (human|robot)|verify (that )?you are (a )?human|request unsuccessful|press (&|and) hold/i;
    // photo carousels: their controls are many and say little
    const CAROUSEL = /carousel|swiper|slick|splide|glide/i;
    const INTERACTIVE = [
        "a[href]", "button", "input:not([type=hidden])", "select", "textarea", "summary",
        "[role=button]", "[role=link]", "[role=option]", "[role=tab]", "[role=checkbox]", "[role=radio]",
        "[role=switch]", "[role=menuitem]", "[role=combobox]", "[contenteditable=''], [contenteditable=true]",
    ].join(", ");
    const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "IFRAME", "OBJECT", "EMBED", "CANVAS", "VIDEO", "AUDIO"]);
    const squash = (/** @type {string} */ s) => s.replace(/\s+/g, " ").trim();
    const cap = (/** @type {string} */ s, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

    /** @type {Element[]} */
    const refs = [];
    /** each ref's name, as the outline gives it: what an action checks
     *  for a step that commits @type {string[]} */
    const names = [];
    /** @type {string[]} */
    const lines = [];
    let line = "";
    // refs alike in a row (a row of "Save to list"): the first, and a count
    let run = { desc: "", more: 0 };
    const endRun = () => {
        if (run.more > 0) line += ` (and ${run.more} more like it) `;
        run = { desc: "", more: 0 };
    };
    const flush = () => {
        endRun();
        const t = squash(line);
        if (t) lines.push(t);
        line = "";
    };

    /** @param {Element} l */
    const labelText = (l) => {
        const copy = /** @type {Element} */ (l.cloneNode(true));
        for (const c of copy.querySelectorAll("input, select, textarea, button")) c.remove();
        return copy.textContent ?? "";
    };

    /** @param {Element} el */
    const label = (el) => {
        const h = /** @type {HTMLInputElement} */ (el);
        const by = el.getAttribute("aria-labelledby");
        const labelled = by ? by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ") : "";
        // a label's text, less the controls inside it (a select's options)
        const own = h.labels && h.labels.length > 0 ? [...h.labels].map(labelText).join(" ") : "";
        const img = el.querySelector("img[alt]")?.getAttribute("alt") ?? "";
        const text = el instanceof HTMLElement && !(el instanceof HTMLSelectElement) ? el.innerText : "";
        const isButton = el instanceof HTMLInputElement && ["submit", "button", "reset"].includes(el.type);
        return cap(squash(
            el.getAttribute("aria-label") || labelled || own || text || (isButton ? h.value : "") ||
            h.placeholder || el.getAttribute("title") || img || h.name || "",
        ));
    };

    /** what a ref is, as its line starts: a button, a link, a textbox, ... @param {Element} el */
    const kindOf = (el) => {
        const role = el.getAttribute("role");
        if (el instanceof HTMLSelectElement) return "select";
        if (el instanceof HTMLInputElement) {
            if (el.type === "checkbox" || el.type === "radio") return el.type;
            if (["submit", "button", "reset", "image"].includes(el.type)) return "button";
            return el.type === "text" ? "textbox" : `${el.type} field`;
        }
        if (el instanceof HTMLTextAreaElement) return "textbox";
        if (el instanceof HTMLAnchorElement && !role) return "link";
        return role ?? (el.tagName === "SUMMARY" ? "button" : el.tagName.toLowerCase());
    };

    /** @param {Element} el */
    const describe = (el) => {
        const kind = kindOf(el);
        const name = JSON.stringify(label(el));
        const disabled = /** @type {HTMLButtonElement} */ (el).disabled || el.getAttribute("aria-disabled") === "true" ? " (disabled)" : "";
        if (el instanceof HTMLSelectElement) {
            const options = [...el.options].map((o) => squash(o.text));
            const shownOptions = options.length > 20 ? [...options.slice(0, 20), `… ${options.length - 20} more`] : options;
            return `select ${name} = ${JSON.stringify(squash(el.selectedOptions[0]?.text ?? ""))} (options: ${shownOptions.join(" | ")})${disabled}`;
        }
        if (el instanceof HTMLInputElement) {
            if (el.type === "checkbox" || el.type === "radio") return `${kind} ${name}${el.checked ? " (checked)" : ""}${disabled}`;
            if (kind === "button") return `${kind} ${name}${disabled}`;
            const value = el.type === "password" ? (el.value ? " = (filled)" : "") : el.value ? ` = ${JSON.stringify(cap(el.value, 40))}` : "";
            return `${kind} ${name}${value}${disabled}`;
        }
        if (el instanceof HTMLTextAreaElement) return `${kind} ${name}${el.value ? ` = ${JSON.stringify(cap(el.value, 40))}` : ""}${disabled}`;
        if (el instanceof HTMLAnchorElement && kind === "link") return `${kind} ${name}${hrefs ? ` → ${el.href}` : ""}`;
        const checked = el.getAttribute("aria-checked") === "true" || el.getAttribute("aria-selected") === "true" ? " (checked)" : "";
        return `${kind} ${name}${checked}${disabled}`;
    };

    /** @param {Element} el */
    const display = (el) => getComputedStyle(el).display;

    /** @param {Node} node @param {boolean} quiet inside a carousel: its text, none of its controls */
    const walk = (node, quiet) => {
        if (node.nodeType === Node.TEXT_NODE) {
            const t = node.textContent ?? "";
            if (/\S/.test(t)) endRun();
            line += t;
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const el = /** @type {Element} */ (node);
        if (SKIP.has(el.tagName.toUpperCase())) return;
        const shown = display(el);
        if (shown === "contents") {
            for (const c of el.childNodes) walk(c, quiet);
            return;
        }
        if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return;
        if (el.tagName.toUpperCase() === "SVG" && !el.matches(INTERACTIVE)) return;
        const block = !shown.startsWith("inline");
        if (block) flush();
        const carousel = quiet || CAROUSEL.test(el.getAttribute("aria-roledescription") ?? "") ||
            CAROUSEL.test(typeof el.className === "string" ? el.className : "");
        const children = el.shadowRoot
            ? el.shadowRoot.childNodes
            : el instanceof HTMLSlotElement ? el.assignedNodes({ flatten: true }) : el.childNodes;
        if (el.matches(INTERACTIVE)) {
            if (carousel) return; // a carousel's controls: next, previous, a dot per photo
            refs.push(el);
            names.push(label(el));
            const field = el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement;
            if (!field && el instanceof HTMLElement && el.innerText.length > 80) {
                // a card that is one link or button: its ref, then its text
                endRun();
                line += ` [${refs.length}] ${kindOf(el)}${hrefs && el instanceof HTMLAnchorElement ? ` → ${el.href}` : ""}: `;
                for (const c of children) walk(c, quiet);
            } else {
                const desc = describe(el);
                if (desc === run.desc) {
                    run.more++;
                } else {
                    endRun();
                    line += ` [${refs.length}] ${desc} `;
                    run.desc = desc;
                }
            }
            if (block) flush();
            return;
        }
        const heading = /^H([1-6])$/.exec(el.tagName.toUpperCase());
        if (heading) {
            // walked, not copied: a result's heading is often its link
            line = `${"#".repeat(Number(heading[1]))} `;
            for (const c of children) walk(c, carousel);
            flush();
            return;
        }
        if (el.tagName.toUpperCase() === "LI") line = "- ";
        for (const c of children) walk(c, carousel);
        if (block) flush();
    };
    if (document.body) walk(document.body, false);
    flush();

    // a run of lines alike but for their refs (a row of photo buttons) is
    // one line, and a count
    /** @type {string[]} */
    const out = [];
    let alike = 0;
    const bare = (/** @type {string} */ s) => s.replace(/\[\d+\]/g, "[]");
    for (const l of lines) {
        if (out.length > 0 && bare(out[out.length - 1]) === bare(l)) {
            alike++;
            continue;
        }
        if (alike > 0) out[out.length - 1] += ` (and ${alike} more like it)`;
        alike = 0;
        out.push(l);
    }
    if (alike > 0) out[out.length - 1] += ` (and ${alike} more like it)`;

    let blocker = /** @type {Outline["blocker"]} */ (null);
    for (const f of document.querySelectorAll("iframe")) {
        if (CHALLENGE.test(f.src) && f.checkVisibility()) blocker = "captcha";
    }
    if (blocker === null && (CHECK_TEXT.test(document.title) || CHECK_TEXT.test(document.body?.innerText.slice(0, 500) ?? ""))) {
        blocker = "bot-check";
    }

    const full = out.join("\n");
    const scroller = document.scrollingElement ?? document.documentElement;
    const below = Math.round(((scroller.scrollHeight - scroller.scrollTop - innerHeight) / Math.max(innerHeight, 1)) * 10) / 10;
    /** @type {typeof globalThis & { __agex?: unknown }} */ (globalThis).__agex = { version, refs, names };
    return {
        version,
        url: location.href,
        title: document.title,
        blocker,
        refs: refs.map((el, i) => ({ ref: i + 1, kind: kindOf(el), name: names[i] })),
        text: full.length > maxChars ? full.slice(0, maxChars) : full,
        ...(full.length > maxChars && { cut: full.length }),
        ...(below >= 0.5 && { below }),
    };
}

/**
 * Whether the page shows `text`, or has an element matching `selector`.
 * Runs in the page, as `outlinePage` does.
 *
 * @param {{ text?: string, selector?: string }} what
 */
export function pageHas({ text, selector }) {
    if (selector !== undefined) return document.querySelector(selector) !== null;
    return (document.body?.innerText ?? "").includes(text ?? "");
}
