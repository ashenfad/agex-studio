/**
 * The registry: each top session the studio has told the extension
 * about (its name and granted origins), the tabs that are its, and the
 * tab each window shows.
 *
 * It lives in `chrome.storage.session`, which outlives the service
 * worker's stops (the worker stops whenever it's idle) and is cleared
 * when the browser closes, as tab ids are. Every change goes through
 * `change`, one at a time, so two calls never read the same state and
 * write over each other.
 */

/**
 * @typedef {{ name: string, origins: string[] }} Session
 * @typedef {{ url: string, at: number, newTab?: boolean }} Blocked
 *   The last load the extension stopped in a tab: a page load to an
 *   origin without a grant, or a tab the page opened there, closed.
 * @typedef {{ session: string, opened?: boolean, blocked?: Blocked }} Tab
 *   `opened`: a tab one of the session's pages opened.
 * @typedef {{ sessions: Record<string, Session>, tabs: Record<string, Tab>, windows: Record<string, number[]> }} State
 *   `windows`: the tabs each window has shown in front, the latest last.
 */

const KEY = "registry";

/** @returns {Promise<State>} */
export async function read() {
    const got = await chrome.storage.session.get(KEY);
    return { sessions: {}, tabs: {}, windows: {}, .../** @type {Partial<State> | undefined} */ (got[KEY]) };
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
        await chrome.storage.session.set({ [KEY]: state });
        return value;
    });
    queue = run.catch(() => {});
    return run;
}
