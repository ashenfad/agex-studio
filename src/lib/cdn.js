/**
 * The third-party code the studio itself loads at runtime, each pinned
 * to an exact release: what's at these URLs runs on the studio's own
 * origin, so none of them floats to a newer version unseen.
 *
 * Each is fetched on first use, never at startup, through `loadModule`
 * (an ES module, by `import()`) or `loadScript` (a classic script that
 * sets a global). Both share one load among every caller that asks
 * while it's under way or after it's done, and forget a load that
 * failed, so a later call tries again.
 */

/** Mermaid, which draws a reply's ```mermaid blocks. */
export const MERMAID_URL = "https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.esm.min.mjs";

const PDFJS = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build";
/** pdf.js, which the `pdf` host reads and renders PDFs with. */
export const PDFJS_URL = `${PDFJS}/pdf.min.mjs`;
/** pdf.js's worker, the same release as pdf.js itself. */
export const PDFJS_WORKER_URL = `${PDFJS}/pdf.worker.min.mjs`;

/** Plotly, a classic script setting `window.Plotly`, which draws a
 *  reply's embedded `.plotly.json` charts. */
export const PLOTLY_URL = "https://cdn.plot.ly/plotly-2.35.2.min.js";

const ESBUILD_VERSION = "0.24.2";
/** esbuild-wasm, which bundles an agent's app. */
export const ESBUILD_URL = `https://esm.sh/esbuild-wasm@${ESBUILD_VERSION}`;
/** esbuild's WebAssembly binary, the same release as its module. */
export const ESBUILD_WASM_URL = `https://esm.sh/esbuild-wasm@${ESBUILD_VERSION}/esbuild.wasm`;

/** Each URL's load, under way or done; one that fails is dropped.
 *  @type {Map<string, Promise<any>>} */
const loads = new Map();

/**
 * The value `start` resolves to, started only once for `url`: a later
 * call while it's under way, or after it succeeded, gets the same
 * promise; one after it failed starts again.
 *
 * @template T
 * @param {string} url
 * @param {() => Promise<T>} start
 * @returns {Promise<T>}
 */
function once(url, start) {
    let load = loads.get(url);
    if (load === undefined) {
        load = start();
        loads.set(url, load);
        load.catch(() => {
            if (loads.get(url) === load) loads.delete(url);
        });
    }
    return load;
}

/** How a module is imported; tests stand in their own. @type {(url: string) => Promise<any>} */
let importer = (url) => import(/* @vite-ignore */ url);

/**
 * The ES module at `url`, imported once, passed through `setup` (which
 * runs once, on the first load that succeeds) to give what callers
 * get: a library's configured instance, say. A URL has one setup: the
 * first caller's.
 *
 * @template [T=any]
 * @param {string} url
 * @param {(mod: any) => T} [setup]
 * @returns {Promise<T>}
 */
export function loadModule(url, setup = (mod) => mod) {
    return once(url, async () => setup(await importer(url)));
}

/**
 * The global a classic script at `url` sets (`window[name]`), its
 * `<script>` added to the document's head once. When the global is
 * already there, nothing is added. A script that fails to load, or
 * loads without setting the global, is removed again.
 *
 * @param {string} url
 * @param {string} name
 * @returns {Promise<any>}
 */
export function loadScript(url, name) {
    const win = /** @type {any} */ (window);
    if (win[name] !== undefined) return Promise.resolve(win[name]);
    return once(
        url,
        () =>
            new Promise((resolve, reject) => {
                const script = document.createElement("script");
                script.src = url;
                script.onload = () => {
                    if (win[name] !== undefined) return resolve(win[name]);
                    script.remove();
                    reject(new Error(`${url} loaded but set no ${name}`));
                };
                script.onerror = () => {
                    script.remove();
                    reject(new Error(`${url} didn't load`));
                };
                document.head.appendChild(script);
            }),
    );
}

/** Test seam: how `loadModule` imports (null restores `import()`), and
 *  every load forgotten. @param {((url: string) => Promise<any>) | null} fake */
export function _setImporterForTesting(fake) {
    importer = fake ?? ((url) => import(/* @vite-ignore */ url));
    loads.clear();
}
