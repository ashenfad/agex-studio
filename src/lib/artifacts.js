/**
 * A reply's rich parts: the `ui` artifacts a turn's code wrote, and
 * where the reply embeds them.
 *
 * Code puts what it wants shown in `ui` (`ui.revenue = figure`); the
 * world writes each one as a file under /workspace/ui and names it in
 * run_ts's result (`[ui artifacts: revenue -> /workspace/ui/…]`). A
 * reply embeds one with markdown image syntax,
 * `![revenue](/workspace/ui/revenue.plotly.json)`, which the chat
 * renders in place by the file's kind; the ones it doesn't embed are
 * shown after it. Everything comes from the record and the files, so a
 * reload renders a reply the same.
 */

import { parseArtifactsNote } from "@agex-ts/world";

/** `![name](/path)`: an embed of a workspace file. */
const EMBED = /!\[([^\]\n]*)\]\((\/[^)\s]+)\)/g;

/**
 * A reply's text split at its embeds: markdown between them, and each
 * embed's name and path. An embed inside a code block or a code span
 * is text, as written.
 *
 * @param {string} text
 * @returns {({ md: string } | { name: string, path: string })[]}
 */
export function splice(text) {
    const code = codeRanges(text);
    /** @type {({ md: string } | { name: string, path: string })[]} */
    const parts = [];
    let last = 0;
    for (const m of text.matchAll(EMBED)) {
        const at = m.index ?? 0;
        if (code.some(([a, b]) => at >= a && at < b)) continue;
        if (at > last) parts.push({ md: text.slice(last, at) });
        parts.push({ name: m[1] ?? "", path: m[2] ?? "" });
        last = at + m[0].length;
    }
    if (last < text.length) parts.push({ md: text.slice(last) });
    return parts;
}

/** Where `text` has code: fenced blocks (to their closing fence, or the
 *  end) and inline spans, as [start, end) ranges.
 *  @param {string} text */
function codeRanges(text) {
    /** @type {[number, number][]} */
    const out = [];
    const fence = /^ {0,3}(`{3,}|~{3,})[^\n]*$/gm;
    /** @type {RegExpExecArray | null} */
    let open = null;
    for (const m of text.matchAll(fence)) {
        if (open === null) open = /** @type {RegExpExecArray} */ (m);
        else if (m[1]?.[0] === open[1]?.[0] && (m[1]?.length ?? 0) >= (open[1]?.length ?? 0)) {
            out.push([open.index, (m.index ?? 0) + m[0].length]);
            open = null;
        }
    }
    if (open !== null) out.push([open.index, text.length]);
    for (const m of text.matchAll(/(`+)[^`]*?\1/g)) {
        const at = m.index ?? 0;
        if (!out.some(([a, b]) => at >= a && at < b)) out.push([at, at + m[0].length]);
    }
    return out;
}

/**
 * The artifacts a run's tool results name, in order, each path once.
 *
 * @param {Iterable<{ content: string }>} results
 * @returns {{ name: string, path: string }[]}
 */
export function artifactsOf(results) {
    /** @type {Map<string, { name: string, path: string }>} */
    const seen = new Map();
    for (const r of results) {
        for (const a of parseArtifactsNote(r.content)) {
            seen.delete(a.path);
            seen.set(a.path, a);
        }
    }
    return [...seen.values()];
}

/**
 * The artifacts a reply doesn't embed: shown after it.
 *
 * @param {{ name: string, path: string }[]} artifacts
 * @param {Iterable<string>} texts the reply's text parts
 */
export function unembedded(artifacts, texts) {
    const embedded = new Set();
    for (const text of texts) {
        for (const part of splice(text)) if ("path" in part) embedded.add(part.path);
    }
    return artifacts.filter((a) => !embedded.has(a.path));
}
