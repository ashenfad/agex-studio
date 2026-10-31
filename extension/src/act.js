/**
 * Acting in a session's tab, by the refs of an outline: `click`, `type`,
 * `select` and `press`.
 *
 * - **An action names the outline it was read from** (`version`), and is
 *   refused when that isn't the page's latest, or when the page has gone
 *   on to another document, or when the element at its ref has left the
 *   page (re-rendered), or a click's or a key's element reads otherwise
 *   now (a calendar that reuses its day cells, "24" now "23"): "the page
 *   changed since you read it". A ref names an element, not a place, so
 *   an element that has only moved is still the one the agent read.
 * - **Input is trusted:** a click is the debugger's mouse events at the
 *   element's center, typing its `Input.insertText`, a key its key
 *   events, so a site sees what a person's hand would do. A click goes
 *   where the element shows: its center, or another point in it when its
 *   center is covered. An element covered all over (a cookie banner) is
 *   refused, naming what covers it, unless what covers it is its own
 *   row's content: an element that fills its parent, drawn under the
 *   rest of its parent (a result row's link), takes a click on that
 *   content, where no other control is.
 * - **Steps that commit are refused unless confirmed:** a click on a
 *   control (or Enter or Space on it), or a form submit whose submitting
 *   control, reads as committing (book, reserve, pay, ...); a choice
 *   among options (a tab, a radio, a box to tick) doesn't commit. The agent
 *   asks the person, and calls again with `confirmed: true`. It is a
 *   guard rail: a control labelled otherwise ("Continue", an icon,
 *   another language) gets past.
 */

import { ProtocolError } from "./protocol.js";
import { change } from "./registry.js";
import { settled } from "./pages.js";
import { ownTab, unmarked } from "./tabs.js";
import { inWorld, send, work } from "./work.js";

/** How long an action waits for the page to settle after it. */
const AFTER_MS = 10_000;

/** The keys `press` takes, as the debugger's key events name them. */
const KEYS = /** @type {Record<string, { key: string, code: string, windowsVirtualKeyCode: number, nativeVirtualKeyCode: number, text?: string }>} */ (
    Object.fromEntries(
        /** @type {[string, string, number, string?][]} */ ([
            ["Enter", "Enter", 13, "\r"],
            ["Space", " ", 32, " "],
            ["Escape", "Escape", 27],
            ["Tab", "Tab", 9],
            ["ArrowDown", "ArrowDown", 40],
            ["ArrowUp", "ArrowUp", 38],
            ["ArrowLeft", "ArrowLeft", 37],
            ["ArrowRight", "ArrowRight", 39],
            ["Home", "Home", 36],
            ["End", "End", 35],
            ["PageDown", "PageDown", 34],
            ["PageUp", "PageUp", 33],
        ]).map(([name, key, vk, text]) => [name, { key, code: name, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, ...(text && { text }) }]),
    )
);

/** @type {Record<string, import("./port.js").Op>} */
export const actOps = {
    /** A click on the element at `ref`, where it shows. */
    async click(req) {
        const { tab, latest } = await ownTab(req);
        const { version, ref } = target(req, latest);
        await work(tab);
        const aim = await inWorld(tab, aimAt, [version, ref, "click"]);
        refuse(aim, req);
        const { x, y } = /** @type {{ x: number, y: number }} */ (aim);
        const started = await before(tab);
        await send(tab, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
        await send(tab, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
        await send(tab, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
        return after(tab, started, aim);
    },

    /** `text` typed into the field at `ref`, in place of what it held
     *  (`clear: false` adds to it), then Enter pressed if `submit`. */
    async type(req) {
        const { tab, latest } = await ownTab(req);
        const { version, ref } = target(req, latest);
        const { text, submit = false, clear = true } = req;
        if (typeof text !== "string") throw bad("text: what to type");
        if (typeof submit !== "boolean" || typeof clear !== "boolean") throw bad("submit, clear: true or false");
        await work(tab);
        const aim = await inWorld(tab, aimAt, [version, ref, submit ? "submit" : "type"]);
        refuse(aim, req);
        const started = await before(tab);
        const { toEnd, picker } = await inWorld(tab, focusField, [ref, clear]);
        if (picker) {
            // a date, time or color field takes no typing: its value is set, as its picker would
            const set = await inWorld(tab, setPicked, [ref, text]);
            if (set.error) throw new ProtocolError("failed", set.error);
        } else {
            if (toEnd) await press(tab, { key: "End", code: "End", windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35 });
            if (text) await send(tab, "Input.insertText", { text });
            else if (clear) await press(tab, { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
        }
        if (submit) await press(tab, { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r" });
        return after(tab, started, aim);
    },

    /** `key` pressed with the element at `ref` focused: Enter or Space on
     *  a control a click doesn't reach, Escape, Tab, the arrows. */
    async press(req) {
        const { tab, latest } = await ownTab(req);
        const { version, ref } = target(req, latest);
        const key = typeof req.key === "string" && Object.hasOwn(KEYS, req.key) ? KEYS[req.key] : undefined;
        if (key === undefined) throw bad(`key: one of ${Object.keys(KEYS).join(", ")}`);
        await work(tab);
        const aim = await inWorld(tab, aimAt, [version, ref, "press", /** @type {string} */ (req.key)]);
        refuse(aim, req);
        const started = await before(tab);
        const focused = await inWorld(tab, focusOn, [ref]);
        if (focused.error) throw new ProtocolError("failed", focused.error);
        await press(tab, key);
        return after(tab, started, aim);
    },

    /** The option of the select at `ref` whose text or value is `value`
     *  chosen. A native select's list isn't in the page to click, so this
     *  sets it as the page's own script would; a custom one (a listbox of
     *  options) is clicked instead. */
    async select(req) {
        const { tab, latest } = await ownTab(req);
        const { version, ref } = target(req, latest);
        const { value } = req;
        if (typeof value !== "string") throw bad("value: an option's text or value");
        await work(tab);
        const aim = await inWorld(tab, aimAt, [version, ref, "select"]);
        refuse(aim, req);
        const started = await before(tab);
        const chosen = await inWorld(tab, chooseOption, [ref, value]);
        if (chosen.error) throw new ProtocolError("failed", chosen.error);
        return { ...(await after(tab, started, aim)), chosen: chosen.text };
    },
};

/** A key pressed and let go, through the debugger.
 *  @param {number} tab @param {{ key: string, code: string, windowsVirtualKeyCode: number, nativeVirtualKeyCode: number, text?: string }} key */
async function press(tab, { text, ...key }) {
    await send(tab, "Input.dispatchKeyEvent", { type: "keyDown", ...key, ...(text && { text }) });
    await send(tab, "Input.dispatchKeyEvent", { type: "keyUp", ...key });
}

/**
 * An action's outline and ref, checked: the outline must be the tab's
 * latest (`latest`, which a read or a handoff to the person moves on).
 *
 * @param {import("./protocol.js").Request} req @param {number} latest
 */
function target(req, latest) {
    const { version, ref } = req;
    if (!Number.isInteger(version)) throw bad("version: the outline's, from read");
    if (!Number.isInteger(ref) || /** @type {number} */ (ref) < 1) throw bad("ref: a ref from that outline");
    if (version !== latest) throw new ProtocolError("stale", `the page changed since you read it (outline ${version} isn't its latest, ${latest}); read it again`);
    return { version: /** @type {number} */ (version), ref: /** @type {number} */ (ref) };
}

/**
 * The refusal an aim carries, thrown: a stale outline, an element
 * covered or disabled, or a step that commits without `confirmed`.
 *
 * @param {Aim} aim @param {import("./protocol.js").Request} req
 */
function refuse(aim, req) {
    if (aim.stale) throw new ProtocolError("stale", `the page changed since you read it (${aim.stale}); read it again`);
    if (aim.error) throw new ProtocolError("failed", aim.error);
    if (aim.commits && req.confirmed !== true) {
        throw new ProtocolError(
            "confirm",
            // what to do about it is the caller's to say: a person to ask, or code to stop
            `${aim.desc} reads as a step that commits (${JSON.stringify(aim.commits)})`,
        );
    }
}

/** The tab's URL before an action, and when it began. @param {number} tab */
async function before(tab) {
    return { url: (await chrome.tabs.get(tab)).url ?? "", at: Date.now() };
}

/**
 * What an action led to: the page settled, the URL it is at, and
 * whether it went on to another (and any load the extension stopped).
 *
 * @param {number} tab @param {{ url: string, at: number }} started @param {Aim} aim
 */
async function after(tab, started, aim) {
    await new Promise((ok) => setTimeout(ok, 300)); // a navigation the step began shows as loading by now
    const loaded = await settled(tab, AFTER_MS);
    const now = await chrome.tabs.get(tab);
    const blocked = await change((state) => state.tabs[tab]?.blocked);
    return {
        url: now.url ?? "",
        title: unmarked(now.title ?? ""),
        ...(now.url !== started.url && { navigated: true }),
        ...(aim.submits && { submitted: true }),
        ...(!loaded && { loading: true }),
        ...(blocked && blocked.at >= started.at && { blocked }),
    };
}

/**
 * @typedef {{
 *   stale?: string, error?: string,
 *   x?: number, y?: number,
 *   desc?: string, commits?: string | null, submits?: boolean,
 * }} Aim
 */

/**
 * The element at `ref` of outline `version`, checked and brought into
 * view: where to click it, and whether acting on it commits. Runs in the
 * page, in the extension's isolated world, as the outline does.
 *
 * @param {number} version @param {number} ref
 * @param {"click" | "type" | "submit" | "select" | "press"} how
 * @param {string} [key] the key, for `press`
 * @returns {Aim}
 */
export function aimAt(version, ref, how, key) {
    const COMMITS = /\b(book|reserve|pay|purchase|buy|checkout|check out|place order|order now|send|post|publish|delete|confirm)\b/i;
    const kept = /** @type {{ version: number, refs: Element[], names: string[], label: (e: Element) => string } | undefined} */ (/** @type {any} */ (globalThis).__agex);
    if (kept === undefined) return { stale: "it is another page now" };
    if (kept.version !== version) return { stale: `outline ${version} isn't its latest, ${kept.version}` };
    let el = kept.refs[ref - 1];
    if (el === undefined) return { error: `outline ${version} has no ref ${ref}` };
    if (!el.isConnected) return { stale: `ref ${ref} has left the page` };
    const isField = (/** @type {Element} */ e) => e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement || /** @type {HTMLElement} */ (e).isContentEditable;
    // a box drawn around its one field (a combobox's): typing goes to that field, under this ref from now on
    if ((how === "type" || how === "submit") && !isField(el)) {
        const inner = [...el.querySelectorAll("input:not([type=hidden]), textarea, [contenteditable=''], [contenteditable=true]")].filter((f) => f.checkVisibility());
        if (inner.length === 1) {
            el = inner[0];
            kept.refs[ref - 1] = el;
        }
    }
    // what a field holds isn't its name, but a contenteditable's text is: typing changes it
    if ((how === "click" || how === "press") && !(/** @type {HTMLElement} */ (el).isContentEditable)) {
        const now = kept.label(el);
        if (now !== kept.names[ref - 1]) return { stale: `ref ${ref} reads ${JSON.stringify(now)} now, not ${JSON.stringify(kept.names[ref - 1])}` };
    }
    /** @param {Element} e */
    const text = (e) => {
        const f = /** @type {HTMLInputElement} */ (e);
        const labels = f.labels && f.labels.length > 0
            ? [...f.labels].map((l) => {
                const copy = /** @type {Element} */ (l.cloneNode(true));
                for (const c of copy.querySelectorAll("input, select, textarea, button")) c.remove();
                return copy.textContent;
            }).join(" ")
            : "";
        const button = e instanceof HTMLInputElement && ["submit", "button", "reset"].includes(e.type) ? e.value : "";
        const inner = e instanceof HTMLElement && !(e instanceof HTMLSelectElement) ? e.innerText : "";
        return (e.getAttribute("aria-label") || labels || button || inner || f.placeholder || e.getAttribute("title") || f.name || "")
            .replace(/\s+/g, " ").trim().slice(0, 80);
    };
    // a ref's name as the outline gave it (an icon's alt, aria-labelledby),
    // and its text now
    const named = (/** @type {Element} */ e) => {
        const i = kept.refs.indexOf(e);
        return [i >= 0 ? kept.names[i] : "", text(e)].filter(Boolean).join(" / ");
    };
    const desc = `[${ref}] ${el.tagName.toLowerCase()} ${JSON.stringify(kept.names[ref - 1] || text(el))}`;
    if (/** @type {HTMLButtonElement} */ (el).disabled || el.getAttribute("aria-disabled") === "true") return { error: `${desc} is disabled` };
    if (!el.checkVisibility()) return { error: `${desc} isn't shown` };
    const fields = how === "type" || how === "submit";
    if (fields && !isField(el)) {
        return { error: `${desc} isn't a field to type into: if it opens one when clicked, click it, read again, and type into the new field's ref` };
    }
    // a person can't change it either: a site's own picker sets it, so click that
    if (fields && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.readOnly) {
        return { error: `${desc} is read-only: click it, or the control beside it, to open the site's own picker` };
    }
    if (how === "select" && !(el instanceof HTMLSelectElement)) return { error: `${desc} isn't a select (click a custom one's options)` };

    // what a click or an Enter submits, and whether it reads as committing
    const form = /** @type {HTMLInputElement} */ (el).form ?? el.closest("form");
    const isSubmit = (/** @type {Element} */ e) =>
        (e instanceof HTMLButtonElement && e.type === "submit") || (e instanceof HTMLInputElement && (e.type === "submit" || e.type === "image"));
    // Enter in a field that takes a line submits its form, as typing with submit does;
    // Enter or Space on a control does what a click on it would
    const entersField = how === "press" && key === "Enter" && el instanceof HTMLInputElement && !isSubmit(el) && !["checkbox", "radio", "button", "reset"].includes(el.type);
    const activates = how === "click" || (how === "press" && (key === "Enter" || key === "Space") && !entersField);
    let submits = false;
    let says = named(el);
    let step = how === "press" ? `${key} on ${desc}` : desc;
    if (activates && form && isSubmit(el)) submits = true;
    if ((how === "submit" || entersField) && form) {
        submits = true;
        const submitter = [...form.elements].find(isSubmit);
        says = submitter ? named(submitter) : "";
        if (submitter) step = `Enter in ${desc}, submitting its form by ${JSON.stringify(text(submitter) || says)},`;
    }
    // picking one of several (a tab, a radio, an option) never commits, whatever it's
    // named ("Book hotel" beside "Book flight + hotel"): a step after it does. A toggle
    // (a box to tick, a switch) may save as it's flipped, so it's asked like a button
    const chooses = ["tab", "radio", "option"].includes(el.getAttribute("role") ?? "") ||
        (el instanceof HTMLInputElement && el.type === "radio");
    const commits = (activates && !chooses) || submits ? (COMMITS.exec(says)?.[0] ?? null) : null;

    el.scrollIntoView({ block: "center", inline: "center" });
    const box = el.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    if (how === "click") {
        // a click lands on whatever is on top there: the center, or else another point the element shows at
        /** @param {Element | null} hit */
        const ours = (hit) => {
            const label = hit?.closest("label");
            return hit !== null && (hit === el || el.contains(hit) || hit.contains(el) || (label !== null && label?.control === el));
        };
        // whether `hit`, on top of the element where it would be clicked, is its own row's content:
        // inside the parent the element fills (a result row whose link is drawn under the row's
        // text), and no other control
        const CONTROLS = "a[href], button, input, select, textarea, summary, [contenteditable=''], [contenteditable=true], " +
            "[role=button], [role=link], [role=option], [role=tab], [role=checkbox], [role=radio], [role=switch], [role=menuitem], [role=combobox]";
        const rowContent = (/** @type {Element} */ hit) => {
            const row = el.parentElement;
            if (row === null || row === document.body || row === document.documentElement || !row.contains(hit)) return false;
            const area = (/** @type {DOMRect} */ b) => b.width * b.height;
            const rowBox = row.getBoundingClientRect();
            if (area(rowBox) === 0 || area(el.getBoundingClientRect()) < 0.9 * area(rowBox)) return false;
            const other = hit.closest(CONTROLS);
            return other === null || other === el || !row.contains(other);
        };
        const points = [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75], [0.1, 0.5], [0.9, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]
            .map(([fx, fy]) => ({ x: box.left + box.width * fx, y: box.top + box.height * fy }))
            .filter((p) => p.x >= 0 && p.y >= 0 && p.x < innerWidth && p.y < innerHeight);
        const shown = points.find((p) => ours(document.elementFromPoint(p.x, p.y)));
        if (shown) return { ...shown, desc: step, commits, submits };
        const hit = document.elementFromPoint(x, y);
        if (!(hit !== null && rowContent(hit))) {
            return { error: `${desc} is covered by ${hit ? `${hit.tagName.toLowerCase()} ${JSON.stringify(text(hit))}` : "nothing the page shows"}` };
        }
    }
    return { x, y, desc: step, commits, submits };
}

/**
 * The element at `ref` focused, for a key pressed in it, or what's wrong
 * when it can't be: the focus on it, not on a control inside it, which
 * the step's checks weren't of. Runs in the page.
 *
 * @param {number} ref
 * @returns {{ error?: string }}
 */
export function focusOn(ref) {
    const el = /** @type {HTMLElement} */ (/** @type {any} */ (globalThis).__agex.refs[ref - 1]);
    el.focus();
    // a shadow host that hands its focus inward is the document's active element still
    if (document.activeElement !== el) return { error: `[${ref}] ${el.tagName.toLowerCase()} can't take the keyboard's focus: click it` };
    return {};
}

/**
 * The field at `ref` focused, and what it holds selected when `clear`,
 * so what is typed next replaces it, or the cursor put at its end; or
 * `toEnd` when the field can't be given one (a number field), for End;
 * or `picker` for a field that takes no typing at all (a date, a time, a
 * color, a range), whose value is set instead (`setPicked`). Runs in the
 * page.
 *
 * @param {number} ref @param {boolean} clear
 * @returns {{ toEnd: boolean, picker?: boolean }}
 */
export function focusField(ref, clear) {
    const el = /** @type {HTMLElement} */ (/** @type {any} */ (globalThis).__agex.refs[ref - 1]);
    el.focus();
    if (el instanceof HTMLInputElement && ["date", "datetime-local", "month", "week", "time", "color", "range"].includes(el.type)) {
        return { toEnd: false, picker: true };
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        if (clear) el.select();
        else {
            try {
                el.setSelectionRange(el.value.length, el.value.length);
            } catch {
                return { toEnd: true }; // a number field has no selection to set: End moves its cursor
            }
        }
    } else {
        const range = document.createRange();
        range.selectNodeContents(el);
        if (!clear) range.collapse(false);
        const sel = getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
    }
    return { toEnd: false };
}

/**
 * The value of a field that takes no typing (a date, a time, a color, a
 * range) set to `text`, with the events a person's choice fires, or what
 * it takes when it refuses that value. Runs in the page.
 *
 * @param {number} ref @param {string} text
 * @returns {{ error?: string }}
 */
export function setPicked(ref, text) {
    const el = /** @type {HTMLInputElement} */ (/** @type {any} */ (globalThis).__agex.refs[ref - 1]);
    const FORMS = /** @type {Record<string, string>} */ ({
        date: "2026-12-03",
        "datetime-local": "2026-12-03T14:30",
        month: "2026-12",
        week: "2026-W49",
        time: "14:30",
        color: "#ff8800",
        range: `a number from ${el.min || 0} to ${el.max || 100}`,
    });
    // tried on a field of its own first: a field sanitizes what it doesn't take (to empty, to
    // black, to its midpoint), and the page's field keeps its value when this one is refused
    const probe = document.createElement("input");
    probe.type = el.type;
    for (const a of ["min", "max", "step"]) if (el.hasAttribute(a)) probe.setAttribute(a, /** @type {string} */ (el.getAttribute(a)));
    probe.value = text;
    const wanted = el.type === "color" ? text.toLowerCase() : text;
    if (text !== "" && probe.value !== wanted) {
        return { error: `a ${el.type} field takes a value like ${FORMS[el.type]}, not ${JSON.stringify(text)}` };
    }
    // the element's own setter: a page that wraps the value's setter still hears of it
    const setter = /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")).set;
    setter?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return {};
}

/**
 * The option of the select at `ref` with `value` as its text or value,
 * chosen, with the events a choice fires. Runs in the page.
 *
 * @param {number} ref @param {string} value
 * @returns {{ text?: string, error?: string }}
 */
export function chooseOption(ref, value) {
    const el = /** @type {HTMLSelectElement} */ (/** @type {any} */ (globalThis).__agex.refs[ref - 1]);
    const squash = (/** @type {string} */ s) => s.replace(/\s+/g, " ").trim();
    const option = [...el.options].find((o) => squash(o.text) === squash(value)) ?? [...el.options].find((o) => o.value === value);
    if (option === undefined) return { error: `no option ${JSON.stringify(value)}; its options: ${[...el.options].map((o) => squash(o.text)).join(" | ")}` };
    // as the person couldn't choose it: a placeholder, or one sold out
    const group = option.parentElement;
    if (option.disabled || (group instanceof HTMLOptGroupElement && group.disabled)) return { error: `option ${JSON.stringify(squash(option.text))} is disabled` };
    el.value = option.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { text: squash(option.text) };
}

/** @param {string} message */
function bad(message) {
    return new ProtocolError("bad-request", message);
}
