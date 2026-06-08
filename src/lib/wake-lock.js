/**
 * Screen wake-lock manager.
 *
 * Holds a `navigator.wakeLock` screen sentinel while it's *desired* (the
 * studio sets desired = "keep-awake setting on" AND "a session has a turn
 * in flight"). The browser auto-releases the lock when the tab is hidden,
 * so we re-acquire on `visibilitychange` when it becomes visible again.
 *
 * Imperative singleton (no runes) so it can be driven from a plain
 * `$effect` in the shell: `setWakeLockDesired(keepAwake && anyTurnActive)`.
 * Scope honesty: this keeps the *screen* on while the tab is *visible*;
 * it cannot keep a device awake once the user switches tabs/apps (the
 * platform releases it), so it's "don't dim while I'm watching a long
 * turn," not a background keep-alive.
 */

let _desired = false;
/** @type {WakeLockSentinel | null} */
let _sentinel = null;
/** Serializes `_sync` runs. `_sync` awaits across `request()` / `release()`,
 *  so overlapping calls could each observe `_sentinel === null` mid-request
 *  and acquire duplicate locks — leaking every sentinel but the last and
 *  draining the battery. Chaining through one promise makes reconciliation
 *  strictly sequential; the `.catch` keeps a stray rejection from wedging
 *  the chain (though `_sync` already swallows acquire/release errors). */
let _syncChain = Promise.resolve();

function _scheduleSync() {
    _syncChain = _syncChain.then(_sync).catch(() => {});
}

function _supported() {
    return typeof navigator !== "undefined" && "wakeLock" in navigator;
}

export function wakeLockSupported() {
    return _supported();
}

/** Reconcile the held sentinel with what's desired + current visibility. */
async function _sync() {
    if (!_supported()) return;
    const shouldHold =
        _desired &&
        typeof document !== "undefined" &&
        document.visibilityState === "visible";
    if (shouldHold && _sentinel === null) {
        try {
            _sentinel = await navigator.wakeLock.request("screen");
            // The platform may release it (tab hide, power policy); drop
            // our handle so the next _sync re-acquires when appropriate.
            _sentinel.addEventListener("release", () => {
                _sentinel = null;
            });
        } catch {
            // Acquire can reject (e.g. not visible, denied) — stay unheld;
            // a later _sync retries.
            _sentinel = null;
        }
    } else if (!shouldHold && _sentinel !== null) {
        const s = _sentinel;
        _sentinel = null;
        try {
            await s.release();
        } catch {
            // ignore
        }
    }
}

/** Set whether the screen should be kept awake. Idempotent. */
export function setWakeLockDesired(desired) {
    _desired = !!desired;
    _scheduleSync();
}

// Re-acquire after the browser auto-releases on tab hide / restore.
if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", _scheduleSync);
}
