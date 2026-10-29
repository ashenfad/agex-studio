/**
 * Acting in a session's tab, by the refs of an outline: `click`, `type`
 * and `select`.
 *
 * - **An action names the outline it was read from** (`version`), and is
 *   refused when that isn't the page's latest, or when the page has gone
 *   on to another document, or when the element at its ref has left the
 *   page (re-rendered): "the page changed since you read it". A ref names
 *   an element, not a place, so an element that has only moved is still
 *   the one the agent read.
 * - **Input is trusted:** a click is the debugger's mouse events at the
 *   element's center, typing its `Input.insertText`, so a site sees what a
 *   person's hand would do. An element something else covers at its
 *   center (a cookie banner) is refused, naming what covers it.
 * - **Steps that commit are refused unless confirmed:** a click on a
 *   control, or a form submit whose submitting control, reads as
 *   committing (book, reserve, pay, ...). The agent asks the person, and
 *   calls again with `confirmed: true`. It is a guard rail: a control
 *   labelled otherwise ("Continue", an icon, another language) gets past.
 */

import { ProtocolError } from "./protocol.js";
import { change } from "./registry.js";
import { settled } from "./pages.js";
import { ownTab, unmarked } from "./tabs.js";
import { inWorld, send, work } from "./work.js";

/** How long an action waits for the page to settle after it. */
const AFTER_MS = 10_000;

/** @type {Record<string, import("./port.js").Op>} */
export const actOps = {
    /** A click at the center of the element at `ref`. */
    async click(req) {
        const { tab } = await ownTab(req);
        const { version, ref } = target(req);
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
        const { tab } = await ownTab(req);
        const { version, ref } = target(req);
        const { text, submit = false, clear = true } = req;
        if (typeof text !== "string") throw bad("text: what to type");
        if (typeof submit !== "boolean" || typeof clear !== "boolean") throw bad("submit, clear: true or false");
        await work(tab);
        const aim = await inWorld(tab, aimAt, [version, ref, submit ? "submit" : "type"]);
        refuse(aim, req);
        const started = await before(tab);
        const { toEnd } = await inWorld(tab, focusField, [ref, clear]);
        if (toEnd) await press(tab, { key: "End", code: "End", windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35 });
        if (text) await send(tab, "Input.insertText", { text });
        else if (clear) await press(tab, { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
        if (submit) await press(tab, { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r" });
        return after(tab, started, aim);
    },

    /** The option of the select at `ref` whose text or value is `value`
     *  chosen. A native select's list isn't in the page to click, so this
     *  sets it as the page's own script would; a custom one (a listbox of
     *  options) is clicked instead. */
    async select(req) {
        const { tab } = await ownTab(req);
        const { version, ref } = target(req);
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

/** @param {import("./protocol.js").Request} req */
function target(req) {
    const { version, ref } = req;
    if (!Number.isInteger(version)) throw bad("version: the outline's, from read");
    if (!Number.isInteger(ref) || /** @type {number} */ (ref) < 1) throw bad("ref: a ref from that outline");
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
 * @param {"click" | "type" | "submit" | "select"} how
 * @returns {Aim}
 */
export function aimAt(version, ref, how) {
    const COMMITS = /\b(book|reserve|pay|purchase|buy|checkout|check out|place order|order now|send|post|publish|delete|confirm)\b/i;
    const kept = /** @type {{ version: number, refs: Element[], names: string[] } | undefined} */ (/** @type {any} */ (globalThis).__agex);
    if (kept === undefined) return { stale: "it is another page now" };
    if (kept.version !== version) return { stale: `outline ${version} isn't its latest, ${kept.version}` };
    const el = kept.refs[ref - 1];
    if (el === undefined) return { error: `outline ${version} has no ref ${ref}` };
    if (!el.isConnected) return { stale: `ref ${ref} has left the page` };
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
    if (fields && !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || /** @type {HTMLElement} */ (el).isContentEditable)) {
        return { error: `${desc} isn't a field to type into` };
    }
    if (how === "select" && !(el instanceof HTMLSelectElement)) return { error: `${desc} isn't a select (click a custom one's options)` };

    // what a click or an Enter submits, and whether it reads as committing
    const form = /** @type {HTMLInputElement} */ (el).form ?? el.closest("form");
    const isSubmit = (/** @type {Element} */ e) =>
        (e instanceof HTMLButtonElement && e.type === "submit") || (e instanceof HTMLInputElement && (e.type === "submit" || e.type === "image"));
    let submits = false;
    let says = named(el);
    let step = desc;
    if (how === "click" && form && isSubmit(el)) submits = true;
    if (how === "submit" && form) {
        submits = true;
        const submitter = [...form.elements].find(isSubmit);
        says = submitter ? named(submitter) : "";
        if (submitter) step = `Enter in ${desc}, submitting its form by ${JSON.stringify(text(submitter) || says)},`;
    }
    const commits = how === "click" || submits ? (COMMITS.exec(says)?.[0] ?? null) : null;

    el.scrollIntoView({ block: "center", inline: "center" });
    const box = el.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    if (how === "click") {
        // a click lands on whatever is on top there
        const hit = document.elementFromPoint(x, y);
        const label = hit?.closest("label");
        const ours = hit !== null && (hit === el || el.contains(hit) || hit.contains(el) || (label !== null && label?.control === el));
        if (!ours) return { error: `${desc} is covered by ${hit ? `${hit.tagName.toLowerCase()} ${JSON.stringify(text(hit))}` : "nothing the page shows"}` };
    }
    return { x, y, desc: step, commits, submits };
}

/**
 * The field at `ref` focused, and what it holds selected when `clear`,
 * so what is typed next replaces it, or the cursor put at its end; or
 * `toEnd` when the field can't be given one (a number field), for End.
 * Runs in the page.
 *
 * @param {number} ref @param {boolean} clear
 * @returns {{ toEnd: boolean }}
 */
export function focusField(ref, clear) {
    const el = /** @type {HTMLElement} */ (/** @type {any} */ (globalThis).__agex.refs[ref - 1]);
    el.focus();
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
