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
// ts-kernel-adapter is dynamic-imported below so the agex-ts chunk
// only loads when a user actually engages with a TS session. Keeps
// cold-start payload small for py-only users — matches the
// lazy-boot story for the kernel itself.

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

    // Construction is split inline in `ensure` below: py is sync (no
    // dynamic import) so it sets the entry before any await — preserves
    // the sync-construct-then-init dedup timing the original tests
    // expect. ts is async (chunk-split via dynamic import so the
    // agex-ts bundle only ships when a user actually opens a TS
    // session) and uses a placeholder-entry pattern that's race-
    // correct under async construct.

    return {
        async ensure(kernel, settings, opts = {}) {
            let entry = entries.get(kernel);
            if (!entry) {
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

                if (kernel === "py") {
                    // Synchronous construct — set entry before any
                    // await so concurrent callers see it on their
                    // `entries.get` check.
                    const adapter = createPyAdapter();
                    const ready = adapter.init(settings, { onStage: dispatchStage });
                    entry = { adapter, ready, onStageListeners };
                    entries.set(kernel, entry);
                    ready.catch(() => {
                        if (entries.get(kernel) === entry) entries.delete(kernel);
                    });
                } else if (kernel === "ts") {
                    // Async construct via dynamic import. Placeholder
                    // pattern: set the entry synchronously with a
                    // ready promise that does the import + init
                    // internally. Concurrent callers see the entry on
                    // their first check; the adapter slot stays null
                    // until construction resolves.
                    const placeholder = {
                        /** @type {any} */ adapter: null,
                        /** @type {Promise<void>} */ ready: /** @type {any} */ (null),
                        onStageListeners,
                    };
                    placeholder.ready = (async () => {
                        const { createTsAdapter } = await import("./ts-kernel-adapter.js");
                        const adapter = createTsAdapter();
                        placeholder.adapter = adapter;
                        await adapter.init(settings, { onStage: dispatchStage });
                    })();
                    entries.set(kernel, placeholder);
                    placeholder.ready.catch(() => {
                        if (entries.get(kernel) === placeholder) {
                            entries.delete(kernel);
                        }
                    });
                    entry = placeholder;
                } else {
                    throw new Error(`unknown kernel: ${String(kernel)}`);
                }
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
                all.map(async (e) => {
                    // Wait out any in-flight construction before
                    // disposing, so we don't leak a half-constructed
                    // adapter. Tolerate construction failures (the
                    // catch handler in ensure() already evicts the
                    // entry, but dispose may race with that).
                    try {
                        await e.ready;
                    } catch {
                        return;
                    }
                    if (!e.adapter) return;
                    try {
                        await e.adapter.dispose();
                    } catch (err) {
                        console.warn(
                            "[agex] kernel adapter dispose failed:",
                            err,
                        );
                    }
                }),
            );
        },
    };
}

/** Process-wide singleton. Call sites import this directly. */
export const kernelRegistry = createKernelRegistry();
