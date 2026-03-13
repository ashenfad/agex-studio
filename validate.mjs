/**
 * Phase 2 validation: install and import every agex stack package in Pyodide.
 *
 * Run: node validate.mjs
 *
 * Uses Pyodide's Node.js build to avoid needing a browser.
 * Note: IndexedDB is not available in Node — that's fine, we tested it
 * separately in kvgit. This validates pure-Python import compatibility.
 */

import { loadPyodide } from "pyodide";

const results = [];

function log(msg, level = "info") {
    const prefix = level === "ok" ? "  ✓" : level === "error" ? "  ✗" : level === "warn" ? "  ⚠" : "  ";
    console.log(`${prefix} ${msg}`);
}

async function tryInstall(pyodide, name, deps = false) {
    try {
        await pyodide.runPythonAsync(`
import micropip
await micropip.install("${name}", deps=${deps ? "True" : "False"})
        `);
        log(`pip install ${name}`, "ok");
        return true;
    } catch (e) {
        const lines = e.message.split("\n").filter(l => l.trim());
        const lastLine = lines[lines.length - 1] || e.message;
        log(`pip install ${name} FAILED: ${lastLine}`, "error");
        return false;
    }
}

async function tryImport(pyodide, mod, expectFail = false) {
    try {
        pyodide.runPython(`import ${mod}`);
        log(`import ${mod}`, "ok");
        results.push({ mod, status: "ok" });
        return true;
    } catch (e) {
        const lines = e.message.split("\n").filter(l => l.trim());
        const lastLine = lines[lines.length - 1] || e.message;
        const level = expectFail ? "warn" : "error";
        log(`import ${mod} FAILED: ${lastLine}`, level);
        results.push({ mod, status: "fail", error: lastLine });
        return false;
    }
}

async function tryRun(pyodide, label, code) {
    try {
        pyodide.runPython(code);
        log(label, "ok");
        return true;
    } catch (e) {
        const lines = e.message.split("\n").filter(l => l.trim());
        const lastLine = lines[lines.length - 1] || e.message;
        log(`${label} FAILED: ${lastLine}`, "error");
        return false;
    }
}

async function main() {
    console.log("Loading Pyodide...");
    const pyodide = await loadPyodide();
    console.log("Pyodide loaded.\n");

    await pyodide.loadPackage("micropip");
    const micropip = pyodide.pyimport("micropip");

    // --- Install and import each package ---

    const packages = [
        { name: "kvgit", imports: ["kvgit", "kvgit.kv.memory", "kvgit.staged", "kvgit.versioned.kv"] },
        { name: "monkeyfs", imports: ["monkeyfs"] },
        { name: "termish", imports: ["termish"] },
        { name: "reprobate", imports: ["reprobate"] },
        { name: "sandtrap", imports: ["sandtrap"] },
        { name: "pydantic", imports: ["pydantic"] },
        { name: "pygments", imports: ["pygments"] },
        { name: "tiktoken", imports: ["tiktoken"], expectFail: true },
        { name: "diskcache", imports: ["diskcache"], expectFail: true },
    ];

    for (const pkg of packages) {
        console.log(`\n--- ${pkg.name} ---`);
        const installed = await tryInstall(pyodide, pkg.name);
        if (!installed) continue;
        for (const mod of pkg.imports) {
            await tryImport(pyodide, mod, pkg.expectFail);
        }
    }

    console.log("\n--- agex ---");
    await tryInstall(pyodide, "agex", true);
    await tryImport(pyodide, "agex");

    // --- Smoke tests ---
    console.log("\n--- Smoke tests ---");

    await tryRun(pyodide, "kvgit in-memory round-trip", `
import kvgit
s = kvgit.store()
s["hello"] = "world"
s.commit()
assert s["hello"] == "world"
assert len(list(s.keys())) == 1
    `);

    await tryRun(pyodide, "monkeyfs VirtualFS round-trip", `
from monkeyfs import VirtualFS
vfs = VirtualFS()
vfs.write("/test.txt", b"hello")
assert vfs.read("/test.txt") == b"hello"
    `);

    await tryRun(pyodide, "sandtrap basic exec", `
from sandtrap import Sandbox, Policy
sb = Sandbox(Policy())
result = sb.exec("x = 1 + 2")
    `);

    await tryRun(pyodide, "monkeyfs + kvgit integration", `
from monkeyfs import VirtualFS
import kvgit
s = kvgit.store()
vfs = VirtualFS(state=s)
vfs.write("/app/main.py", b"print('hello')")
s.commit()
assert vfs.read("/app/main.py") == b"print('hello')"
    `);

    // --- Summary ---
    console.log("\n=== SUMMARY ===");
    const ok = results.filter(r => r.status === "ok");
    const fail = results.filter(r => r.status === "fail");
    console.log(`  Imports passed: ${ok.length}`);
    console.log(`  Imports failed: ${fail.length}`);
    if (fail.length) {
        for (const f of fail) {
            console.log(`    - ${f.mod}: ${f.error}`);
        }
    }
}

main().catch(e => {
    console.error("Fatal:", e);
    process.exit(1);
});
