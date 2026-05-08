/**
 * Adapter-resolver helpers — the single chokepoint for "give me the
 * adapter for kernel X" across the studio shell.
 *
 * Why a shared helper: two earlier bugs (one in `getActiveAdapter`,
 * one in sessions.js's `_adapterEnsure`) had the same shape — a
 * caller fired from inside `kernelRegistry.ensure(...)`'s onStage
 * callback re-entered `ensure(...)` and deadlocked awaiting its own
 * init promise. The fix is the same in both cases: prefer the sync
 * `get()` (returns the constructed adapter even mid-init) over the
 * awaiting `ensure()`. Centralizing here means the deadlock-avoidance
 * lives in one place; future callers can't accidentally regress.
 *
 * Reads `sessionStore` and `settingsStore` synchronously via
 * `svelte/store`'s `get` — adequate for the imperative call sites
 * that use these helpers. Reactive consumers should subscribe to
 * those stores directly and call from event handlers.
 */

import { get } from "svelte/store";
import { kernelRegistry } from "./kernel-registry.js";
import { sessionStore } from "./sessions.js";
import { settingsStore } from "./settings.js";

/**
 * @typedef {import('./kernel-adapter.js').KernelAdapter} KernelAdapter
 */

/**
 * @typedef {Object} ActiveAdapter
 * @property {KernelAdapter} adapter
 * @property {string} branch - Current session's branch (snapshot at call time).
 * @property {'py' | 'ts'} kernel
 */

/**
 * Resolve the adapter for a specific kernel. Boots if not already
 * booted; returns the existing adapter if it is — including
 * mid-init (the adapter is constructed synchronously, only its
 * `init()` promise is in flight). The mid-init fast path is what
 * makes this safe to call from inside an onStage callback.
 *
 * @param {'py' | 'ts'} kernel
 * @returns {Promise<KernelAdapter>}
 */
export async function resolveAdapter(kernel) {
    const existing = kernelRegistry.get(kernel);
    if (existing) return existing;
    return kernelRegistry.ensure(kernel, get(settingsStore));
}

/**
 * Resolve and return the adapter + branch for whatever session is
 * currently active. Boots the kernel if needed.
 *
 * The branch is captured at call time — if the user switches sessions
 * mid-flight, subsequent adapter calls in the same handler still
 * target the original branch (which is what the user would expect:
 * the operation they started on session X lands on session X).
 *
 * @returns {Promise<ActiveAdapter>}
 */
export async function getActiveAdapter() {
    const ss = get(sessionStore);
    const branch = ss.currentBranch;
    const session = ss.sessions.find((s) => s.branch === branch);
    const kernel = /** @type {'py' | 'ts'} */ (session?.kernel || "py");
    const adapter = await resolveAdapter(kernel);
    return { adapter, branch, kernel };
}
