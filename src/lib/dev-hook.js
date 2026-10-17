/**
 * `window.__studio`, in dev builds only: what `scripts/drive.mjs` (and
 * a person at the console) drives the studio through, so a driver
 * doesn't break when the markup moves.
 *
 *     await __studio.configure({ accessMode: 'openrouter', routerKey, model })
 *     await __studio.say('write a haiku to /workspace/haiku.txt')
 *     await __studio.transcript()   // the stored runs, flattened
 *     await __studio.files('/workspace')
 *     await __studio.upload([{ name: 'doc.pdf', base64 }])   // into uploads/
 *     await __studio.fork('fresh'); await __studio.undo(0); __studio.sessions()
 *     await __studio.sync.sweep(); __studio.sync.state()   // with sync connected
 *     await __studio.db.query('SELECT 1 AS one')   // the session's app database
 */

import { appDbs } from "./app-db-clients.js";
import { base64ToBytes, bytesToBase64 } from "./bytes.js";
import { distribution } from "./distribution.svelte.js";
import { script } from "./scripted.js";
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

/**
 * @param {Studio} studio
 * @param {import("./sync.svelte.js").Sync} sync
 */
export function installDevHook(studio, sync) {
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
            const { routerKey, endpointKey, syncToken, publishToken, ...rest } = getSettings();
            const masked = (/** @type {string} */ key) => (key === "" ? "" : "(set)");
            return {
                ...rest,
                routerKey: masked(routerKey),
                endpointKey: masked(endpointKey),
                syncToken: masked(syncToken),
                publishToken: masked(publishToken),
            };
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
        /** The context the meter shows, in tokens (null: not known yet). */
        get context() {
            return session().context;
        },
        /** Fold the conversation so far now, as the meter's Fold now does;
         *  the context after, and the folds. */
        async foldNow() {
            const s = session();
            await s.foldNow();
            return { context: s.context, folds: s.folds.length, error: s.error };
        },
        /** The current session as a bundle: its file name, size, and
         *  bytes (base64). @param {"everything" | "current"} shape */
        async exportBundle(shape) {
            const { bytes, fileName } = await distribution.exportBundle(session().name, shape);
            return { fileName, size: bytes.length, base64: bytesToBase64(bytes) };
        },
        /** Open a bundle (base64), as Import does. @param {string} base64 */
        async importBundle(base64) {
            return distribution.importBundle(base64ToBytes(base64));
        },
        /** Publish the current session as a gist; its links.
         *  @param {"everything" | "current"} [shape] @param {boolean} [fresh] */
        async publish(shape = "current", fresh = false) {
            const gist = await distribution.publish(session().name, { shape, fresh });
            const { runUrl } = await import("./gist.js");
            return { ...gist, play: runUrl(location.origin, gist, { play: true }), run: runUrl(location.origin, gist) };
        },
        /** Look for newer revisions of opened gists now. */
        async checkUpdates() {
            await distribution.checkUpdates({ force: true });
            return { ...distribution.updates };
        },
        /** The current session's delegates: name, status, unread. */
        jobs() {
            const s = session();
            s.syncJobs();
            return s.jobs.map((j) => ({ name: j.name, status: j.status, unread: s.unread.includes(j.name) }));
        },
        /** Act on the preview the person sees, as test_app's live does.
         *  @param {object[]} actions */
        async live(actions) {
            const { getLiveIframe, runLiveApp, whenLiveSettled } = await import("./app-control.js");
            await whenLiveSettled();
            const iframe = getLiveIframe();
            if (iframe === null) throw new Error("the preview isn't showing an app");
            return runLiveApp({ iframe, actions });
        },
        /** This page's budgets for apps' agent calls, and an app asking. */
        async appAgent() {
            const { appAgent } = await import("./app-tasks.svelte.js");
            return { budgets: { ...appAgent.budgets }, asking: Object.fromEntries(Object.entries(appAgent.asking).map(([k, v]) => [k, v.task])) };
        },
        /** Answer the current session's app's request to use the
         *  model. @param {boolean} yes */
        async consent(yes) {
            const { appAgent } = await import("./app-tasks.svelte.js");
            appAgent.asking[session().name]?.answer(yes);
            return this.appAgent();
        },
        /** The current session's head. */
        head() {
            return session().ws?.head ?? null;
        },
        /** The current session's app database, named and opened on
         *  first use. */
        db: {
            /** @param {string} sql @param {unknown[]} [params] */
            async query(sql, params) {
                return (await appDbs.dbFor(session().name)).query(sql, /** @type {any} */ (params));
            },
            /** @param {[string, unknown[]?][]} statements */
            async transaction(statements) {
                return (await appDbs.dbFor(session().name)).transaction(/** @type {any} */ (statements));
            },
            /** The database's state, and this tab's part in serving it. */
            async info() {
                const client = await appDbs.dbFor(session().name);
                const [info, status] = await Promise.all([client.info(), client.status()]);
                return { ...info, status };
            },
            /** The databases this page holds a client for, with the sessions using each. */
            held() {
                return Object.fromEntries(appDbs.held());
            },
            async release() {
                await appDbs.release(session().name);
                return this.held();
            },
        },
        /** Sync, as the session list works it. */
        sync: {
            /** Each session's sync, the cloud sessions and the trash. */
            state() {
                return {
                    connected: sync.connected,
                    problem: sync.problem,
                    status: Object.fromEntries(Object.entries(sync.status).map(([k, v]) => [k, v.state + (v.detail ? `: ${v.detail}` : "")])),
                    cloud: sync.cloud.map((c) => ({ ...c })),
                    trash: sync.trash.map((t) => ({ ...t })),
                };
            },
            async sweep() {
                await sync.sweep({ force: true });
                return this.state();
            },
            /** @param {string} [name] the current session's when left out */
            async now(name) {
                await sync.syncNow(name ?? session().name);
                return this.state();
            },
            /** @param {string} name */
            async download(name) {
                await sync.download(name);
                return this.state();
            },
            /** @param {string} name */
            async useSynced(name) {
                await sync.useSynced(name);
                return this.state();
            },
            /** @param {string} name */
            async keepMine(name) {
                await sync.keepMine(name);
                return this.state();
            },
            /** @param {string} name */
            async deleteEverywhere(name) {
                await sync.deleteEverywhere(name);
                return this.state();
            },
            /** @param {string} name */
            async restore(name) {
                await sync.restore(name);
                return this.state();
            },
            async emptyTrash() {
                await sync.emptyTrash();
                return this.state();
            },
        },
    };
}
