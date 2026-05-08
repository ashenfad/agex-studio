/**
 * Kernel registry — lazy-boot orchestration for the unified studio.
 *
 * The studio holds at most one adapter per kernel ('py' | 'ts').
 * Adapters are constructed and initialized on first need, not at
 * page load. A user with only py sessions never pays the Ts-worker
 * cost; a user with only ts sessions never pays the Pyodide cost.
 * Mixed-kernel users warm a kernel only when they engage with one
 * of its sessions.
 *
 * Concurrent `ensure(kernel, ...)` callers share one in-flight init
 * promise — no double-boot. Settings handed to the FIRST caller win
 * for that kernel's lifetime; later callers' settings are ignored
 * (matches today's studio: settings-change-without-reload isn't
 * supported, and rebuilding the agent on every settings update would
 * thrash Pyodide / the Ts worker).
 *
 * `onStage` listeners fan out: each caller's `opts.onStage` is added
 * to a per-kernel listener set, and the registry wraps the adapter's
 * `init` with a dispatcher that calls every registered listener for
 * every milestone. Live-stream-only — listeners that register *after*
 * a stage has fired don't get a replay; if a caller cares about a
 * past milestone, check the shell-side flag whichever earlier
 * listener set rather than rely on the registry's stage stream.
 *
 * Singleton instance is exported as `kernelRegistry`. The factory
 * (`createKernelRegistry`) is exported for tests that want isolated
 * instances.
 */

import { createPyAdapter } from "./py-kernel-adapter.js";
import { createTsAdapter } from "./ts-kernel-adapter.js";

/**
 * @typedef {import('./kernel-adapter.js').KernelAdapter} KernelAdapter
 * @typedef {import('./kernel-adapter.js').KernelSettings} KernelSettings
 * @typedef {import('./kernel-adapter.js').InitOptions} InitOptions
 */

/**
 * @typedef {'py' | 'ts'} Kernel
 */

/**
 * @typedef {Object} KernelRegistry
 * @property {(kernel: Kernel, settings: KernelSettings, opts?: InitOptions) => Promise<KernelAdapter>} ensure
 *   Boot `kernel` if not already booted, then return its adapter. Safe
 *   to call concurrently — second caller waits on the first's init
 *   promise instead of starting a parallel boot.
 * @property {(kernel: Kernel) => boolean} has
 *   Check whether `kernel` has been booted (or is booting). Doesn't
 *   trigger a boot. Useful for "should I render this kernel's badge
 *   in the drawer right now" checks.
 * @property {(kernel: Kernel) => KernelAdapter | null} get
 *   Return the booted adapter for `kernel`, or `null` if not yet
 *   booted. Doesn't trigger a boot or wait on init — caller should
 *   only use the returned adapter after a prior `ensure` resolved
 *   (or for inspection only).
 * @property {() => Promise<void>} dispose
 *   Tear down all booted adapters. After this resolves the registry
 *   is empty and a fresh `ensure` will boot anew.
 */

/**
 * Construct an isolated registry instance. Most code should use the
 * exported `kernelRegistry` singleton instead — this factory is
 * primarily for tests.
 *
 * @returns {KernelRegistry}
 */
export function createKernelRegistry() {
    /**
     * @type {Map<Kernel, { adapter: KernelAdapter, ready: Promise<void>, onStageListeners: Set<(stage: import('./kernel-adapter.js').InitStage) => void | Promise<void>> }>}
     */
    const entries = new Map();

    function _construct(kernel) {
        if (kernel === "py") return createPyAdapter();
        if (kernel === "ts") return createTsAdapter();
        throw new Error(`unknown kernel: ${String(kernel)}`);
    }

    return {
        async ensure(kernel, settings, opts = {}) {
            let entry = entries.get(kernel);
            if (!entry) {
                const adapter = _construct(kernel);
                // Per-kernel listener set; first caller seeds it,
                // subsequent callers append. Wrap init's onStage
                // option with a dispatcher that fans every milestone
                // out to whatever listeners are registered AT FIRE
                // TIME (not at registration time — late-registered
                // listeners only see future stages).
                const onStageListeners = new Set();
                if (typeof opts.onStage === "function") {
                    onStageListeners.add(opts.onStage);
                }
                const dispatchStage = async (stage) => {
                    // Snapshot: a listener could (in theory) register
                    // another during dispatch. Iterate the snapshot to
                    // keep the milestone's notify list deterministic.
                    for (const fn of [...onStageListeners]) {
                        try {
                            await fn(stage);
                        } catch (err) {
                            console.warn(
                                "[agex] kernel-registry onStage listener threw:",
                                err,
                            );
                        }
                    }
                };
                // Capture ready before awaiting — concurrent callers
                // see the same in-flight promise.
                const ready = adapter.init(settings, { onStage: dispatchStage });
                entry = { adapter, ready, onStageListeners };
                entries.set(kernel, entry);
                // If init throws, evict the entry so a future caller
                // can retry with a fresh adapter rather than being
                // stuck on a dead promise.
                ready.catch(() => {
                    if (entries.get(kernel) === entry) {
                        entries.delete(kernel);
                    }
                });
            } else if (typeof opts.onStage === "function") {
                // Subsequent caller — append to the existing listener
                // set. Stages fired before this point won't be replayed.
                entry.onStageListeners.add(opts.onStage);
            }
            await entry.ready;
            return entry.adapter;
        },

        has(kernel) {
            return entries.has(kernel);
        },

        get(kernel) {
            return entries.get(kernel)?.adapter ?? null;
        },

        async dispose() {
            const all = [...entries.values()];
            entries.clear();
            await Promise.all(
                all.map((e) =>
                    e.adapter
                        .dispose()
                        .catch((err) =>
                            console.warn(
                                "[agex] kernel adapter dispose failed:",
                                err,
                            ),
                        ),
                ),
            );
        },
    };
}

/** Process-wide singleton. Call sites import this directly. */
export const kernelRegistry = createKernelRegistry();
