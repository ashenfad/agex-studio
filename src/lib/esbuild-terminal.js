/**
 * `esbuild` terminal command — TS-side counterpart of the py-side
 * `_register_esbuild` in `public/python/agent_modules.py`. Wraps
 * `esbuild-bridge.js` (shared with the py kernel) as a @agex-ts/termish
 * command so agents can `esbuild app/index.jsx --outfile=app/index.js`
 * to bundle JSX/TSX sources into runnable JS for the app preview.
 *
 * Exports are split into pure helpers + a single orchestrator for
 * testability. The actual `runEsbuild` import is injected into the
 * orchestrator rather than imported here, so tests can run end-to-end
 * against a stub without pulling in the ~10MB esbuild-wasm bundle.
 *
 * The orchestrator throws plain `Error` for usage / config / build
 * failures. agex-ts's task.ts catches the throw, surfaces the
 * message as an error OutputPart, and the agent sees it on the next
 * turn — same UX shape as @agex-ts/termish builtins that throw
 * `TerminalError`. We don't import `TerminalError` because @agex-ts/termish
 * isn't a direct dep; the only difference is the absence of
 * `partialOutput`, which we'd never populate anyway (esbuild is a
 * single atomic call, no incremental stdout).
 */

import { bytesToBase64 } from "./bytes.js";

/** Source extensions esbuild understands as text. Kept in sync with
 *  the py-side `SOURCE_EXTS` in `_collect_app_sources`. */
const SOURCE_EXTS = [".jsx", ".tsx", ".ts", ".js", ".css", ".json", ".svg"];

/** Image extensions esbuild inlines via its `dataurl` loader during
 *  bundling. Deliberately narrower than `app-assets.js`'s `BINARY_EXTS`
 *  (which also covers fonts / svg / audio for the app-preview asset
 *  pipeline) — only raster images are worth inlining into a JS bundle. */
const INLINE_IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".webp"];

/** Per-image cap: refuse to bundle anything larger so an agent's
 *  `import logo from './huge.png'` doesn't bloat the bundle. The
 *  agent gets a clear "not found in vfs" error from esbuild rather
 *  than a 10MB output file. */
const BINARY_MAX_BYTES = 1_048_576;

const SOURCE_DIRS = ["app/", "helpers/"];

/**
 * Parse `esbuild` argv. Pure function — no I/O.
 *
 * @param {ReadonlyArray<string>} args
 * @returns {{help: true} | {entry: string, outfile: string, minify: boolean} | {error: string}}
 */
export function parseEsbuildArgs(args) {
    if (!args || args.length === 0 || args[0] === "--help" || args[0] === "-h") {
        return { help: true };
    }

    let entry = null;
    let outfile = null;
    let minify = false;
    for (const arg of args) {
        if (arg === "--minify" || arg === "-m") {
            minify = true;
        } else if (arg.startsWith("--outfile=")) {
            outfile = arg.slice("--outfile=".length);
        } else if (arg.startsWith("-o=")) {
            outfile = arg.slice("-o=".length);
        } else if (arg.startsWith("-")) {
            // Friendlier than a bare "unknown flag" — agents commonly
            // reach for native esbuild flags (--bundle, --jsx=automatic,
            // --format=esm) that are already enabled by default in our
            // wrapper. The pointer at `esbuild --help` is the fastest
            // route from "got an error" to "saw the flag list."
            return {
                error:
                    `esbuild: unknown flag: ${arg}. Only --outfile=<path> ` +
                    `and --minify are configurable here; bundling, JSX ` +
                    `transform, and ESM output are on by default. Run ` +
                    `\`esbuild --help\` for the full surface.`,
            };
        } else if (entry === null) {
            entry = arg;
        } else {
            return { error: `esbuild: unexpected positional arg: ${arg}` };
        }
    }

    if (entry === null) {
        return { error: "esbuild: missing entry point. Run `esbuild --help`." };
    }
    if (outfile === null) {
        return { error: "esbuild: --outfile=<path> is required." };
    }
    return { entry, outfile, minify };
}

/** Help text written to stdout for `esbuild` / `esbuild --help`. */
export const HELP_TEXT =
    "Usage: esbuild <entry.jsx> --outfile=<bundle.js> [--minify]\n" +
    "       esbuild --help\n\n" +
    "Bundles agent app source files (JSX/TSX/JS/TS) into a single\n" +
    "ES module. Bare imports (react, @scope/pkg) stay external\n" +
    "and are resolved by the iframe's import map at runtime;\n" +
    "local imports (./Chart.jsx) are bundled inline.\n\n" +
    "JSX is transformed with the automatic runtime targeting\n" +
    "preact (alias react → preact/compat in the import map).\n";

const _decoder = new TextDecoder("utf-8", { fatal: false });

/**
 * Walk `app/` and `helpers/` and build a path → content dict for
 * the esbuild bridge. Source files become UTF-8 strings; binary
 * images become tagged `{_binary_b64}` envelopes the bridge's vfs
 * plugin recognizes. Anything else (PDFs, parquet, etc.) is
 * filtered out so esbuild doesn't see large non-source files that
 * happen to live alongside app code.
 *
 * @param {{
 *   list(path?: string, opts?: {recursive?: boolean}): Promise<string[]>,
 *   isFile(path: string): Promise<boolean>,
 *   read(path: string): Promise<Uint8Array>,
 * }} fs
 * @returns {Promise<Record<string, string | {_binary_b64: string}>>}
 */
export async function collectAppSources(fs) {
    /** @type {Record<string, string | {_binary_b64: string}>} */
    const files = {};
    for (const root of SOURCE_DIRS) {
        let entries;
        try {
            entries = await fs.list(root, { recursive: true });
        } catch {
            // Directory may not exist yet — fine, just skip it.
            continue;
        }
        for (const rel of entries) {
            const full = root + rel;
            try {
                if (!(await fs.isFile(full))) continue;
            } catch {
                continue;
            }
            const lower = rel.toLowerCase();
            if (SOURCE_EXTS.some((ext) => lower.endsWith(ext))) {
                try {
                    const bytes = await fs.read(full);
                    files[full] = _decoder.decode(bytes);
                } catch {
                    // Skip files that vanish or fail mid-walk.
                }
            } else if (INLINE_IMAGE_EXTS.some((ext) => lower.endsWith(ext))) {
                try {
                    const bytes = await fs.read(full);
                    if (bytes.length > BINARY_MAX_BYTES) continue;
                    files[full] = { _binary_b64: bytesToBase64(bytes) };
                } catch {
                    // Skip files that vanish or fail mid-walk.
                }
            }
        }
    }
    return files;
}


/**
 * Format a single esbuild diagnostic for terminal output. Pure.
 *
 * Three-line block when source location is available:
 *   "{level}: {file}:{line}:{col}: {message}"
 *   "    {offending source line}"
 *   "    {caret marker pointing at the column}"
 *
 * Falls back to a single header line when location is missing.
 *
 * @param {"error"|"warning"} level
 * @param {{text?: string, location?: {file?: string, line?: number, column?: number, lineText?: string, length?: number} | null}} d
 * @returns {string}
 */
export function formatDiag(level, d) {
    const text = d?.text ?? "";
    const loc = d?.location;
    if (!loc) return `${level}: ${text}`;

    const file = loc.file ?? "?";
    const line = loc.line ?? 0;
    const col = loc.column ?? 0;
    const lineText = loc.lineText ?? "";
    const length = Math.max(loc.length ?? 1, 1);

    const header = `${level}: ${file}:${line}:${col}: ${text}`;
    if (!lineText) return header;

    const caret = " ".repeat(col) + "^".repeat(length);
    return `${header}\n    ${lineText}\n    ${caret}`;
}

const _encoder = new TextEncoder();

/**
 * Run the `esbuild` terminal command. The orchestration is split
 * out here (rather than living inside the `agent.terminal(...)`
 * registration in `ts-agent.js`) so it can be unit-tested with a
 * stub `runEsbuild` and a mock VFS — no real esbuild-wasm fetch
 * needed.
 *
 * @param {{
 *   args: ReadonlyArray<string>,
 *   stdout: { write(s: string): void },
 *   fs: {
 *     list(path?: string, opts?: {recursive?: boolean}): Promise<string[]>,
 *     isFile(path: string): Promise<boolean>,
 *     read(path: string): Promise<Uint8Array>,
 *     write(path: string, content: Uint8Array, mode?: 'w' | 'a'): Promise<void>,
 *   },
 * }} ctx - Subset of the agex-ts terminal handler context we use.
 * @param {(args: {files: object, entryPoint: string, minify?: boolean}) => Promise<{contents: string|null, errors: any[], warnings: any[]}>} runEsbuild - Bridge call (injected for testability).
 */
export async function runEsbuildCommand(ctx, runEsbuild) {
    const parsed = parseEsbuildArgs(ctx.args);
    if (parsed.help) {
        ctx.stdout.write(HELP_TEXT);
        return;
    }
    if (parsed.error) {
        throw new Error(parsed.error);
    }

    const { entry, outfile, minify } = parsed;

    const files = await collectAppSources(ctx.fs);
    if (!(entry in files)) {
        throw new Error(
            `esbuild: entry point not found in app/ or helpers/: ${entry}`,
        );
    }

    let result;
    try {
        result = await runEsbuild({ files, entryPoint: entry, minify });
    } catch (e) {
        throw new Error(`esbuild: bridge call failed: ${e?.message || String(e)}`);
    }

    // Warnings are non-fatal — surface them on stdout regardless of
    // whether the build succeeded.
    for (const w of result.warnings ?? []) {
        ctx.stdout.write(formatDiag("warning", w) + "\n");
    }

    if (result.errors && result.errors.length > 0) {
        // Blank line between multi-error blocks so each 3-line block
        // (header / source / caret) is visually separated.
        const stderr = result.errors
            .map((e) => formatDiag("error", e))
            .join("\n\n");
        throw new Error(stderr || "esbuild: build failed");
    }

    const contents = result.contents;
    if (contents == null) {
        throw new Error("esbuild: no output produced");
    }

    try {
        await ctx.fs.write(outfile, _encoder.encode(contents));
    } catch (e) {
        throw new Error(
            `esbuild: failed to write ${outfile}: ${e?.message || String(e)}`,
        );
    }

    ctx.stdout.write(
        `esbuild: bundled ${entry} → ${outfile} (${contents.length} bytes)\n`,
    );
}
