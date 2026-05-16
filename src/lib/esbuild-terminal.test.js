/**
 * Unit tests for `esbuild-terminal.js`.
 *
 * Coverage focus:
 *   - `parseEsbuildArgs`: every flag shape and every error path
 *   - `collectAppSources`: source/binary/junk filtering, size cap,
 *     missing-dir tolerance
 *   - `formatDiag`: with-location / without-location for both levels
 *   - `runEsbuildCommand`: orchestration with a stub `runEsbuild` and
 *     an in-memory mock VFS — no real esbuild-wasm involved
 */

import { describe, expect, it } from "vitest";

import {
    HELP_TEXT,
    collectAppSources,
    formatDiag,
    parseEsbuildArgs,
    runEsbuildCommand,
} from "./esbuild-terminal.js";

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Build an in-memory VFS that satisfies the subset of `FileSystem`
 *  the terminal needs (list / isFile / read / write). Paths are
 *  exact strings; directories are inferred from path prefixes. */
function mockFs(initial = {}) {
    /** @type {Map<string, Uint8Array>} */
    const files = new Map(
        Object.entries(initial).map(([k, v]) => [
            k,
            v instanceof Uint8Array ? v : encoder.encode(v),
        ]),
    );

    return {
        files,
        async list(prefix, opts) {
            // Return entries under `prefix` as relative paths
            // (basename or further-nested), recursive by default.
            const recursive = opts?.recursive !== false;
            if (!prefix) prefix = "";
            const out = [];
            for (const path of files.keys()) {
                if (!path.startsWith(prefix)) continue;
                const rel = path.slice(prefix.length);
                if (!recursive && rel.includes("/")) continue;
                out.push(rel);
            }
            return out;
        },
        async isFile(path) {
            return files.has(path);
        },
        async read(path) {
            const b = files.get(path);
            if (!b) throw new Error(`ENOENT: ${path}`);
            return b;
        },
        async write(path, content) {
            files.set(path, content);
        },
    };
}

function captureStdout() {
    const chunks = [];
    return {
        stdout: { write: (s) => chunks.push(s) },
        text: () => chunks.join(""),
    };
}

// --------------------------------------------------------------------------
// parseEsbuildArgs
// --------------------------------------------------------------------------

describe("parseEsbuildArgs", () => {
    it("treats no args as help", () => {
        expect(parseEsbuildArgs([])).toEqual({ help: true });
    });

    it.each(["--help", "-h"])("treats %s as help", (flag) => {
        expect(parseEsbuildArgs([flag])).toEqual({ help: true });
    });

    it("parses entry + --outfile", () => {
        expect(
            parseEsbuildArgs(["app/index.jsx", "--outfile=app/index.js"]),
        ).toEqual({ entry: "app/index.jsx", outfile: "app/index.js", minify: false });
    });

    it("parses entry + -o= short form", () => {
        expect(parseEsbuildArgs(["app/x.jsx", "-o=app/x.js"])).toEqual({
            entry: "app/x.jsx",
            outfile: "app/x.js",
            minify: false,
        });
    });

    it.each([["--minify"], ["-m"]])("parses %s flag", (flag) => {
        expect(
            parseEsbuildArgs(["app/x.jsx", "--outfile=app/x.js", flag]),
        ).toEqual({ entry: "app/x.jsx", outfile: "app/x.js", minify: true });
    });

    it("accepts flags before entry", () => {
        expect(
            parseEsbuildArgs(["--outfile=app/x.js", "--minify", "app/x.jsx"]),
        ).toEqual({ entry: "app/x.jsx", outfile: "app/x.js", minify: true });
    });

    it("errors on missing entry", () => {
        const r = parseEsbuildArgs(["--outfile=app/x.js"]);
        expect(r.error).toMatch(/missing entry point/);
    });

    it("errors on missing outfile", () => {
        const r = parseEsbuildArgs(["app/x.jsx"]);
        expect(r.error).toMatch(/--outfile=<path> is required/);
    });

    it("errors on unknown flag with a pointer at --help", () => {
        const r = parseEsbuildArgs([
            "app/x.jsx",
            "--outfile=app/x.js",
            "--platform=node",
        ]);
        expect(r.error).toMatch(/unknown flag: --platform=node/);
        expect(r.error).toMatch(/esbuild --help/);
    });

    it.each([
        // Native esbuild flags agents commonly reach for. Each one is
        // already implied by our wrapper's defaults (bundle/jsx/esm),
        // so they should error with the unknown-flag message rather
        // than silently no-op — that's what bit the user-reported run.
        "--jsx=automatic",
        "--bundle",
        "--format=esm",
        "--platform=browser",
        "--target=es2020",
        "--loader=jsx",
        "--sourcemap",
    ])("errors on native esbuild flag %s (not in our wrapper's surface)", (flag) => {
        const r = parseEsbuildArgs([
            "app/x.jsx",
            "--outfile=app/x.js",
            flag,
        ]);
        expect(r.error).toMatch(new RegExp(`unknown flag: ${flag.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}`));
    });

    it("errors on extra positional", () => {
        const r = parseEsbuildArgs([
            "app/a.jsx",
            "app/b.jsx",
            "--outfile=app/x.js",
        ]);
        expect(r.error).toMatch(/unexpected positional arg: app\/b.jsx/);
    });
});

// --------------------------------------------------------------------------
// collectAppSources
// --------------------------------------------------------------------------

describe("collectAppSources", () => {
    it("returns empty dict when neither app/ nor helpers/ exists", async () => {
        // mockFs.list returns [] when no matches; collectAppSources
        // must tolerate that without throwing.
        const fs = mockFs({});
        expect(await collectAppSources(fs)).toEqual({});
    });

    it("picks up source files under app/ as UTF-8 strings", async () => {
        const fs = mockFs({
            "app/index.jsx": "export default () => 'hi'",
            "app/util.ts": "export const x = 1",
            "app/style.css": "body { color: red }",
        });
        const files = await collectAppSources(fs);
        expect(files["app/index.jsx"]).toBe("export default () => 'hi'");
        expect(files["app/util.ts"]).toBe("export const x = 1");
        expect(files["app/style.css"]).toBe("body { color: red }");
    });

    it("picks up source files under helpers/ too", async () => {
        const fs = mockFs({ "helpers/lib.js": "export const k = 42" });
        const files = await collectAppSources(fs);
        expect(files["helpers/lib.js"]).toBe("export const k = 42");
    });

    it("filters out non-source extensions (PDF, parquet, etc.)", async () => {
        const fs = mockFs({
            "app/index.jsx": "// ok",
            "app/data.parquet": new Uint8Array([0, 1, 2, 3]),
            "app/notes.pdf": new Uint8Array([0xff, 0xd8]),
            "app/raw.bin": new Uint8Array([1, 2]),
        });
        const files = await collectAppSources(fs);
        expect(Object.keys(files).sort()).toEqual(["app/index.jsx"]);
    });

    it("encodes images as tagged base64 envelopes", async () => {
        const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic
        const fs = mockFs({ "app/logo.png": png });
        const files = await collectAppSources(fs);
        expect(files["app/logo.png"]).toEqual({ _binary_b64: btoa("\x89PNG") });
    });

    it("skips images larger than 1MB", async () => {
        const big = new Uint8Array(1_048_577); // 1MB + 1 byte
        const fs = mockFs({
            "app/huge.png": big,
            "app/small.png": new Uint8Array([1, 2, 3]),
        });
        const files = await collectAppSources(fs);
        expect("app/huge.png" in files).toBe(false);
        expect(files["app/small.png"]).toEqual({ _binary_b64: btoa("\x01\x02\x03") });
    });

    it("treats fs.list throw on missing dir as empty", async () => {
        const fs = {
            list: async (p) => {
                if (p === "app/") throw new Error("ENOENT");
                return [];
            },
            isFile: async () => false,
            read: async () => new Uint8Array(),
        };
        // Should not propagate the throw — both dirs missing → {}.
        expect(await collectAppSources(fs)).toEqual({});
    });
});

// --------------------------------------------------------------------------
// formatDiag
// --------------------------------------------------------------------------

describe("formatDiag", () => {
    it("renders a single-line header when location is missing", () => {
        expect(formatDiag("error", { text: "boom", location: null })).toBe(
            "error: boom",
        );
        expect(formatDiag("warning", { text: "soft" })).toBe("warning: soft");
    });

    it("renders the 3-line block when location has lineText", () => {
        const out = formatDiag("error", {
            text: "Unexpected token",
            location: {
                file: "app/x.jsx",
                line: 5,
                column: 12,
                lineText: "  return <Foo bar=)",
                length: 1,
            },
        });
        expect(out).toBe(
            "error: app/x.jsx:5:12: Unexpected token\n" +
                "      return <Foo bar=)\n" +
                "                ^",
        );
    });

    it("falls back to header-only when lineText is missing", () => {
        const out = formatDiag("warning", {
            text: "foo",
            location: { file: "app/x.jsx", line: 1, column: 0, lineText: "" },
        });
        expect(out).toBe("warning: app/x.jsx:1:0: foo");
    });

    it("clamps length to at least 1 caret", () => {
        const out = formatDiag("error", {
            text: "x",
            location: {
                file: "f",
                line: 1,
                column: 0,
                lineText: "abc",
                length: 0,
            },
        });
        expect(out.endsWith("^")).toBe(true);
    });
});

// --------------------------------------------------------------------------
// runEsbuildCommand
// --------------------------------------------------------------------------

describe("runEsbuildCommand", () => {
    it("writes help text and skips the bridge on --help", async () => {
        const fs = mockFs({});
        const cap = captureStdout();
        let called = false;
        await runEsbuildCommand(
            { args: ["--help"], stdout: cap.stdout, fs },
            async () => {
                called = true;
                return { contents: "", errors: [], warnings: [] };
            },
        );
        expect(cap.text()).toBe(HELP_TEXT);
        expect(called).toBe(false);
    });

    it("throws on parse error", async () => {
        const fs = mockFs({});
        const cap = captureStdout();
        await expect(
            runEsbuildCommand(
                { args: ["app/x.jsx"], stdout: cap.stdout, fs },
                async () => ({ contents: "", errors: [], warnings: [] }),
            ),
        ).rejects.toThrow(/--outfile=<path> is required/);
    });

    it("throws when entry is not in collected sources", async () => {
        const fs = mockFs({ "app/other.jsx": "// nope" });
        const cap = captureStdout();
        await expect(
            runEsbuildCommand(
                {
                    args: ["app/missing.jsx", "--outfile=app/x.js"],
                    stdout: cap.stdout,
                    fs,
                },
                async () => ({ contents: "", errors: [], warnings: [] }),
            ),
        ).rejects.toThrow(/entry point not found in app\/ or helpers\/: app\/missing.jsx/);
    });

    it("calls runEsbuild with collected files and writes the bundle", async () => {
        const fs = mockFs({
            "app/index.jsx": "export default 1",
            "helpers/lib.js": "export const k = 2",
        });
        const cap = captureStdout();
        let received = null;
        await runEsbuildCommand(
            {
                args: ["app/index.jsx", "--outfile=app/bundle.js"],
                stdout: cap.stdout,
                fs,
            },
            async (args) => {
                received = args;
                return {
                    contents: "/* bundled */",
                    errors: [],
                    warnings: [],
                };
            },
        );

        expect(received.entryPoint).toBe("app/index.jsx");
        expect(received.minify).toBe(false);
        expect(Object.keys(received.files).sort()).toEqual([
            "app/index.jsx",
            "helpers/lib.js",
        ]);

        const written = fs.files.get("app/bundle.js");
        expect(written).toBeDefined();
        expect(decoder.decode(written)).toBe("/* bundled */");

        expect(cap.text()).toBe(
            "esbuild: bundled app/index.jsx → app/bundle.js (13 bytes)\n",
        );
    });

    it("forwards --minify to the bridge", async () => {
        const fs = mockFs({ "app/x.jsx": "export default 1" });
        const cap = captureStdout();
        let received = null;
        await runEsbuildCommand(
            {
                args: ["app/x.jsx", "--outfile=app/x.js", "--minify"],
                stdout: cap.stdout,
                fs,
            },
            async (args) => {
                received = args;
                return { contents: "x", errors: [], warnings: [] };
            },
        );
        expect(received.minify).toBe(true);
    });

    it("surfaces warnings on stdout but still writes the bundle", async () => {
        const fs = mockFs({ "app/x.jsx": "export default 1" });
        const cap = captureStdout();
        await runEsbuildCommand(
            { args: ["app/x.jsx", "--outfile=app/x.js"], stdout: cap.stdout, fs },
            async () => ({
                contents: "x",
                errors: [],
                warnings: [
                    { text: "deprecated thing", location: null },
                    {
                        text: "look here",
                        location: {
                            file: "app/x.jsx",
                            line: 1,
                            column: 7,
                            lineText: "export default 1",
                            length: 1,
                        },
                    },
                ],
            }),
        );
        const out = cap.text();
        expect(out).toContain("warning: deprecated thing");
        expect(out).toContain("warning: app/x.jsx:1:7: look here");
        expect(out).toContain("esbuild: bundled");
        // Bundle should still be present on disk
        expect(fs.files.has("app/x.js")).toBe(true);
    });

    it("throws with formatted error block when build has errors", async () => {
        const fs = mockFs({ "app/x.jsx": "export default 1" });
        const cap = captureStdout();
        await expect(
            runEsbuildCommand(
                {
                    args: ["app/x.jsx", "--outfile=app/x.js"],
                    stdout: cap.stdout,
                    fs,
                },
                async () => ({
                    contents: null,
                    errors: [
                        {
                            text: "unexpected )",
                            location: {
                                file: "app/x.jsx",
                                line: 1,
                                column: 0,
                                lineText: ")",
                                length: 1,
                            },
                        },
                        { text: "another error", location: null },
                    ],
                    warnings: [],
                }),
            ),
        ).rejects.toThrow(/error: app\/x.jsx:1:0: unexpected \)[\s\S]*error: another error/);
        // Bundle should NOT be written when the build errored
        expect(fs.files.has("app/x.js")).toBe(false);
    });

    it("throws when bridge call itself fails", async () => {
        const fs = mockFs({ "app/x.jsx": "export default 1" });
        const cap = captureStdout();
        await expect(
            runEsbuildCommand(
                {
                    args: ["app/x.jsx", "--outfile=app/x.js"],
                    stdout: cap.stdout,
                    fs,
                },
                async () => {
                    throw new Error("network is down");
                },
            ),
        ).rejects.toThrow(/bridge call failed: network is down/);
    });

    it("throws when bridge returns null contents with no errors", async () => {
        // Defensive case — should never happen in practice, but the
        // handler shouldn't try to write `null` to disk if it does.
        const fs = mockFs({ "app/x.jsx": "export default 1" });
        const cap = captureStdout();
        await expect(
            runEsbuildCommand(
                {
                    args: ["app/x.jsx", "--outfile=app/x.js"],
                    stdout: cap.stdout,
                    fs,
                },
                async () => ({ contents: null, errors: [], warnings: [] }),
            ),
        ).rejects.toThrow(/no output produced/);
    });
});
