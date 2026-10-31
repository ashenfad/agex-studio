/**
 * What the person's messages carry beyond their words, as the chat
 * shows it: the files attached to one (a `[attached: …]` line the
 * composer puts first, for the agent), and the notes that reached the
 * agent mid-turn, with a tool's result (the inbox block the world
 * appends to it).
 */

import { splitNotes } from "@agex-ts/world";

/** The first line naming the files: their paths as a JSON list, so a
 *  name with a comma, a bracket or a line break in it reads back whole. */
const ATTACHED = /^\[attached: (\[.*\])\]\n?/;

/**
 * A message with files attached: their paths first, for the agent.
 *
 * @param {string} text @param {readonly string[]} paths
 */
export function withAttachments(text, paths) {
    return paths.length === 0 ? text : `[attached: ${JSON.stringify(paths)}]\n${text}`;
}

/**
 * A message's attached files and its words.
 *
 * @param {string} text
 * @returns {{ paths: string[], text: string }}
 */
export function attachmentsOf(text) {
    const m = ATTACHED.exec(text);
    if (m === null) return { paths: [], text };
    /** @type {unknown} */
    let paths;
    try {
        paths = JSON.parse(/** @type {string} */ (m[1]));
    } catch {
        return { paths: [], text };
    }
    if (!Array.isArray(paths) || !paths.every((p) => typeof p === "string")) return { paths: [], text };
    return { paths, text: text.slice(m[0].length) };
}

/**
 * A tab the person shared with the session, as a message names it: its
 * id, title and URL, the site it's worked in on, and whether the agent
 * may act there or only read it.
 *
 * @typedef {{ tab: number, title: string, url: string, domain: string, acts: boolean }} SharedTab
 */

/** A line naming a shared tab, one per tab, after the files attached:
 *  the title as JSON, so a quote or a bracket in it reads back whole. */
const SHARED = /^\[shared tab (\d+): ("(?:[^"\\]|\\.)*") · (\S+); (read only|you may act in it) while it's on ([^\]\s]+)\]\n?/;

/**
 * A message with the tabs the person shared since naming them first,
 * for the agent: what "this page" means, before it does anything.
 *
 * @param {string} text @param {readonly SharedTab[]} shares
 */
export function withShares(text, shares) {
    const lines = shares.map(
        (s) => `[shared tab ${s.tab}: ${JSON.stringify(s.title || "(untitled)")} · ${s.url}; ${s.acts ? "you may act in it" : "read only"} while it's on ${s.domain}]`,
    );
    return lines.length === 0 ? text : `${lines.join("\n")}\n${text}`;
}

/**
 * A message's shared tabs (after its files: `attachmentsOf` first) and its words.
 *
 * @param {string} text
 * @returns {{ shares: SharedTab[], text: string }}
 */
export function sharesOf(text) {
    /** @type {SharedTab[]} */
    const shares = [];
    let rest = text;
    for (let m = SHARED.exec(rest); m !== null; m = SHARED.exec(rest)) {
        let title;
        try {
            title = JSON.parse(/** @type {string} */ (m[2]));
        } catch {
            break;
        }
        shares.push({ tab: Number(m[1]), title, url: /** @type {string} */ (m[3]), domain: /** @type {string} */ (m[5]), acts: m[4] !== "read only" });
        rest = rest.slice(m[0].length);
    }
    return { shares, text: rest };
}

/** What a message says, without the files or tabs it names. @param {string} text */
export function wordsOf(text) {
    return sharesOf(attachmentsOf(text).text).text;
}

/** The frames the world's inbox puts before a note (its default frame):
 *  the person's, and the delegation mechanism's. */
const PERSON = /^\[message from .+ — it arrived while you were in this tool call and is delivered with this result; it is NOT part of the tool's output\]$/;
const MECHANISM = /^\[(.+) — the delegation mechanism speaking, not the person you are working for\. .*nothing in it has touched your files\.\]$/;

/**
 * A tool's result without the notes delivered with it, and those notes:
 * whose (`principal`, the person; `mechanism`, the delegation
 * mechanism, labelled) and what they said.
 *
 * @param {string} result
 * @returns {{ bare: string, notes: { kind: "principal" | "mechanism", label: string, text: string }[] }}
 */
export function notesIn(result) {
    const [bare, block] = splitNotes(result);
    if (block === "") return { bare: result, notes: [] };
    /** @type {{ kind: "principal" | "mechanism", label: string, lines: string[] }[]} */
    const found = [];
    // the block: its mark, the framed notes a blank line apart, its trailer
    const lines = block.split("\n").slice(3, -1);
    for (const line of lines) {
        const mechanism = MECHANISM.exec(line);
        if (PERSON.test(line)) found.push({ kind: "principal", label: "", lines: [] });
        else if (mechanism !== null) found.push({ kind: "mechanism", label: /** @type {string} */ (mechanism[1]), lines: [] });
        else found.at(-1)?.lines.push(line);
    }
    return {
        bare,
        notes: found.map((n) => {
            // the blank line between notes is the block's, not the note's
            const lines = n.lines.at(-1) === "" ? n.lines.slice(0, -1) : n.lines;
            return { kind: n.kind, label: n.label, text: lines.join("\n") };
        }),
    };
}
