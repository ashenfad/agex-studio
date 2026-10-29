/**
 * Working in a tab: the debugger attached, with focus emulation on, for
 * as long as the agent keeps working in it, and detached once it has
 * rested a while.
 *
 * A background tab is hidden, and a hidden tab draws nothing that waits
 * for a frame (many sites draw their results that way) and drops the
 * debugger's mouse events. Focus emulation makes it visible without
 * bringing it to the front. While any tab is attached, Chrome shows its
 * "started debugging this browser" bar, so the extension attaches only
 * while it works, and marks the tab it works in (its title starts with
 * `MARK`). Cancel on that bar stops the agent's work in every tab until
 * the next turn (`stopped`).
 */

import { ProtocolError } from "./protocol.js";

/** What the title of a tab the agent is working in starts with. */
export const MARK = "🤖 ";

/** How long a tab stays attached after the agent's last call in it. */
export const REST_MS = 20_000;

/** The isolated world the extension's code runs in, in each page. */
const WORLD = "agex";

/**
 * The tabs worked in: each one's attaching (awaited by every call that
 * comes while it is under way, so two never attach at once) and the
 * timer that rests it.
 *
 * @type {Map<number, { ready: Promise<void>, timer?: ReturnType<typeof setTimeout> }>}
 */
const working = new Map();

/** Whether the person cancelled the debugger this turn. The worker
 *  stays up while a turn runs (the studio's heartbeat), so memory is
 *  enough. */
let stopped = false;

/**
 * The debugger attached to `tab`, and focus emulation on, if they
 * weren't; and the tab's rest put off.
 *
 * @param {number} tab
 */
export async function work(tab) {
    if (stopped) {
        throw new ProtocolError("stopped", "the person cancelled the agent's work in the browser; ask them before going on");
    }
    let entry = working.get(tab);
    if (entry === undefined) {
        const ready = attach(tab);
        entry = { ready };
        working.set(tab, entry);
        ready.catch(() => {
            if (working.get(tab)?.ready === ready) working.delete(tab);
        });
    }
    await entry.ready;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => void rest(tab), REST_MS);
    await mark(tab);
}

/** @param {number} tab */
async function attach(tab) {
    try {
        await chrome.debugger.attach({ tabId: tab }, "1.3");
    } catch (e) {
        throw new ProtocolError("failed", `can't work in tab ${tab}: ${e instanceof Error ? e.message : String(e)}`);
    }
    await send(tab, "Emulation.setFocusEmulationEnabled", { enabled: true });
}

/**
 * The tab's mark taken off and the debugger detached.
 *
 * @param {number} tab
 */
export async function rest(tab) {
    const entry = working.get(tab);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    working.delete(tab);
    await entry.ready.catch(() => {});
    await inWorld(tab, unmarkPage, [MARK]).catch(() => {});
    await chrome.debugger.detach({ tabId: tab }).catch(() => {});
}

/** Whether the agent is working in `tab` now. @param {number} tab */
export function isWorking(tab) {
    return working.has(tab);
}

/** Every tab rested: a turn has ended. */
export async function restAll() {
    await Promise.all([...working.keys()].map(rest));
}

/** A new turn: the person's cancel holds no longer. */
export function resume() {
    stopped = false;
}

/**
 * Follow the debugger's detaching (a tab closed, or the person's cancel)
 * and, as the worker starts, detach what a stopped worker left attached.
 * Called once, as the worker starts.
 *
 * @param {() => Promise<number[]>} tabs the registry's tabs
 */
export function watchWork(tabs) {
    chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
        if (tabId === undefined) return;
        clearTimeout(working.get(tabId)?.timer);
        working.delete(tabId);
        if (reason === "canceled_by_user") stopped = true;
    });
    void tabs().then((ids) => Promise.all(ids.map((tabId) => chrome.debugger.detach({ tabId }).catch(() => {}))));
}

/**
 * A DevTools protocol command in `tab`, which must be worked in.
 *
 * @param {number} tab @param {string} method @param {object} [params]
 * @returns {Promise<any>}
 */
export function send(tab, method, params = {}) {
    return chrome.debugger.sendCommand({ tabId: tab }, method, params);
}

/**
 * `fn(...args)` run in the tab's page, in the extension's isolated
 * world, and its value. `fn` is sent as its source, so it must be
 * self-contained, and its value must be JSON.
 *
 * @template {(...args: any[]) => any} F
 * @param {number} tab @param {F} fn @param {Parameters<F>} args
 * @returns {Promise<Awaited<ReturnType<F>>>}
 */
export async function inWorld(tab, fn, args) {
    const { frameTree } = await send(tab, "Page.getFrameTree");
    const { executionContextId } = await send(tab, "Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: WORLD });
    const { result, exceptionDetails } = await send(tab, "Runtime.evaluate", {
        contextId: executionContextId,
        expression: `(${fn})(...${JSON.stringify(args)})`,
        awaitPromise: true,
        returnByValue: true,
    });
    if (exceptionDetails) {
        throw new ProtocolError("failed", `in the page: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
    }
    return result.value;
}

/** @param {number} tab */
async function mark(tab) {
    await inWorld(tab, markPage, [MARK]).catch(() => {}); // a page with no document yet is marked on the next call
}

/** @param {string} mark */
function markPage(mark) {
    if (!document.title.startsWith(mark)) document.title = mark + document.title;
}

/** @param {string} mark */
function unmarkPage(mark) {
    if (document.title.startsWith(mark)) document.title = document.title.slice(mark.length);
}
