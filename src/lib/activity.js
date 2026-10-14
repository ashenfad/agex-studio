/**
 * How the transcript names the agent's work, in plain words: "Ran code
 * 2 times, edited 1 file", "Thought". The components only lay these
 * out; the wording lives here so the group lines and the step lines say
 * one thing the same way.
 */

/**
 * One item of an agent's turn, stored or streaming, as the transcript
 * lays it out.
 *
 * @typedef {(
 *   | { kind: "text", text: string }
 *   | { kind: "thinking", text: string }
 *   | { kind: "tool", name: string, args: Record<string, unknown>, result: string | null,
 *       isError: boolean, images: readonly { data: string, mediaType: string }[] }
 *   | { kind: "note", text: string }
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
