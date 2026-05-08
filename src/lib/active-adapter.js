/**
 * `getActiveAdapter` — resolve the kernel adapter for the currently
 * active session.
 *
 * The studio shell exposes a "current session" via `sessionStore`.
 * Most kernel-touching call sites (FileDrawer, AppPreview, etc.)
 * operate on that active session; this helper centralizes the
 * (kernel, branch, adapter) lookup so individual components don't
 * each re-derive it.
 *
 * Side-effecting: calls `kernelRegistry.ensure(...)`, which lazy-boots
 * the kernel if it hasn't started yet. Most call sites fire after
 * ChatShell has already booted the kernel, so this is a no-op fast
 * path; cold-start callers (cache-only drawer renders, etc.) get the
 * boot here.
 *
 * Reads `sessionStore` and `settingsStore` synchronously via
 * `svelte/store`'s `get` — adequate for the imperative call sites
 * that use this helper. Reactive consumers should subscribe to those
 * stores directly and call this helper from event handlers.
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
 * Resolve and return the adapter + branch for whatever session is
 * currently active. Boots the kernel if needed.
 *
 * The branch is captured at call time — if the user switches sessions
 * mid-flight, subsequent adapter calls in the same handler still
 * target the original branch (which is what the user would expect:
 * the operation they started on session X lands on session X).
 *
 * Prefers `kernelRegistry.get(kernel)` over `ensure(...)` so callers
 * inside an adapter's own init flow (notably ChatShell's onStage
 * callback that fires from inside `kernelRegistry.ensure`) don't
 * deadlock awaiting the init promise that just called them. The
 * adapter is already constructed at that point — only its init is
 * mid-flight, and the methods called from onStage operate against
 * post-Wave-2 state which is already live by then. Callers from
 * outside any init flow get the ensure() fast path on cold start.
 *
 * @returns {Promise<ActiveAdapter>}
 */
export async function getActiveAdapter() {
    const ss = get(sessionStore);
    const branch = ss.currentBranch;
    const session = ss.sessions.find((s) => s.branch === branch);
    const kernel = /** @type {'py' | 'ts'} */ (session?.kernel || "py");
    let adapter = kernelRegistry.get(kernel);
    if (!adapter) {
        adapter = await kernelRegistry.ensure(kernel, get(settingsStore));
    }
    return { adapter, branch, kernel };
}
