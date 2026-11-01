/**
 * A site's runs as the extension's page shows them: what each was asked,
 * the tool calls it made and what came back, how it ended in its own
 * words, and what it used; read from the session's run records
 * (`readRuns`), newest first.
 */

import { messageText, readRuns, runUsage } from "agex-ts";

/** The most runs a log gives. */
const RUNS = 20;
/** How much of a call's arguments, or its result, a step keeps. */
const ARGS = 400;
const RESULT = 600;

/** @param {string} s @param {number} n */
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * @typedef {{ tool: string, args: string, result: string, isError: boolean }} Step
 * @typedef {{
 *   runId: string,
 *   status: string | null,
 *   startedAt: number | null,
 *   endedAt: number | null,
 *   asked: string,
 *   steps: Step[],
 *   said: string,
 *   models: string[],
 *   usage: { inputTokens: number, outputTokens: number },
 * }} LoggedRun
 */

/**
 * The runs of the session in `ws`, newest first.
 *
 * @param {import("@agex-ts/world").Workspace} ws
 * @returns {Promise<LoggedRun[]>}
 */
export async function runLog(ws) {
    const runs = (await readRuns(ws)).slice(-RUNS).reverse();
    return runs.map((run) => {
        /** @type {Map<string, Step>} */
        const calls = new Map();
        /** @type {Step[]} */
        const steps = [];
        let asked = "";
        let said = "";
        /** @type {Set<string>} */
        const models = new Set();
        for (const message of run.messages) {
            if (message.role === "user" && asked === "") asked = messageText(message);
            if (message.role === "assistant") {
                if (message.model) models.add(message.model);
                const text = messageText(message).trim();
                if (text !== "") said = text;
            }
            for (const part of message.parts) {
                if (part.kind === "tool_call") {
                    // code reads best as itself; anything else as its arguments
                    const code = typeof part.args.code === "string" ? part.args.code : null;
                    const step = { tool: part.name, args: cut(code ?? JSON.stringify(part.args), ARGS), result: "", isError: false };
                    calls.set(part.callId, step);
                    steps.push(step);
                } else if (part.kind === "tool_result") {
                    const step = calls.get(part.callId);
                    if (step) {
                        step.result = cut(part.content, RESULT);
                        step.isError = part.isError === true;
                    }
                }
            }
        }
        const usage = runUsage(run);
        return {
            runId: run.runId,
            status: run.status,
            startedAt: run.startedAt ?? null,
            endedAt: run.endedAt ?? null,
            asked: cut(asked, 600),
            steps,
            said: cut(said, 1000),
            models: [...models],
            usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
        };
    });
}
