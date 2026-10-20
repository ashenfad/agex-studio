/**
 * How the transcript names the agent's work, in plain words: "Ran code
 * 2 times, edited 1 file", "Thought". The components only lay these
 * out; the wording lives here so the group lines and the step lines say
 * one thing the same way.
 */

/**
 * One item of an agent's turn, stored or streaming, as the transcript
 * lays it out. A tool's `result` is null until the call ends, and stays
 * null for a call its turn ended before answering.
 *
 * @typedef {(
 *   | { kind: "text", text: string }
 *   | { kind: "thinking", text: string }
 *   | { kind: "tool", name: string, args: Record<string, unknown>, result: string | null,
 *       isError: boolean, images: readonly { data: string, mediaType: string }[] }
 *   | { kind: "note", from: "principal" | "mechanism", label: string, text: string }
 *   | { kind: "closing", text: string }
 *   | { kind: "folded", summary: string }
 * )} Item
 */

/** @typedef {Extract<Item, { kind: "tool" }>} ToolItem */

/** @param {number} n @param {string} one @param {string} [many] */
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The first line that isn't blank. @param {unknown} text */
const firstLine = (text) =>
    String(text ?? "")
        .split("\n")
        .find((line) => line.trim() !== "")
        ?.trim() ?? "";

/** @param {unknown} value */
const str = (value) => (typeof value === "string" ? value : "");

/**
 * A tool's step line: a verb, what it acted on, and whether that
 * subject reads as code.
 *
 * @param {ToolItem} tool
 * @returns {{ verb: string, subject: string, code: boolean }}
 */
export function stepLine(tool) {
    const args = tool.args;
    switch (tool.name) {
        case "run_ts":
            return { verb: "Ran code", subject: firstLine(args.code), code: true };
        case "terminal":
            return { verb: "Ran", subject: firstLine(args.command), code: true };
        case "file_write":
            return { verb: "Wrote", subject: str(args.path), code: true };
        case "file_edit":
            return { verb: "Edited", subject: str(args.path), code: true };
        case "view_image":
            return { verb: "Viewed", subject: str(args.path), code: true };
        case "test_app": {
            const steps = Array.isArray(args.actions) ? plural(args.actions.length, "step") : "";
            const where = args.live === true ? "in the preview" : "";
            return { verb: "Tested the app", subject: [where, steps].filter(Boolean).join(" · "), code: false };
        }
        case "sessions": {
            // delegation in words: who was asked what, not "sessions ask"
            const who = str(args.resume) || str(args.name) || "a delegate";
            switch (args.action) {
                case "ask":
                    return { verb: args.resume ? `Asked ${who} again` : `Asked ${who}`, subject: firstLine(args.task), code: false };
                case "result":
                    return { verb: `Read ${who}'s answer`, subject: "", code: false };
                case "list":
                    return { verb: "Checked on delegates", subject: "", code: false };
                case "cancel":
                    return { verb: `Cancelled ${who}`, subject: "", code: false };
                case "keep":
                    return { verb: `Kept ${who}`, subject: "", code: false };
                case "published":
                    return { verb: "Listed the published apps", subject: "", code: false };
                default:
                    return { verb: "Sessions", subject: str(args.action), code: false };
            }
        }
        default:
            return { verb: `Used ${tool.name}`, subject: "", code: false };
    }
}

/** A line that marks a part of a code result, as the world renders
 *  them: `[returned]`, `[error]`, `[hint: …]`, `[stderr]`,
 *  `[output truncated]`, `[ui …]`. */
const MARK = /^\[(?:stderr|error|returned|output truncated|hint: .*|ui [a-z]+: .*)\]$/;
const EXIT = /^\[exit code (\d+)\]$/;

/** @typedef {{ text: string, part: "out" | "mark" | "exit" | "stderr" | "error" | "returned", code?: number }} Part */

/**
 * A result's lines, each with the part it belongs to: `out` before any
 * mark, the mark lines themselves (`exit` carries its code), and the
 * lines under a `[stderr]`, `[error]` or `[returned]` mark.
 *
 * A terminal result is read by its shape, since its output can print
 * anything: the output, then the world's `[exit code N]` (only when the
 * call errored), `[stderr]` and its lines, and `[output truncated]`
 * last. Its exit mark is the last one followed by nothing or by
 * `[stderr]`; one the command printed is followed by more output.
 *
 * @param {ToolItem} tool
 * @returns {Part[]}
 */
function resultParts(tool) {
    const lines = (tool.result ?? "").split("\n");
    if (tool.name !== "terminal") {
        /** @type {"out" | "stderr" | "error" | "returned"} */
        let part = "out";
        return lines.map((line) => {
            if (!MARK.test(line)) return { text: line, part };
            part = line === "[stderr]" ? "stderr" : line === "[error]" ? "error" : line === "[returned]" ? "returned" : part;
            return { text: line, part: "mark" };
        });
    }
    let end = lines.length;
    const truncated = lines[end - 1] === "[output truncated]";
    if (truncated) end--;
    let exit = -1;
    if (tool.isError) {
        for (let i = end - 1; i >= 0 && exit < 0; i--) if (EXIT.test(lines[i]) && (i === end - 1 || lines[i + 1] === "[stderr]")) exit = i;
    }
    const stderr = exit >= 0 ? (lines[exit + 1] === "[stderr]" ? exit + 1 : -1) : lines.lastIndexOf("[stderr]", end - 1);
    const outEnd = exit >= 0 ? exit : stderr >= 0 ? stderr : end;
    return lines.map((text, i) => {
        if (i < outEnd) return { text, part: "out" };
        if (i === exit) return { text, part: "exit", code: Number(EXIT.exec(text)?.[1]) };
        if (i === stderr || i >= end) return { text, part: "mark" };
        return { text, part: stderr >= 0 && i > stderr ? "stderr" : "out" };
    });
}

/**
 * How a tool call ended. `exit`: a command that ran and exited
 * non-zero, as grep does finding nothing, or ls of a path not there
 * yet: news more often than a failure. `failed`: what didn't work: a
 * script that didn't parse or named no command, code that threw, a
 * call refused.
 *
 * @param {ToolItem} tool
 * @returns {{ kind: "ok" } | { kind: "exit", code: number } | { kind: "failed" }}
 */
export function outcome(tool) {
    if (!tool.isError) return { kind: "ok" };
    if (tool.name === "terminal" && tool.result !== null) {
        const parts = resultParts(tool);
        const exit = parts.find((p) => p.part === "exit");
        const parse = parts.find((p) => p.part === "stderr")?.text.startsWith("parse error:") ?? false;
        // 126 and 127: a command that couldn't run, or isn't there
        if (exit?.code !== undefined && !parse && exit.code !== 126 && exit.code !== 127) return { kind: "exit", code: exit.code };
    }
    return { kind: "failed" };
}

/**
 * A result's lines, each with its tone: `plain` output, a `mark` line,
 * `warn` for stderr and the exit code of a command that exited
 * non-zero, `bad` for what failed. Only the parts that say something
 * went wrong are coloured, so the output around them reads as it is.
 *
 * @param {ToolItem} tool
 * @returns {{ text: string, tone: "plain" | "mark" | "warn" | "bad" }[]}
 */
export function resultLines(tool) {
    const failed = outcome(tool).kind === "failed";
    const trouble = failed ? "bad" : "warn";
    const parts = resultParts(tool);
    // a failure the result doesn't mark (a call refused) is all its text
    const unmarked = failed && parts.every((p) => p.part === "out");
    return parts.map(({ text, part }) => {
        switch (part) {
            case "mark":
                return { text, tone: "mark" };
            case "exit":
            case "stderr":
                return { text, tone: trouble };
            case "error":
                return { text, tone: "bad" };
            default:
                return { text, tone: unmarked ? "bad" : "plain" };
        }
    });
}

/**
 * What a run of tools did, as phrases in the order the kinds first
 * appear: `[{ verb: "Ran", rest: "code 2 times" }, { verb: "edited",
 * rest: "1 file" }]`. Files count once however often they were written.
 *
 * @param {readonly ToolItem[]} tools
 * @returns {{ verb: string, rest: string }[]}
 */
export function groupPhrases(tools) {
    /** @type {Map<string, ToolItem[]>} */
    const byName = new Map();
    for (const t of tools) {
        const same = byName.get(t.name);
        if (same === undefined) byName.set(t.name, [t]);
        else same.push(t);
    }
    /** @param {ToolItem[]} ts */
    const files = (ts) => new Set(ts.map((t) => str(t.args.path))).size;
    /** @param {string} name @param {ToolItem[]} ts @returns {[string, string]} */
    const phrase = (name, ts) => {
        const n = ts.length;
        switch (name) {
            case "run_ts":
                return ["Ran", n === 1 ? "code" : `code ${n} times`];
            case "terminal":
                return ["Ran", plural(n, "command")];
            case "file_write":
                return ["Wrote", plural(files(ts), "file")];
            case "file_edit":
                return ["Edited", plural(files(ts), "file")];
            case "view_image":
                return ["Viewed", plural(n, "image")];
            case "test_app":
                return ["Tested", n === 1 ? "the app" : `the app ${n} times`];
            case "sessions": {
                const asks = ts.filter((t) => t.args.action === "ask").length;
                if (asks === n) return ["Asked", plural(n, "delegate")];
                return ["Used", n === 1 ? "sessions" : `sessions ${n} times`];
            }
            default:
                return ["Used", n === 1 ? name : `${name} ${n} times`];
        }
    };
    return [...byName].map(([name, ts], i) => {
        const [verb, rest] = phrase(name, ts);
        return { verb: i === 0 ? verb : verb.toLowerCase(), rest };
    });
}

/**
 * A turn's items, with each run of work (tool calls, and the thinking
 * between and before them) gathered into one group, and prose and the
 * rest standing alone. While the turn streams, thinking at its tail
 * stands alone, so it can be read as it arrives; it folds into the
 * group once the model moves on.
 *
 * @param {readonly Item[]} items
 * @param {{ streaming?: boolean }} [opts]
 * @returns {(Item | { kind: "work", entries: Item[] })[]}
 */
export function groupWork(items, { streaming = false } = {}) {
    /** @type {(Item | { kind: "work", entries: Item[] })[]} */
    const out = [];
    items.forEach((item, i) => {
        const last = out.at(-1);
        const tail = streaming && i === items.length - 1;
        const joins =
            item.kind === "tool" ||
            (item.kind === "thinking" && !tail && (last?.kind === "work" || items[i + 1]?.kind === "tool"));
        if (!joins) out.push(item);
        else if (last?.kind === "work") last.entries.push(item);
        else out.push({ kind: "work", entries: [item] });
    });
    return out;
}
