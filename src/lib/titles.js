/**
 * A session's name, written by the model from the conversation (after
 * nontainer-studio): once the first exchange is in, and again every
 * `TITLE_TURNS` of the person's turns, so the name follows the work as
 * it moves. A name the person gave stays: renaming stops the model's.
 *
 * It is a side call, not the agent's: one small request over the
 * conversation's tail, on the person's model, whose failure leaves the
 * name as it was.
 */

import { messageText, thinkingOptions } from "agex-ts";
import { deliveredAnswers } from "./delegation.svelte.js";
import { attachmentsOf, notesIn } from "./notes.js";

/** The person's turns between one name and the next. */
export const TITLE_TURNS = 5;
/** The longest name, as the session list shows it. */
export const TITLE_MAX = 60;
/** How much of the conversation's tail the model reads, in characters:
 *  the recent work names the session, not where it started. */
export const TRANSCRIPT_LIMIT = 6000;
/** How much of a tool call's arguments a line shows. */
const ARG_PREVIEW = 80;

export const TITLE_PROMPT =
    "You name a work session for the human's session list. Read the transcript and answer with 3 to 6 words naming the work — " +
    '"Revenue dashboard", "Debugging the CSV import". No quotes, no trailing period, no preamble: the answer is the title and nothing else.';

/** @typedef {import("agex-ts").Run} Run */

/** What the person said in a message: its words, and the files attached, by name.
 *  @param {string} text */
function said(text) {
    const { paths, text: words } = attachmentsOf(text);
    const files = paths.length ? ` (attached: ${paths.map((p) => p.split("/").at(-1)).join(", ")})` : "";
    return `${words.trim()}${files}`.trim();
}

/**
 * The conversation as the model reads it to name it: what the person
 * said (mid-turn notes included), what the agent answered, and a line
 * per tool call; its tail, cut at a line.
 *
 * @param {readonly Run[]} runs @param {number} [limit]
 */
export function transcriptText(runs, limit = TRANSCRIPT_LIMIT) {
    /** @type {string[]} */
    const lines = [];
    for (const run of runs) {
        for (const [i, message] of run.messages.entries()) {
            if (message.role === "user") {
                const text = messageText(message);
                // a woken turn opens on the mechanism's delivery: what the person said in it, if anything
                const words = i === 0 ? (deliveredAnswers(text)?.said ?? text) : text;
                if (said(words)) lines.push(`user: ${said(words)}`);
            } else if (message.role === "assistant") {
                const text = messageText(message).trim();
                if (text) lines.push(`assistant: ${text}`);
                for (const part of message.parts) {
                    if (part.kind !== "tool_call") continue;
                    const args = JSON.stringify(part.args);
                    lines.push(`[tool] ${part.name} ${args === "{}" ? "" : args.slice(0, ARG_PREVIEW)}`.trimEnd());
                }
            } else if (message.role === "tool") {
                for (const part of message.parts) {
                    if (part.kind !== "tool_result") continue;
                    for (const note of notesIn(part.content).notes) {
                        if (note.kind === "principal" && said(note.text)) lines.push(`user: ${said(note.text)}`);
                    }
                }
            }
        }
    }
    const text = lines.join("\n");
    if (text.length <= limit) return text;
    // the cut lands mid-line: start at the next whole one
    return text.slice(-limit).split("\n").slice(1).join("\n");
}

/**
 * How many turns the person started: their messages, not the turns
 * their delegates' answers woke.
 *
 * @param {readonly Run[]} runs
 */
export function personTurns(runs) {
    let n = 0;
    for (const run of runs) {
        const first = run.messages[0];
        if (first?.role !== "user") continue;
        const delivered = deliveredAnswers(messageText(first));
        if (delivered === null || delivered.said !== "") n += 1;
    }
    return n;
}

/**
 * Whether the model names the session now: never once the person named
 * it; else once the first exchange is in, and `TITLE_TURNS` turns after
 * the last name.
 *
 * @param {{ named?: boolean, titledAt?: number } | null} meta @param {number} turns
 */
export function titleDue(meta, turns) {
    if (meta?.named === true || turns < 1) return false;
    return meta?.titledAt === undefined || turns - meta.titledAt >= TITLE_TURNS;
}

/**
 * A model's answer as a name: one line, no quotes or closing period,
 * at most `TITLE_MAX` long; null for nothing usable.
 *
 * @param {unknown} text
 */
export function cleanTitle(text) {
    if (typeof text !== "string") return null;
    const line = text
        .split(/\s+/)
        .join(" ")
        .trim()
        .replace(/^(title:\s*)/i, "")
        .replace(/^["'“”‘’`*]+|["'“”‘’`*]+$/g, "")
        .replace(/\.$/, "")
        .trim();
    if (line === "") return null;
    return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1).trimEnd()}…` : line;
}

/**
 * The model's name for a conversation, or null.
 *
 * Naming needs little thought: the person's thinking setting, at most
 * low. (Not none whatever the setting: some models must reason, and
 * refuse a request that turns it off; the person's turns work, so
 * their setting does.)
 *
 * @param {any} model an AI SDK language model (the provider spec)
 * @param {string} transcript
 * @param {{ thinking?: boolean | string }} [opts] the person's thinking setting
 */
export async function generateTitle(model, transcript, { thinking = false } = {}) {
    const effort = thinking === false ? false : "low";
    const out = await model.doGenerate({
        prompt: [
            { role: "system", content: TITLE_PROMPT },
            { role: "user", content: [{ type: "text", text: transcript }] },
        ],
        reasoning: effort === false ? "none" : effort,
        providerOptions: thinkingOptions(String(model.provider ?? "").split(".")[0] ?? "", effort),
        // room for the thinking before the few words
        maxOutputTokens: 2000,
    });
    const text = (out.content ?? [])
        .filter((/** @type {any} */ p) => p.type === "text")
        .map((/** @type {any} */ p) => p.text)
        .join("");
    return cleanTitle(text);
}
