/**
 * What the person's messages carry beyond their words, as the chat
 * shows it: the files attached to one (a `[attached: …]` line the
 * composer puts first, for the agent), and the notes that reached the
 * agent mid-turn, with a tool's result (the inbox block the world
 * appends to it).
 */

import { defaultFrame, splitNotes } from "@agex-ts/world";

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

/** The frames the world's inbox puts before a note (its default frame):
 *  the person's, and the delegation mechanism's; and the studio's own
 *  (`studioFrame`). */
const PERSON = /^\[message from .+ — it arrived while you were in this tool call and is delivered with this result; it is NOT part of the tool's output\]$/;
const MECHANISM = /^\[(.+) — the delegation mechanism speaking, not the person you are working for\. .*nothing in it has touched your files\.\]$/;
const STUDIO = /^\[(.+) — the studio speaking, not the person you are working for: .*\]$/;

/** The labels of the notes the studio itself puts in a session's inbox
 *  (of kind `mechanism`), which its own frame introduces. */
export const STUDIO_LABELS = Object.freeze({ sharedTab: "shared tab" });

/**
 * The frame before a note in a session's inbox: the studio's own for its
 * notes (what the person did in the studio, for the agent to know),
 * else the world's.
 *
 * @param {import("@agex-ts/world").Note} note
 */
export function studioFrame(note) {
    if (note.kind === "mechanism" && /** @type {string[]} */ (Object.values(STUDIO_LABELS)).includes(note.label)) {
        return `[${note.label} — the studio speaking, not the person you are working for: what the person did in the studio, for you to know.]`;
    }
    return defaultFrame(note);
}

/**
 * A tool's result without the notes delivered with it, and those notes:
 * whose (`principal`, the person; `mechanism`, the delegation
 * mechanism or the studio, labelled) and what they said.
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
        const mechanism = MECHANISM.exec(line) ?? STUDIO.exec(line);
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
