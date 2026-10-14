/**
 * `window.__studio`, in dev builds only: what `scripts/drive.mjs` (and
 * a person at the console) drives the studio through, so a driver
 * doesn't break when the markup moves.
 *
 *     await __studio.configure({ accessMode: 'openrouter', apiKey, model })
 *     await __studio.say('write a haiku to /workspace/haiku.txt')
 *     await __studio.transcript()   // the stored runs, flattened
 *     await __studio.files('/workspace')
 */

import { script } from "./studio.svelte.js";
import { getSettings, updateSettings } from "./settings.js";

/** @typedef {import("./studio.svelte.js").ChatSession} ChatSession */

/**
 * A run flattened for a reader: each message's role and its parts, a
 * tool call with its args and a tool result with its content.
 *
 * @param {import("agex-ts").Run} run
 */
function flatten(run) {
    return {
        runId: run.runId,
        status: run.status,
        messages: run.messages.map((m) => ({
            role: m.role,
            parts: m.parts.map((p) => {
                if (p.kind === "tool_call") return { kind: p.kind, name: p.name, args: p.args };
                if (p.kind === "tool_result") {
                    return { kind: p.kind, name: p.name, content: p.content, isError: p.isError ?? false };
                }
                return { kind: p.kind, text: p.text };
            }),
        })),
    };
}

/** @param {() => ChatSession | null} current */
export function installDevHook(current) {
    const session = () => {
        const s = current();
        if (s === null || s.ws === null) throw new Error("no session is open yet");
        return s;
    };
    /** @type {any} */ (window).__studio = {
        /** @param {Partial<import("./settings.js").Settings>} patch */
        configure(patch) {
            updateSettings(patch);
            const { apiKey, ...rest } = getSettings();
            return { ...rest, apiKey: apiKey === "" ? "" : "(set)" };
        },
        /** The scripted model's next steps (accessMode 'scripted').
         *  @param {import("@agex-ts/world/conformance").ModelStep[]} steps */
        script(steps) {
            script.splice(0, script.length, ...steps);
        },
        /** Run a turn; its ending, once the record is read back.
         *  @param {string} prompt */
        async say(prompt) {
            const s = session();
            await s.say(prompt);
            const last = s.runs.at(-1);
            return { status: last?.status ?? null, error: s.error };
        },
        async wait() {
            await session().settled();
        },
        cancel() {
            session().cancel();
        },
        get busy() {
            return current()?.busy ?? false;
        },
        /** Whether the session is open, so the rest can be called. */
        get ready() {
            return (current()?.ws ?? null) !== null;
        },
        async transcript() {
            return session().runs.map(flatten);
        },
        /** @param {string} [dir] */
        async files(dir = "/workspace") {
            return session().ws?.files.list(dir, { recursive: true });
        },
        /** @param {string} path */
        async read(path) {
            return session().ws?.files.readText(path);
        },
    };
}
