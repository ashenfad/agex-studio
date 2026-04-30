/**
 * Syntax check for Python files served to Pyodide.
 *
 * The JS-side tests mock out runPython, so they never actually try to
 * parse the .py files we ship under ``public/``.  This guards against
 * the class of bug where a file looks fine to a human but can't be
 * imported by Pyodide — the obvious recent example being
 * ``\u{1F4A5}`` (a valid JS unicode escape) appearing in a file
 * Python is asked to load.
 *
 * Implementation: shell out to ``python3 -m py_compile`` for each
 * file.  Any nonzero exit fails the test and surfaces stderr so the
 * traceback is right there in the test output.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const PUBLIC_DIR = resolve(__dirname, "../../public");

function findPythonFiles(dir) {
    const out = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const s = statSync(full);
        if (s.isDirectory()) {
            out.push(...findPythonFiles(full));
        } else if (s.isFile() && entry.endsWith(".py")) {
            out.push(full);
        }
    }
    return out;
}

describe("Python files under public/ are valid Python", () => {
    const files = findPythonFiles(PUBLIC_DIR);

    // Sanity: if we somehow point at the wrong dir, fail loudly rather
    // than silently passing with zero assertions.
    it("finds at least one .py file to check", () => {
        expect(files.length).toBeGreaterThan(0);
    });

    for (const file of files) {
        const rel = file.slice(PUBLIC_DIR.length + 1);
        it(`py_compile: ${rel}`, () => {
            try {
                execFileSync("python3", ["-m", "py_compile", file], {
                    stdio: ["ignore", "pipe", "pipe"],
                });
            } catch (err) {
                const stderr = err.stderr ? err.stderr.toString() : String(err);
                throw new Error(`py_compile failed for ${rel}:\n${stderr}`);
            }
        });
    }
});
