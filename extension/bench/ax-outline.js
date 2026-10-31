/**
 * A page's outline from Chrome's accessibility tree (the DevTools
 * protocol's `Accessibility.getFullAXTree`), in the extension's line
 * format: the text a line per block, `[n] role "name"` on each control.
 * The bench's prototype, to compare with `outline.js` before either
 * replaces the other.
 */

/** Roles a ref goes on: what can be clicked or typed into. */
const INTERACTIVE = new Set([
    "button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "tab", "option",
    "menuitem", "menuitemcheckbox", "menuitemradio", "slider", "spinbutton", "treeitem", "listbox", "ListBox", "PopUpButton",
]);
/** Roles that start a line of their own, and end it. */
const BLOCK = new Set([
    "heading", "paragraph", "listitem", "row", "cell", "gridcell", "columnheader", "rowheader", "article", "region",
    "navigation", "main", "banner", "contentinfo", "complementary", "form", "list", "table", "dialog", "alertdialog", "figure",
    "blockquote", "DescriptionList", "term", "definition", "group", "tabpanel", "Section", "LabelText", "legend", "caption", "status", "alert",
]);
/** Nodes under a text node's own: the same text again, in pieces. */
const SKIP = new Set(["InlineTextBox", "LineBreak"]);
/** Why a node is hidden from assistive tech though a person still sees it:
 *  a site hides its page this way while a pop-up shows over it. */
const HIDDEN_BEHIND = new Set(["ariaHiddenSubtree", "ariaHiddenElement", "inertElement", "activeModalDialog"]);
/** How much of the page a hidden part must be for it to be the page behind
 *  a pop-up, not an icon's or a copy's: nodes, and a share of all of them. */
const PAGE_NODES = 200;
const PAGE_SHARE = 0.2;

/** @param {any} node @param {string} key */
const prop = (node, key) => node.properties?.find((/** @type {any} */ p) => p.name === key)?.value?.value;

/** @param {string} s @param {number} n */
const cap = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * The outline of the tree `nodes` (as `getFullAXTree` gives them): its
 * text, and each ref's kind, name and the DOM node it is (`backend`).
 *
 * @param {any[]} nodes @param {{ maxChars?: number }} [opts]
 * @returns {{ text: string, refs: { ref: number, kind: string, name: string, backend: number }[], cut?: number }}
 */
export function axOutline(nodes, { maxChars = 40_000 } = {}) {
    const byId = new Map(nodes.map((n) => [n.nodeId, n]));
    const root = nodes.find((n) => !n.parentId) ?? nodes[0];
    /** @param {any} n */
    const hiddenBehind = (n) => {
        const why = (n.ignoredReasons ?? []).filter((/** @type {any} */ r) => r.value?.value !== false).map((/** @type {any} */ r) => r.name);
        return n.ignored && why.length > 0 && why.every((/** @type {string} */ r) => HIDDEN_BEHIND.has(r));
    };
    // the page a pop-up hides: the largest parts hidden that way, read as if they weren't
    /** @type {Map<string, number>} */
    const size = new Map();
    /** @param {any} n @returns {number} */
    const sizeOf = (n) => {
        if (size.has(n.nodeId)) return /** @type {number} */ (size.get(n.nodeId));
        const s = 1 + (n.childIds ?? []).reduce((/** @type {number} */ a, /** @type {string} */ id) => a + (byId.has(id) ? sizeOf(byId.get(id)) : 0), 0);
        size.set(n.nodeId, s);
        return s;
    };
    sizeOf(root);
    const behind = new Set(
        nodes
            .filter((n) => hiddenBehind(n) && !hiddenBehind(byId.get(n.parentId) ?? {}) && (size.get(n.nodeId) ?? 0) >= Math.max(PAGE_NODES, PAGE_SHARE * nodes.length))
            .map((n) => n.nodeId),
    );
    /** what a pop-up over the page says, read after the page @type {string[]} */
    const over = [];
    /** @type {string[]} */
    const lines = [];
    /** @type {{ ref: number, kind: string, name: string, backend: number }[]} */
    const refs = [];
    let line = "";
    const flush = () => {
        const t = line.replace(/\s+/g, " ").trim();
        if (t) lines.push(t);
        line = "";
    };
    /** @param {string} s */
    const add = (s) => {
        if (!s) return;
        if (line && !/\s$/.test(line) && !/^\s/.test(s)) line += " ";
        line += s;
    };
    /** @param {any} n @param {string} role */
    const describe = (n, role) => {
        const name = JSON.stringify(cap((n.name?.value ?? "").replace(/\s+/g, " ").trim(), 80));
        const value = n.value?.value;
        const states = [];
        if (prop(n, "checked") === "true" || prop(n, "selected") === true) states.push("checked");
        if (prop(n, "expanded") === true) states.push("expanded");
        if (prop(n, "disabled") === true) states.push("disabled");
        const v = value !== undefined && value !== "" && role !== "link" && role !== "button" ? ` = ${JSON.stringify(cap(String(value), 40))}` : "";
        return `${role} ${name}${v}${states.length > 0 ? ` (${states.join(", ")})` : ""}`;
    };
    /** @param {any} n @param {boolean} inRef inside a ref, whose name its text already is
     *  @param {boolean} [shown] inside the page a pop-up hides, read all the same */
    const walk = (n, inRef, shown = false) => {
        if (!n) return;
        const role = n.role?.value ?? "";
        if (SKIP.has(role)) return;
        const within = shown || behind.has(n.nodeId);
        const kids = () => (n.childIds ?? []).forEach((/** @type {string} */ id) => walk(byId.get(id), inRef, within));
        if (n.ignored && !(within && hiddenBehind(n))) return kids();
        // a pop-up over a page it hides: read after the page, as what has to be got past first
        if (behind.size > 0 && !inRef && (role === "dialog" || role === "alertdialog") && !within) {
            flush();
            const kept = lines.length;
            kids();
            flush();
            over.push(...lines.splice(kept));
            return;
        }
        if (role === "StaticText") {
            if (!inRef) add(n.name?.value ?? "");
            return;
        }
        const block = BLOCK.has(role);
        if (block) flush();
        if (role === "heading") add(`${"#".repeat(Math.min(Number(prop(n, "level") ?? 2), 6))} `);
        if (INTERACTIVE.has(role)) {
            refs.push({ ref: refs.length + 1, kind: role, name: n.name?.value ?? "", backend: n.backendDOMNodeId });
            add(`[${refs.length}] ${describe(n, role)}`);
            // its text is its name; a control inside it is a ref of its own
            (n.childIds ?? []).forEach((/** @type {string} */ id) => walk(byId.get(id), true, within));
        } else if (role === "image" && n.name?.value && !inRef) {
            add(`image ${JSON.stringify(cap(n.name.value, 60))}`);
        } else kids();
        if (block) flush();
    };
    walk(root, false);
    flush();
    if (over.length > 0) lines.push("(a pop-up over the page, which hides it from a click until it's closed:)", ...over);
    // a run of lines alike but for their refs, folded, as outline.js does
    /** @type {string[]} */
    const out = [];
    let alike = 0;
    const bare = (/** @type {string} */ s) => s.replace(/\[\d+\]/g, "[]");
    for (const l of lines) {
        if (out.length > 0 && bare(/** @type {string} */ (out.at(-1))) === bare(l)) {
            alike++;
            continue;
        }
        if (alike > 0) out[out.length - 1] += ` (and ${alike} more like it)`;
        alike = 0;
        out.push(l);
    }
    if (alike > 0) out[out.length - 1] += ` (and ${alike} more like it)`;
    const full = out.join("\n");
    return { text: full.slice(0, maxChars), refs, ...(full.length > maxChars && { cut: full.length }) };
}
