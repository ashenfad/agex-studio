/**
 * `window.__studio`, in dev builds only: what `scripts/drive.mjs` (and
 * a person at the console) drives the studio through, so a driver
 * doesn't break when the markup moves.
 *
 *     await __studio.configure({ accessMode: 'openrouter', apiKey, model })
 *     await __studio.say('write a haiku to /workspace/haiku.txt')
 *     await __studio.transcript()   // the stored runs, flattened
 *     await __studio.files('/workspace')
 *     await __studio.upload([{ name: 'doc.pdf', base64 }])   // into uploads/
 *     await __studio.fork('fresh'); await __studio.undo(0); __studio.sessions()
 */

import { base64ToBytes } from "./bytes.js";
import { script } from "./studio.svelte.js";
import { getSettings, updateSettings } from "./settings.js";

/** @typedef {import("./studio.svelte.js").Studio} Studio */

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

/** @param {Studio} studio */
export function installDevHook(studio) {
    const session = () => {
        const s = studio.current;
        if (s === null || s.ws === null) throw new Error("no session is open yet");
        return s;
    };
    /** A run of the current session by its index, or by its id.
     *  @param {number | string} which */
    const runId = (which) => {
        const runs = session().runs;
        const run = typeof which === "number" ? runs.at(which) : runs.find((r) => r.runId === which);
        if (run === undefined) throw new Error(`no run ${JSON.stringify(which)}`);
        return run.runId;
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
            return studio.current?.busy ?? false;
        },
        /** Whether a session is open, so the rest can be called. */
        get ready() {
            return (studio.current?.ws ?? null) !== null;
        },
        /** The session looked at: its name and title. */
        get current() {
            const s = studio.current;
            return s === null ? null : { name: s.name, title: s.title };
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
        /** Add files as the drawer's Upload does: under uploads/.
         *  @param {{ name: string, base64: string }[]} files */
        async upload(files) {
            return session().importFiles(files.map((f) => ({ name: f.name, bytes: base64ToBytes(f.base64) })));
        },
        async sessions() {
            await studio.refresh();
            return studio.sessions.map((s) => ({ name: s.name, title: s.title }));
        },
        async create() {
            await studio.create();
            return this.current;
        },
        /** @param {string} name */
        async switchTo(name) {
            await studio.switchTo(name);
            return this.current;
        },
        /** @param {"full" | "fresh"} inherit */
        async fork(inherit = "full") {
            await studio.fork(inherit);
            return this.current;
        },
        /** @param {string} name */
        async remove(name) {
            await studio.remove(name);
            return this.current;
        },
        /** @param {string} title */
        async rename(title) {
            await session().rename(title);
            return this.current;
        },
        /** Undo a run of the current session (by index or id) and what
         *  followed it. @param {number | string} which */
        async undo(which) {
            await session().undo(runId(which));
            return { runs: session().runs.length, redo: session().redoHead !== null };
        },
        async redo() {
            await session().redo();
            return { runs: session().runs.length };
        },
        async resume() {
            await session().resume();
            return { status: session().runs.at(-1)?.status ?? null, error: session().error };
        },
        async folds() {
            return session().folds.map((f) => ({ through: f.through, summary: f.summary }));
        },
    };
}
