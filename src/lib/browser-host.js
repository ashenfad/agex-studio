/**
 * `browser`, a host object: the session's browser tabs, from run_ts, for
 * searching many sites at once from code (`Promise.all` over the sites,
 * each page read in a variable rather than the agent's context). The
 * `browser` tool is for steps taken one at a time; both work in the same
 * tabs (`browser.js`), the top session's.
 *
 * Code never asks the person: a step that commits (book, pay, send) is
 * refused, as is a domain the session may not open, and the error says so,
 * for code to report back to the agent, which asks (`request_sites`, or
 * the browser tool, whose card asks for the person's yes).
 *
 * Code gets tabs from the stub: `await browser.open(url)` is a tab with
 * `read`, `click`, `type`, `select`, `scroll`, `goto`, `waitFor` and `close`, each
 * a call of the host's with the tab's id. A tab object keeps the version
 * of its latest read, which its actions name: an action on a page read
 * since by anyone else, or changed, is refused as stale.
 */

import { hostFactory, typedHost, withStub } from "@agex-ts/world";
import { z } from "zod";
import { browser as deviceBrowser } from "./browser.js";
import { ExtensionError } from "./browser-extension.svelte.js";
import { errorText } from "./errors.js";

/**
 * The error code gets for a refusal of the extension's: what happened,
 * and what code can do about it.
 *
 * @param {unknown} e
 */
export function codeError(e) {
    const message = errorText(e);
    if (!(e instanceof ExtensionError)) return new Error(message);
    switch (e.code) {
        case "not-granted":
            return new Error(`${message} (not-granted): code can't ask for a site; return this, and the agent asks with request_sites`);
        case "confirm":
            return new Error(`${message} (confirm): code never takes a step that commits; return this, and the agent takes it with the browser tool, which asks the person`);
        case "stale":
            return new Error(`${message} (stale)`);
        case "stopped":
            return new Error(`${message} (stopped): code can't ask; return this, and the agent's next browser tool call asks the person whether to go on`);
        case "absent":
        case "disconnected":
            return new Error(`the browser extension isn't reachable: ${message}`);
        default:
            return new Error(`${message} (${e.code})`);
    }
}

/** The host's half: each method a call of the session's browser, by tab id. */
export class BrowserHost {
    /** @param {string} session the calling workspace's (a delegate's works in its top session's tabs)
     *  @param {import("./browser.js").Browser} browser */
    constructor(session, browser) {
        this._session = session;
        this._browser = browser;
    }

    /** @template T @param {() => Promise<T>} fn */
    async _call(fn) {
        try {
            return await fn();
        } catch (e) {
            throw codeError(e);
        }
    }

    tabs() {
        return this._call(() => this._browser.tabs(this._session));
    }

    /** @param {string} url */
    open(url) {
        return this._call(async () => ({ id: await this._browser.open(this._session, url) }));
    }

    /** @param {number} tab @param {{ maxChars?: number, hrefs?: boolean, settle?: boolean | number }} [opts] */
    read(tab, opts) {
        return this._call(() => this._browser.read(this._session, tab, opts ?? {}));
    }

    /** @param {number} tab @param {number | undefined} version @param {number} ref */
    click(tab, version, ref) {
        return this._call(() => this._browser.act(this._session, tab, "click", version, ref));
    }

    /** @param {number} tab @param {number | undefined} version @param {number} ref @param {string} text @param {{ submit?: boolean, clear?: boolean }} [opts] */
    type(tab, version, ref, text, opts) {
        return this._call(() => this._browser.act(this._session, tab, "type", version, ref, { text, ...opts }));
    }

    /** @param {number} tab @param {number | undefined} version @param {number} ref @param {string} value */
    select(tab, version, ref, value) {
        return this._call(() => this._browser.act(this._session, tab, "select", version, ref, { value }));
    }

    /** @param {number} tab @param {"down" | "bottom"} [to] */
    scroll(tab, to) {
        return this._call(() => this._browser.scroll(this._session, tab, to ?? "down"));
    }

    /** @param {number} tab @param {string} url */
    goto(tab, url) {
        return this._call(() => this._browser.goto(this._session, tab, url));
    }

    /** @param {number} tab @param {{ text?: string, selector?: string, timeout?: number }} what */
    waitFor(tab, what) {
        return this._call(() => this._browser.waitFor(this._session, tab, what));
    }

    /** @param {number} tab */
    close(tab) {
        return this._call(() => this._browser.close(this._session, tab));
    }
}

/** Code's half: tabs as objects, their methods the host's with the tab's id. */
export const STUB = `(remote) => {
    const tab = (id, info) => {
        // the version of this tab object's latest read: its actions' refs are that outline's
        let version;
        return {
            id,
            ...info,
            read: async (opts) => {
                const page = await remote.read(id, opts);
                version = page.version;
                return page;
            },
            click: (ref) => remote.click(id, version, ref),
            type: (ref, text, opts) => remote.type(id, version, ref, text, opts),
            select: (ref, value) => remote.select(id, version, ref, value),
            scroll: (to) => remote.scroll(id, to),
            goto: (url) => remote.goto(id, url),
            waitFor: (what, opts) => remote.waitFor(id, { ...(typeof what === "string" ? { text: what } : what), ...opts }),
            close: () => remote.close(id),
        };
    };
    return {
        open: async (url) => tab((await remote.open(url)).id),
        tabs: async () => (await remote.tabs()).map((t) => tab(t.id, t)),
        tab: (id) => tab(id),
    };
}`;

const id = z.number().int();
const ref = z.number().int().positive();
// undefined for a tab object not read yet, which the host refuses: read it first
const version = z.number().int().optional();
const url = z.string().regex(/^https?:\/\//, "an http or https URL");

/**
 * Make the `browser` host object for a profile's `hostObjects`.
 *
 * @param {{ browser?: import("./browser.js").Browser }} [deps]
 */
export function browserHost({ browser = deviceBrowser } = {}) {
    return withStub(
        typedHost(
            hostFactory((ws) => new BrowserHost(ws.session, browser)),
            {
                tabs: {},
                open: { args: { url } },
                read: {
                    args: {
                        tab: id,
                        opts: z.strictObject({ maxChars: z.number().int().min(100).optional(), hrefs: z.boolean().optional(), settle: z.union([z.boolean(), z.number().int().positive().max(60_000)]).optional() }).optional(),
                    },
                },
                scroll: { args: { tab: id, to: z.enum(["down", "bottom"]).optional() } },
                click: { args: { tab: id, version, ref } },
                type: { args: { tab: id, version, ref, text: z.string(), opts: z.strictObject({ submit: z.boolean().optional(), clear: z.boolean().optional() }).optional() } },
                select: { args: { tab: id, version, ref, value: z.string() } },
                goto: { args: { tab: id, url } },
                waitFor: {
                    args: {
                        tab: id,
                        what: z.strictObject({ text: z.string().optional(), selector: z.string().optional(), timeout: z.number().int().min(0).max(60_000).optional() }),
                    },
                },
                close: { args: { tab: id } },
            },
        ),
        STUB,
    );
}
