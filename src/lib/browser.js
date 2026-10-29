/**
 * The agent's browser: a session's tabs, reached through the studio's
 * extension (`browser-extension.svelte.js`), for the `browser` tool and
 * the `browser` host object alike.
 *
 * Tabs belong to the top session: a delegate's calls are its top
 * session's, so a tab it opens outlives it, and a delegate resumed later
 * finds it again. Each read of a tab gives an outline with a version, and
 * an action names the version of the outline its ref came from, which
 * each caller keeps for itself (the tool for its session, code with its
 * tab): an action on a page that changed since, or read by someone else
 * since, is refused rather than landing on whatever now sits at that ref.
 */

import { ExtensionError, browserExtension } from "./browser-extension.svelte.js";

/** The top session of `session` (a delegate's is its parent's, up).
 *  @param {string} session */
export const topOf = (session) => session.split(".")[0];

/**
 * @typedef {{ id: number, url: string, title: string, working: boolean, blocked?: { url: string, at: number, newTab?: boolean } }} TabInfo
 * @typedef {{ version: number, url: string, title: string, blocker: "captcha" | "bot-check" | null, refs: number, text: string, cut?: number, below?: number, loading?: true, settled?: false, blocked?: { url: string, at: number } }} Outline
 * @typedef {{ url: string, title: string, navigated?: true, submitted?: true, loading?: true, blocked?: { url: string, at: number }, chosen?: string }} ActResult
 */

export class Browser {
    /** @param {import("./browser-extension.svelte.js").BrowserExtension} extension */
    constructor(extension) {
        this.extension = extension;
    }

    /** Whether the extension is here to reach tabs through. */
    get available() {
        return this.extension.status === "found";
    }

    /** @param {string} session @returns {Promise<TabInfo[]>} */
    tabs(session) {
        return this.extension.call("tabs", { session: topOf(session) });
    }

    /** A tab opened on `url`, in the background. @param {string} session @param {string} url
     *  @returns {Promise<number>} */
    async open(session, url) {
        const { tab } = await this.extension.call("open", { session: topOf(session), url });
        return tab;
    }

    /** The tab brought to the front, for the person's hands.
     *  @param {string} session @param {number} tab */
    async show(session, tab) {
        await this.extension.call("show", { session: topOf(session), tab });
    }

    /** @param {string} session @param {number} tab */
    async close(session, tab) {
        await this.extension.call("close", { session: topOf(session), tab });
    }

    /** The tab's page as an outline, with its version, which the actions
     *  on its refs name; `settle` waits for its text to stop changing first.
     *  @param {string} session @param {number} tab
     *  @param {{ maxChars?: number, hrefs?: boolean, settle?: boolean | number }} [opts] @returns {Promise<Outline>} */
    read(session, tab, opts = {}) {
        return this.extension.call("read", { session: topOf(session), tab, ...opts });
    }

    /** @param {string} session @param {number} tab @param {string} url
     *  @returns {Promise<{ url: string, title: string, loading?: true }>} */
    goto(session, tab, url) {
        return this.extension.call("goto", { session: topOf(session), tab, url });
    }

    /** @param {string} session @param {number} tab
     *  @param {{ text?: string, selector?: string, timeout?: number }} what @returns {Promise<{ ms: number }>} */
    waitFor(session, tab, what) {
        return this.extension.call("waitFor", { session: topOf(session), tab, ...what });
    }

    /** The page scrolled with the wheel: a screenful down, or to the bottom.
     *  @param {string} session @param {number} tab @param {"down" | "bottom"} to
     *  @returns {Promise<{ top: number, below: number }>} */
    scroll(session, tab, to) {
        return this.extension.call("scroll", { session: topOf(session), tab, to });
    }

    /** The person's cancel of the agent's work (Chrome's debugging bar)
     *  lifted, on their word. */
    async resume() {
        await this.extension.call("resume");
    }

    /** @param {string} session @param {number} tab @returns {Promise<{ mime: string, data: string }>} */
    screenshot(session, tab) {
        return this.extension.call("screenshot", { session: topOf(session), tab });
    }

    /**
     * An action on the element at `ref` of outline `version` of the tab
     * (the caller's own latest read): `click`, `type` (`text`, `submit`,
     * `clear`) or `select` (`value`). `confirmed` only for a step the
     * person has confirmed.
     *
     * @param {string} session @param {number} tab @param {"click" | "type" | "select"} op
     * @param {number | undefined} version @param {number} ref @param {Record<string, unknown>} [args]
     * @param {{ confirmed?: boolean }} [opts]
     * @returns {Promise<ActResult>}
     */
    act(session, tab, op, version, ref, args = {}, { confirmed = false } = {}) {
        if (version === undefined) return Promise.reject(new ExtensionError("stale", `tab ${tab} hasn't been read here yet; read it first`));
        return this.extension.call(op, { session: topOf(session), tab, version, ref, ...args, ...(confirmed && { confirmed: true }) });
    }
}

/** This page's browser. */
export const browser = new Browser(browserExtension);
