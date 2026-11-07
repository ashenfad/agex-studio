/**
 * The kernel's worker, where the sandbox can start one. The world asks
 * for a module worker (`{ type: "module" }`), and a page whose origin is
 * opaque can't start one from a blob URL; a classic one it can. The
 * kernel's worker, bundled whole by the build, holds no `import`,
 * `export` or `import.meta` (the build refuses one that does), so it runs
 * as a classic script.
 *
 * A stand-in until the world takes the worker's type as an option.
 */

/** Start every worker from a blob URL as a classic one. */
export function classicBlobWorkers() {
    const Native = globalThis.Worker;
    globalThis.Worker = class extends Native {
        /** @param {string | URL} url @param {WorkerOptions} [opts] */
        constructor(url, opts) {
            super(url, String(url).startsWith("blob:") && opts?.type === "module" ? { ...opts, type: "classic" } : opts);
        }
    };
}

/**
 * A blob URL of the kernel's worker, from its source (which the
 * offscreen document hands over: the sandbox can't fetch).
 *
 * @param {string} source
 */
export function workerUrl(source) {
    return URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
}
