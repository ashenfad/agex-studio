/**
 * The studio's side of its browser extension's port (see
 * `extension/src/protocol.js`): finding the extension, calling its ops,
 * and keeping the port up while a turn runs.
 *
 * Only the page can open the port, so the studio opens it before any
 * call and whenever its tab comes back to the front, and opens it again
 * when it has dropped. A port with no messages on it doesn't keep the
 * extension's service worker alive, so while anything holds the
 * extension (`hold`: a turn running) the studio pings it, and tells it a
 * turn is running (`turn`), which keeps the studio's tab from being
 * discarded meanwhile.
 *
 * Without the extension the studio is as it is without one: `status` says
 * `absent`, and the tools that would need it aren't offered.
 */

import { DEV_EXTENSION_ID, HEARTBEAT_MS, PROTOCOL, STORE_EXTENSION_ID } from "../../extension/src/protocol.js";

/** A refusal from the extension, or the port failing: `code` as the
 *  protocol's (`not-granted`, `stale`, ...), or `absent` and
 *  `disconnected` from this side. */
export class ExtensionError extends Error {
    /** @param {string} code @param {string} message */
    constructor(code, message) {
        super(message);
        this.name = "ExtensionError";
        this.code = code;
    }
}

/** Where a person who wants a different extension id keeps it (an
 *  unpacked store build has an id of its own). */
export const ID_KEY = "agex-studio-extension-id";

/**
 * The ids the extension may have here, in the order tried: one the
 * person set, the store's, then the dev build's (whose fixed id answers
 * agex.studio and local dev servers alike).
 *
 * @param {Storage | undefined} storage
 * @returns {string[]}
 */
export function candidateIds(storage) {
    let set = null;
    try {
        set = storage?.getItem(ID_KEY) ?? null;
    } catch {
        // storage refused: no id of the person's
    }
    return [...new Set([set, STORE_EXTENSION_ID, DEV_EXTENSION_ID].filter((id) => typeof id === "string" && id !== ""))];
}

/**
 * @typedef {"unknown" | "absent" | "found" | "outdated"} Status
 *   `outdated`: an extension answered with another protocol's version.
 * @typedef {{ connect: (id: string) => chrome.runtime.Port, lastError?: { message?: string } }} Runtime
 */

export class BrowserExtension {
    /** Whether the extension is here. @type {Status} */
    status = $state("unknown");
    /** The extension's version, once found. @type {string | null} */
    version = $state(null);
    /** Why it isn't usable, when `outdated`. @type {string | null} */
    problem = $state(null);

    /** @type {{ port: chrome.runtime.Port, id: string } | null} */
    #open = null;
    /** @type {Promise<chrome.runtime.Port> | null} */
    #opening = null;
    /** The calls waiting on a reply, by request id, with the port each
     *  went out on. @type {Map<number, { ok: (v: unknown) => void, no: (e: Error) => void, port: chrome.runtime.Port }>} */
    #waiting = new Map();
    #next = 0;
    #holds = 0;
    /** @type {ReturnType<typeof setInterval> | null} */
    #beat = null;
    /** Called each time a port opens and is greeted. @type {Set<() => void>} */
    #onOpen = new Set();
    /** Called with each event the extension sends unasked. @type {Set<(event: string) => void>} */
    #onEvent = new Set();

    /**
     * @param {{ runtime?: Runtime | null, ids?: string[], heartbeatMs?: number }} opts
     *   `runtime` is `chrome.runtime` as the page has it: undefined when
     *   no extension answers this page at all.
     */
    constructor({ runtime, ids = [], heartbeatMs = HEARTBEAT_MS }) {
        this.runtime = runtime ?? null;
        this.ids = ids;
        this.heartbeatMs = heartbeatMs;
    }

    /** Look for the extension (once at the start, and as the page comes
     *  back to the front): `status` says what was found. */
    async detect() {
        await this.#port().catch(() => {});
    }

    /**
     * Call `op`: its value, or an `ExtensionError` with the extension's
     * refusal. The port is opened first if it isn't open.
     *
     * @param {string} op @param {Record<string, unknown>} [args]
     * @returns {Promise<any>}
     */
    async call(op, args = {}) {
        const port = await this.#port();
        return this.#send(port, op, args);
    }

    /**
     * Hold the extension while something runs (a turn): the first hold
     * starts the heartbeat and tells the extension a turn is running, the
     * last one let go stops it and says the turn ended. Returns the
     * letting go. With no extension, a hold does nothing.
     *
     * @returns {() => void}
     */
    hold() {
        this.#holds++;
        if (this.#holds === 1) {
            void this.#tell(true);
            this.#beat = setInterval(() => {
                if (this.status === "found" || this.#open !== null) void this.call("ping").catch(() => {});
            }, this.heartbeatMs);
        }
        let held = true;
        return () => {
            if (!held) return;
            held = false;
            this.#holds--;
            if (this.#holds > 0) return;
            if (this.#beat !== null) clearInterval(this.#beat);
            this.#beat = null;
            void this.#tell(false);
        };
    }

    /**
     * Call `fn` each time the port opens (the extension found, or found
     * again after it dropped: its service worker may have lost what it
     * was told, a browser restart clearing it). Returns the stopping.
     *
     * @param {() => void} fn
     */
    onOpen(fn) {
        this.#onOpen.add(fn);
        return () => this.#onOpen.delete(fn);
    }

    /**
     * Call `fn` with each event the extension sends unasked (`shares`:
     * the shares changed from the browser's side). Returns the stopping.
     *
     * @param {(event: string) => void} fn
     */
    onEvent(fn) {
        this.#onEvent.add(fn);
        return () => this.#onEvent.delete(fn);
    }

    /** Whether anything holds the extension now. */
    get held() {
        return this.#holds > 0;
    }

    /** @param {boolean} running */
    async #tell(running) {
        if (this.status === "absent" || this.status === "outdated") return;
        await this.call("turn", { running }).catch(() => {});
    }

    /** The open port, or one opened and greeted: each id tried in turn
     *  until one answers. */
    #port() {
        if (this.#open !== null) return Promise.resolve(this.#open.port);
        this.#opening ??= this.#connect().finally(() => {
            this.#opening = null;
        });
        return this.#opening;
    }

    async #connect() {
        if (this.runtime === null || typeof this.runtime.connect !== "function") {
            this.status = "absent";
            throw new ExtensionError("absent", "the studio's browser extension isn't installed");
        }
        for (const id of this.ids) {
            /** @type {chrome.runtime.Port} */
            let port;
            try {
                port = this.runtime.connect(id);
            } catch {
                continue; // not an id at all (a typo in the one the person set)
            }
            this.#listen(port, id);
            /** @type {any} */
            let hello;
            try {
                hello = await this.#send(port, "hello", { protocol: PROTOCOL });
            } catch (e) {
                if (e instanceof ExtensionError && e.code === "protocol") {
                    this.status = "outdated";
                    this.problem = e.message;
                    throw e;
                }
                continue; // no extension under this id
            }
            this.#open = { port, id };
            this.status = "found";
            this.version = typeof hello?.version === "string" ? hello.version : null;
            this.problem = null;
            if (this.#holds > 0) void this.call("turn", { running: true }).catch(() => {});
            for (const f of this.#onOpen) f();
            return port;
        }
        this.status = "absent";
        throw new ExtensionError("absent", "the studio's browser extension isn't installed");
    }

    /** @param {chrome.runtime.Port} port @param {string} id */
    #listen(port, id) {
        port.onMessage.addListener((/** @type {any} */ msg) => {
            if (typeof msg?.event === "string" && msg.id === undefined) {
                for (const f of this.#onEvent) f(msg.event);
                return;
            }
            const w = this.#waiting.get(msg?.id);
            if (w === undefined) return;
            this.#waiting.delete(msg.id);
            if (msg.error) w.no(new ExtensionError(String(msg.error.code), String(msg.error.message)));
            else w.ok(msg.value);
        });
        port.onDisconnect.addListener(() => {
            // read, so Chrome doesn't report it unchecked
            void this.runtime?.lastError;
            if (this.#open?.port === port) this.#open = null;
            for (const [key, w] of this.#waiting) {
                if (w.port !== port) continue;
                this.#waiting.delete(key);
                w.no(new ExtensionError("disconnected", `the port to the extension (${id}) closed`));
            }
        });
    }

    /** @param {chrome.runtime.Port} port @param {string} op @param {Record<string, unknown>} args */
    #send(port, op, args) {
        return new Promise((ok, no) => {
            const id = ++this.#next;
            this.#waiting.set(id, { ok, no, port });
            try {
                port.postMessage({ id, op, ...args });
            } catch (e) {
                this.#waiting.delete(id);
                no(new ExtensionError("disconnected", e instanceof Error ? e.message : String(e)));
            }
        });
    }
}

/** This page's extension. */
export const browserExtension = new BrowserExtension({
    runtime: /** @type {any} */ (globalThis).chrome?.runtime,
    ids: candidateIds(typeof localStorage === "undefined" ? undefined : localStorage),
});

if (typeof document !== "undefined") {
    void browserExtension.detect();
    // the port, dropped while the tab was away, opened again on its return
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") void browserExtension.detect();
    });
}
