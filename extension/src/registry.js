/**
 * The registry: each top session the studio has told the extension
 * about (its name and granted domains), the tabs that are its, and the
 * tabs and windows the person has had in front.
 *
 * Sessions and tabs are kept in `chrome.storage.local`, which outlives
 * the service worker's stops (it stops whenever it's idle) and the
 * extension's own updates and reloads, which leave its tabs open; the
 * worker clears them when the browser starts, since tab ids don't
 * outlive it. What was in front is only a guide to giving the front
 * back, so it stays in `chrome.storage.session`. Every change goes
 * through `change`, one at a time, so two calls never read the same
 * state and write over each other.
 */

/**
 * @typedef {{ name: string, domains: string[] }} Session
 * @typedef {{ url: string, at: number, newTab?: boolean }} Blocked
 *   The last load the extension stopped in a tab: a page load to an
 *   domain without a grant, or a tab the page opened there, closed.
 * @typedef {{ session: string, opened?: boolean, opener?: number, shared?: Shared, blocked?: Blocked, reads?: number }} Tab
 *   `opened`: a tab one of the session's pages opened, from the tab
 *   `opener`. `shared`: a tab of the person's they shared with the
 *   session, to read. `reads`: how many outlines of it have been read,
 *   the last one's version.
 * @typedef {{ domain: string, at: number }} Shared
 *   A share covers the host the tab was on when shared (its subdomains
 *   with it, and for a `www.` host the bare one): elsewhere, it isn't
 *   read. `at`, when it was shared, tells this share from a later one.
 * @typedef {{
 *   sessions: Record<string, Session>,
 *   tabs: Record<string, Tab>,
 *   windows: Record<string, number[]>,
 *   focused: number[],
 * }} State
 *   `windows`: the tabs each window has shown in front, the latest last.
 *   `focused`: the windows that have had the focus, the latest last.
 */

const KEY = "registry";

/** @returns {Promise<State>} */
export async function read() {
    const [kept, shown] = await Promise.all([chrome.storage.local.get(KEY), chrome.storage.session.get(KEY)]);
    return {
        sessions: {},
        tabs: {},
        windows: {},
        focused: [],
        .../** @type {Partial<State> | undefined} */ (kept[KEY]),
        .../** @type {Partial<State> | undefined} */ (shown[KEY]),
    };
}

/** @param {State} state */
async function write({ sessions, tabs, windows, focused }) {
    await Promise.all([
        chrome.storage.local.set({ [KEY]: { sessions, tabs } }),
        chrome.storage.session.set({ [KEY]: { windows, focused } }),
    ]);
}

/** @type {Promise<unknown>} */
let queue = Promise.resolve();

/**
 * Run `fn` on the registry once every change before it is done, and keep
 * what it leaves in `state`. Whatever else `fn` does (rules, groups)
 * happens inside the turn too, so it sees the state it changes.
 *
 * @template T
 * @param {(state: State) => Promise<T> | T} fn
 * @returns {Promise<T>}
 */
export function change(fn) {
    const run = queue.then(async () => {
        const state = await read();
        const value = await fn(state);
        await write(state);
        return value;
    });
    queue = run.catch(() => {});
    return run;
}
