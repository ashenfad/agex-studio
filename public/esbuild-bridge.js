/**
 * esbuild bridge — runs esbuild-wasm against a JS-side virtual
 * filesystem (the agent's app/ files, passed in as a dict) and
 * returns transformed/bundled output.
 *
 * Architecture:
 * - Loaded lazily on first call (esbuild-wasm is ~10MB).
 * - Bare imports (`react`, `@radix-ui/...`) are marked external and
 *   stay as native ES module imports in the output.  The iframe's
 *   import map (configured in pyodide.js's buildAppHtml) resolves
 *   them to esm.sh at runtime.  This keeps the bundle to just the
 *   agent's local files.
 * - Relative imports (`./Chart.jsx`) are resolved against the file
 *   dict and bundled inline.
 * - Stdin (CSS imports, etc.) NOT supported in this spike — agents
 *   include CSS via <link> tags in their app/index.html instead.
 *
 * Returns a plain JS object suitable for handing back to Python via
 * the JS bridge.
 */

const ESBUILD_VERSION = "0.24.2";
const ESBUILD_URL = `https://esm.sh/esbuild-wasm@${ESBUILD_VERSION}`;
const ESBUILD_WASM_URL = `https://esm.sh/esbuild-wasm@${ESBUILD_VERSION}/esbuild.wasm`;

let _esbuild = null;
let _esbuildPromise = null;

/** Lazily initialize esbuild-wasm.  Cached after first call. */
async function getEsbuild() {
    if (_esbuild) return _esbuild;
    if (_esbuildPromise) return _esbuildPromise;

    _esbuildPromise = (async () => {
        const mod = await import(/* @vite-ignore */ ESBUILD_URL);
        // esm.sh wraps CommonJS modules; the methods sometimes land
        // on the namespace, sometimes on `default`.  Probe both
        // shapes.
        const api =
            typeof mod.initialize === "function" && typeof mod.build === "function"
                ? mod
                : mod.default &&
                    typeof mod.default.initialize === "function" &&
                    typeof mod.default.build === "function"
                  ? mod.default
                  : null;
        if (!api) {
            const keys = Object.keys(mod).join(", ");
            const defaultKeys = mod.default
                ? Object.keys(mod.default).join(", ")
                : "(no default)";
            throw new Error(
                `esbuild-wasm module shape unexpected — neither ` +
                    `mod.{initialize,build} nor mod.default.{initialize,build}. ` +
                    `mod keys: [${keys}], default keys: [${defaultKeys}]`,
            );
        }
        await api.initialize({
            wasmURL: ESBUILD_WASM_URL,
            // worker: false means esbuild runs in the current thread
            // (we're already in a worker; nesting workers is
            // unnecessary and brittle in some browsers).
            worker: false,
        });
        _esbuild = api;
        return api;
    })();
    return _esbuildPromise;
}

/** Plugin: resolve & load against a JS-side file dict.
 *
 * Each path in `files` maps to either:
 * - A source-text string (UTF-8 contents — for `.jsx`, `.tsx`, `.ts`,
 *   `.js`, `.css`, `.json`, `.svg`)
 * - A tagged object `{_binary_b64: <base64 string>}` for images
 *   (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`).  The Python
 *   collector encodes binary VFS files this way; the plugin
 *   decodes to Uint8Array for esbuild's dataurl loader.
 *
 * Relative imports (`./foo.jsx`) are resolved relative to the
 * importer's directory, looked up in `files`.  Bare imports
 * (`react`, `@scope/pkg`) are marked external — they stay as ESM
 * imports in the output and are resolved at runtime via the
 * iframe's import map.
 */
function virtualFsPlugin(files) {
    return {
        name: "agex-vfs",
        setup(build) {
            // Single onResolve covering all paths — order of checks
            // matters.  Entry-points must hit the vfs namespace
            // *before* the bare-import branch can externalize them
            // (the entry path "app/index.jsx" doesn't start with ./
            // or /, so a naive filter would mark it external and
            // esbuild rejects that with "entry point cannot be
            // marked as external").
            build.onResolve({ filter: /.*/ }, (args) => {
                const path = args.path;

                if (args.kind === "entry-point") {
                    // VFS keys never carry a leading slash — strip
                    // one if present so `esbuild /app/index.jsx`
                    // resolves the same as `app/index.jsx`.
                    const normalized = path.startsWith("/") ? path.slice(1) : path;
                    return { path: normalized, namespace: "vfs" };
                }

                // Bare specifier (`react`, `@scope/pkg`, `lodash/fp`):
                // doesn't start with . or /.  Stays external; the
                // iframe's import map resolves it at runtime.
                if (!path.startsWith(".") && !path.startsWith("/")) {
                    return { path, external: true };
                }

                // Relative import — resolve against the importer's
                // directory and route into the vfs namespace.  The
                // split/slice form correctly returns "" for a
                // top-level importer (no slash); the regex form would
                // leave the importer unchanged and produce bogus
                // joins like `index.jsx/Chart.jsx`.
                const importerDir = args.importer
                    ? args.importer.split("/").slice(0, -1).join("/")
                    : "";
                let resolved =
                    path.startsWith("./") || path.startsWith("../")
                        ? joinPath(importerDir, path)
                        : path;
                if (resolved.startsWith("/")) {
                    resolved = resolved.slice(1);
                }
                return { path: resolved, namespace: "vfs" };
            });

            // Load file contents from the dict.  Try the path as-is,
            // then try common extensions, then index.* fallback (as
            // node-style resolution does).
            build.onLoad({ filter: /.*/, namespace: "vfs" }, (args) => {
                const path = args.path;
                const candidate = findInFiles(files, path);
                if (candidate === null) {
                    return {
                        errors: [{ text: `not found in vfs: ${path}` }],
                    };
                }
                const ext = candidate.path.split(".").pop().toLowerCase();
                const content = candidate.content;

                // Binary file (image): tagged dict with base64 payload.
                // Decode to Uint8Array and hand to esbuild's dataurl
                // loader, which inlines as data:image/...;base64,...
                if (
                    content &&
                    typeof content === "object" &&
                    typeof content._binary_b64 === "string"
                ) {
                    const binary = atob(content._binary_b64);
                    const bytes = new Uint8Array(binary.length);
                    for (let i = 0; i < binary.length; i++) {
                        bytes[i] = binary.charCodeAt(i);
                    }
                    return { contents: bytes, loader: "dataurl" };
                }

                // SVG: text source, but inline as a data URL too so
                // `import logo from './logo.svg'` returns a string.
                if (ext === "svg") {
                    return { contents: content, loader: "dataurl" };
                }

                const loader =
                    ext === "jsx" ? "jsx"
                    : ext === "tsx" ? "tsx"
                    : ext === "ts" ? "ts"
                    : ext === "css" ? "css"
                    : ext === "json" ? "json"
                    : "js";
                return { contents: content, loader };
            });
        },
    };
}

/** Try `path`, then `path.{js,jsx,ts,tsx}`, then `path/index.{js,jsx,ts,tsx}`. */
function findInFiles(files, path) {
    if (files[path] != null) return { path, content: files[path] };
    const exts = ["js", "jsx", "ts", "tsx"];
    for (const ext of exts) {
        const p = `${path}.${ext}`;
        if (files[p] != null) return { path: p, content: files[p] };
    }
    for (const ext of exts) {
        const p = `${path}/index.${ext}`;
        if (files[p] != null) return { path: p, content: files[p] };
    }
    return null;
}

/** Naive POSIX-style path join + normalize.  Sufficient for VFS keys
 * (no Windows paths, no symlinks). */
function joinPath(base, rel) {
    const parts = (base + "/" + rel).split("/");
    const out = [];
    for (const part of parts) {
        if (part === "" || part === ".") continue;
        if (part === "..") {
            out.pop();
        } else {
            out.push(part);
        }
    }
    return out.join("/");
}

/**
 * Bundle a virtual file set with esbuild and return the output.
 *
 * @param {Object} args
 * @param {Object<string, string>} args.files - Path → source content map
 * @param {string} args.entryPoint - Entry path within `files`
 * @param {string} [args.format="esm"] - Output format (esm/iife/cjs)
 * @param {string} [args.jsx="automatic"] - JSX transform mode
 * @param {string} [args.jsxImportSource="react"] - JSX runtime source.
 *     Default "react"; the iframe's import map aliases react/jsx-runtime
 *     to preact/jsx-runtime, so agent code can `import` from "react"
 *     end-to-end while running on Preact.
 * @param {boolean} [args.minify=false]
 * @returns {Promise<{contents: string|null, errors: Array, warnings: Array}>}
 */
export async function runEsbuild(args) {
    const {
        files,
        entryPoint,
        format = "esm",
        jsx = "automatic",
        jsxImportSource = "react",
        minify = false,
        sourcemap = "inline",
    } = args;

    const esbuild = await getEsbuild();

    try {
        const result = await esbuild.build({
            entryPoints: [entryPoint],
            bundle: true,
            format,
            jsx,
            jsxImportSource,
            minify,
            // Inline source maps by default — agent stack traces
            // point at the agent's source (app/index.jsx, line 47)
            // instead of the bundled output.  Caller can pass
            // sourcemap: false (or "external" / "linked") to override.
            sourcemap,
            write: false,
            plugins: [virtualFsPlugin(files)],
            // Without this, esbuild logs warnings to console for some
            // cases.  We want all diagnostics in the result object.
            logLevel: "silent",
        });

        const contents =
            result.outputFiles && result.outputFiles[0]
                ? result.outputFiles[0].text
                : null;
        return {
            contents,
            errors: result.errors.map(formatMessage),
            warnings: result.warnings.map(formatMessage),
        };
    } catch (err) {
        const errors = err.errors
            ? err.errors.map(formatMessage)
            : [{ text: String(err) }];
        return {
            contents: null,
            errors,
            warnings: err.warnings ? err.warnings.map(formatMessage) : [],
        };
    }
}

/** Flatten esbuild Message → plain {text, location} for JSON return. */
function formatMessage(m) {
    return {
        text: m.text,
        location: m.location
            ? {
                  file: m.location.file,
                  line: m.location.line,
                  column: m.location.column,
                  // lineText is the offending source line — used by
                  // the Python-side renderer to show the line + a
                  // caret marker pointing at the column.
                  lineText: m.location.lineText || "",
                  length: m.location.length || 0,
              }
            : null,
    };
}
