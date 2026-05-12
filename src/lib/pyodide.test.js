import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Worker
class MockWorker {
    constructor(url) {
        MockWorker.instances.push(this);
        this.url = url;
        this.posted = [];
        this.onmessage = null;
        this.onerror = null;
    }
    postMessage(msg) {
        this.posted.push(msg);
    }
    _receive(data) {
        this.onmessage?.({ data });
    }
}
MockWorker.instances = [];

vi.stubGlobal("Worker", MockWorker);
vi.stubGlobal("window", {
    location: { href: "http://localhost:5173/" },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
});
// localStorage stub — pyodide.js reads debug flags in the token handler
vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
});

beforeEach(() => {
    MockWorker.instances = [];
    vi.resetModules();
});

async function loadPyodide() {
    return await import("./pyodide.js");
}

describe("pyodideStore", () => {
    it("starts in idle state", async () => {
        const { pyodideStore } = await loadPyodide();
        let state;
        const unsub = pyodideStore.subscribe((s) => {
            state = s;
        });
        expect(state.status).toBe("idle");
        unsub();
    });
});

describe("startWorker", () => {
    it("transitions to loading and sends init message", async () => {
        const { pyodideStore, startWorker } = await loadPyodide();
        const states = [];
        pyodideStore.subscribe((s) => states.push({ ...s }));

        startWorker();

        expect(states.at(-1).status).toBe("loading");
        expect(MockWorker.instances).toHaveLength(1);
        const w = MockWorker.instances[0];
        expect(w.posted).toHaveLength(1);
        expect(w.posted[0].type).toBe("init");
    });

    it("transitions to ready on ready message", async () => {
        const { pyodideStore, startWorker } = await loadPyodide();
        let state;
        pyodideStore.subscribe((s) => {
            state = s;
        });

        startWorker();
        MockWorker.instances[0]._receive({ type: "ready" });

        expect(state.status).toBe("ready");
        expect(state.progress).toBe(1);
    });

    it("transitions to error on init-error message", async () => {
        const { pyodideStore, startWorker } = await loadPyodide();
        let state;
        pyodideStore.subscribe((s) => {
            state = s;
        });

        startWorker();
        MockWorker.instances[0]._receive({
            type: "init-error",
            message: "boom",
        });

        expect(state.status).toBe("error");
        expect(state.message).toContain("boom");
    });

    it("is a no-op if already loading", async () => {
        const { startWorker } = await loadPyodide();
        startWorker();
        startWorker();
        expect(MockWorker.instances).toHaveLength(1);
    });
});

describe("runPython", () => {
    it("rejects when not ready", async () => {
        const { runPython } = await loadPyodide();
        await expect(runPython("1+1")).rejects.toThrow("Pyodide not ready");
    });

    it("sends code and resolves on result", async () => {
        const { startWorker, runPython } = await loadPyodide();
        startWorker();
        const w = MockWorker.instances[0];
        w._receive({ type: "ready" });

        const promise = runPython("1+1");
        const runMsg = w.posted.find((m) => m.type === "run");
        expect(runMsg).toBeDefined();
        expect(runMsg.code).toBe("1+1");

        w._receive({ type: "result", id: runMsg.id, value: "2" });
        const result = await promise;
        expect(result).toBe("2");
    });

    it("rejects on run-error", async () => {
        const { startWorker, runPython } = await loadPyodide();
        startWorker();
        const w = MockWorker.instances[0];
        w._receive({ type: "ready" });

        const promise = runPython("bad code");
        const runMsg = w.posted.find((m) => m.type === "run");
        w._receive({
            type: "run-error",
            id: runMsg.id,
            message: "SyntaxError",
        });

        await expect(promise).rejects.toThrow("SyntaxError");
    });
});

describe("runPythonStreaming", () => {
    it("rejects when not ready", async () => {
        const { runPythonStreaming } = await loadPyodide();
        await expect(runPythonStreaming("1+1", () => {})).rejects.toThrow(
            "Pyodide not ready"
        );
    });

    it("injects _run_id and resolves on result", async () => {
        const { startWorker, runPythonStreaming } = await loadPyodide();
        startWorker();
        const w = MockWorker.instances[0];
        w._receive({ type: "ready" });

        const promise = runPythonStreaming("print(_run_id)", () => {});
        const runMsg = w.posted.find((m) => m.type === "run");
        expect(runMsg.code).toContain("_run_id = ");
        expect(runMsg.code).toContain("print(_run_id)");

        w._receive({ type: "result", id: runMsg.id, value: "ok" });
        expect(await promise).toBe("ok");
    });

    it("calls onToken for streamed tokens", async () => {
        const { startWorker, runPythonStreaming } = await loadPyodide();
        startWorker();
        const w = MockWorker.instances[0];
        w._receive({ type: "ready" });

        const tokens = [];
        const promise = runPythonStreaming("code", (t) => tokens.push(t));
        const runMsg = w.posted.find((m) => m.type === "run");

        w._receive({
            type: "token",
            id: runMsg.id,
            json: JSON.stringify({ text: "hello" }),
        });
        w._receive({
            type: "token",
            id: runMsg.id,
            json: JSON.stringify({ text: "world" }),
        });
        w._receive({ type: "result", id: runMsg.id, value: "done" });

        expect(await promise).toBe("done");
        expect(tokens).toEqual([{ text: "hello" }, { text: "world" }]);
    });
});

describe("terminateWorker", () => {
    it("is a no-op when no worker exists", async () => {
        const { terminateWorker } = await loadPyodide();
        expect(() => terminateWorker()).not.toThrow();
    });

    it("terminates worker and rejects pending tasks", async () => {
        const { startWorker, runPython, terminateWorker, pyodideStore } =
            await loadPyodide();
        startWorker();
        const w = MockWorker.instances[0];
        w.terminate = vi.fn();
        w._receive({ type: "ready" });

        const promise = runPython("slow()");
        terminateWorker();

        expect(w.terminate).toHaveBeenCalled();
        await expect(promise).rejects.toThrow("Cancelled");

        let state;
        pyodideStore.subscribe((s) => {
            state = s;
        });
        expect(state.status).toBe("idle");
    });
});

describe("cancelTask", () => {
    it("does nothing when worker is not ready", async () => {
        const { cancelTask } = await loadPyodide();
        expect(() => cancelTask()).not.toThrow();
    });

    it("sends cancel message to worker when ready", async () => {
        const { startWorker, cancelTask } = await loadPyodide();
        startWorker();
        const w = MockWorker.instances[0];
        w._receive({ type: "ready" });

        cancelTask();
        const msg = w.posted.find((m) => m.type === "cancel");
        expect(msg).toBeDefined();
    });
});

// setGoogleToken tests removed — the /drive/ live mount was replaced
// with on-demand Drive imports (see drive-import.js). The OAuth token
// now lives only in main-thread scope during picker + download, never
// crosses into the Pyodide worker.

describe("_rewriteLocalImports", () => {
    it("rewrites static import-from specifiers for known files", async () => {
        const { _rewriteLocalImports } = await loadPyodide();
        const known = new Set(["App.js", "utils.js"]);
        const code = `import { App } from './App.js';\nimport { helper } from './utils.js';`;
        const result = _rewriteLocalImports(code, known);
        expect(result).toContain("from '__app/App.js'");
        expect(result).toContain("from '__app/utils.js'");
    });

    it("leaves unknown files unchanged", async () => {
        const { _rewriteLocalImports } = await loadPyodide();
        const known = new Set(["App.js"]);
        const code = `import { x } from './unknown.js';`;
        const result = _rewriteLocalImports(code, known);
        expect(result).toBe(code);
    });

    it("rewrites default imports", async () => {
        const { _rewriteLocalImports } = await loadPyodide();
        const known = new Set(["App.js"]);
        const result = _rewriteLocalImports(`import App from './App.js';`, known);
        expect(result).toContain("from '__app/App.js'");
    });

    it("rewrites export-from", async () => {
        const { _rewriteLocalImports } = await loadPyodide();
        const known = new Set(["utils.js"]);
        const result = _rewriteLocalImports(`export { helper } from './utils.js';`, known);
        expect(result).toContain("from '__app/utils.js'");
    });

    it("rewrites export * from", async () => {
        const { _rewriteLocalImports } = await loadPyodide();
        const known = new Set(["utils.js"]);
        const result = _rewriteLocalImports(`export * from './utils.js';`, known);
        expect(result).toContain("from '__app/utils.js'");
    });

    it("rewrites side-effect imports", async () => {
        const { _rewriteLocalImports } = await loadPyodide();
        const known = new Set(["init.js"]);
        const result = _rewriteLocalImports(`import './init.js';`, known);
        expect(result).toContain("import '__app/init.js'");
    });

    it("rewrites dynamic imports", async () => {
        const { _rewriteLocalImports } = await loadPyodide();
        const known = new Set(["lazy.js"]);
        const result = _rewriteLocalImports(`const mod = await import('./lazy.js');`, known);
        expect(result).toContain("import('__app/lazy.js')");
    });

    it("handles nested paths", async () => {
        const { _rewriteLocalImports } = await loadPyodide();
        const known = new Set(["components/Header.js"]);
        const result = _rewriteLocalImports(`import { Header } from './components/Header.js';`, known);
        expect(result).toContain("from '__app/components/Header.js'");
    });

    it("does not rewrite CDN/absolute imports", async () => {
        const { _rewriteLocalImports } = await loadPyodide();
        const known = new Set(["App.js"]);
        const code = `import { html } from 'https://esm.sh/htm/preact/standalone';`;
        const result = _rewriteLocalImports(code, known);
        expect(result).toBe(code);
    });

    it("handles double-quoted imports", async () => {
        const { _rewriteLocalImports } = await loadPyodide();
        const known = new Set(["App.js"]);
        const result = _rewriteLocalImports(`import App from "./App.js";`, known);
        expect(result).toContain(`from "__app/App.js"`);
    });

    it("resolves imports relative to importing file's directory", async () => {
        const { _rewriteLocalImports } = await loadPyodide();
        const known = new Set(["game/constants.js", "game/logic.js"]);
        const code = `import { TILE_SIZE } from './constants.js';`;
        const result = _rewriteLocalImports(code, known, "game/");
        expect(result).toContain(`from '__app/game/constants.js'`);
    });

    it("resolves parent-relative imports from subdirectory", async () => {
        const { _rewriteLocalImports } = await loadPyodide();
        const known = new Set(["utils.js", "game/logic.js"]);
        const code = `import { helper } from '../utils.js';`;
        // ../utils.js from game/ resolves to utils.js at root
        const result = _rewriteLocalImports(code, known, "game/");
        expect(result).toContain(`from '__app/utils.js'`);
    });

    it("resolves parent-relative imports from nested subdirectory", async () => {
        const { _rewriteLocalImports } = await loadPyodide();
        const known = new Set(["js/config.js", "js/dungeon/generator.js"]);
        const code = `import { CONFIG } from '../config.js';`;
        // ../config.js from js/dungeon/ resolves to js/config.js
        const result = _rewriteLocalImports(code, known, "js/dungeon/");
        expect(result).toContain(`from '__app/js/config.js'`);
    });

    it("resolves multi-level parent-relative imports", async () => {
        const { _rewriteLocalImports } = await loadPyodide();
        const known = new Set(["utils.js", "js/dungeon/generator.js"]);
        const code = `import { helper } from '../../utils.js';`;
        // ../../utils.js from js/dungeon/ resolves to utils.js at root
        const result = _rewriteLocalImports(code, known, "js/dungeon/");
        expect(result).toContain(`from '__app/utils.js'`);
    });

    it("parent-relative path to unknown file is left unchanged", async () => {
        const { _rewriteLocalImports } = await loadPyodide();
        const known = new Set(["game/logic.js"]);
        const code = `import { x } from '../missing.js';`;
        const result = _rewriteLocalImports(code, known, "game/");
        expect(result).toBe(code);
    });

    it("rewrites parent-relative dynamic imports", async () => {
        const { _rewriteLocalImports } = await loadPyodide();
        const known = new Set(["utils.js", "game/logic.js"]);
        const code = `const mod = await import('../utils.js');`;
        const result = _rewriteLocalImports(code, known, "game/");
        expect(result).toContain(`import('__app/utils.js')`);
    });

    it("rewrites parent-relative double-quoted imports", async () => {
        const { _rewriteLocalImports } = await loadPyodide();
        const known = new Set(["utils.js", "game/logic.js"]);
        const code = `import { x } from "../utils.js";`;
        const result = _rewriteLocalImports(code, known, "game/");
        expect(result).toContain(`from "__app/utils.js"`);
    });

    it("rewrites parent-relative export-from", async () => {
        const { _rewriteLocalImports } = await loadPyodide();
        const known = new Set(["utils.js", "game/logic.js"]);
        const code = `export { helper } from '../utils.js';`;
        const result = _rewriteLocalImports(code, known, "game/");
        expect(result).toContain(`from '__app/utils.js'`);
    });

    it("rewrites parent-relative side-effect imports", async () => {
        const { _rewriteLocalImports } = await loadPyodide();
        const known = new Set(["init.js", "game/logic.js"]);
        const code = `import '../init.js';`;
        const result = _rewriteLocalImports(code, known, "game/");
        expect(result).toContain(`import '__app/init.js'`);
    });

    it("rewrites mixed ./ and ../ imports in same file", async () => {
        const { _rewriteLocalImports } = await loadPyodide();
        const known = new Set([
            "js/config.js",
            "js/dungeon/helpers.js",
            "js/dungeon/generator.js",
        ]);
        const code =
            `import { CONFIG } from '../config.js';\n` +
            `import { helper } from './helpers.js';`;
        const result = _rewriteLocalImports(code, known, "js/dungeon/");
        expect(result).toContain(`from '__app/js/config.js'`);
        expect(result).toContain(`from '__app/js/dungeon/helpers.js'`);
    });

    it("handles ../ into a sibling subdirectory", async () => {
        const { _rewriteLocalImports } = await loadPyodide();
        const known = new Set(["js/shop/items.js", "js/dungeon/generator.js"]);
        const code = `import { items } from '../shop/items.js';`;
        const result = _rewriteLocalImports(code, known, "js/dungeon/");
        expect(result).toContain(`from '__app/js/shop/items.js'`);
    });

    it("root-level imports still work without baseDir", async () => {
        const { _rewriteLocalImports } = await loadPyodide();
        const known = new Set(["game/constants.js"]);
        const code = `import { X } from './game/constants.js';`;
        const result = _rewriteLocalImports(code, known);
        expect(result).toContain(`from '__app/game/constants.js'`);
    });

    it("rewrites absolute /app/ imports", async () => {
        const { _rewriteLocalImports } = await loadPyodide();
        const known = new Set(["game/constants.js"]);
        const code = `import { TILE_SIZE } from '/app/game/constants.js';`;
        const result = _rewriteLocalImports(code, known);
        expect(result).toContain(`from '__app/game/constants.js'`);
    });

    it("rewrites dynamic absolute /app/ imports", async () => {
        const { _rewriteLocalImports } = await loadPyodide();
        const known = new Set(["game/logic.js"]);
        const code = `const mod = await import('/app/game/logic.js');`;
        const result = _rewriteLocalImports(code, known);
        expect(result).toContain(`import('__app/game/logic.js')`);
    });
});

describe("buildAppHtml multi-file", () => {
    it("inlines CSS link tags", async () => {
        const { buildAppHtml } = await loadPyodide();
        const result = buildAppHtml({
            'app/index.html': '<html><head><link rel="stylesheet" href="./style.css"></head><body></body></html>',
            'app/style.css': 'body { color: red; }',
        });
        expect(result).toContain('<style>body { color: red; }</style>');
        expect(result).not.toContain('href="./style.css"');
    });

    it("inlines CSS link tags with no `./` prefix", async () => {
        // Agent-reported: `<link href="style.css">` (no leading `./`)
        // is valid HTML and a common pattern, but the previous
        // inlining regex required `./` and silently let the no-prefix
        // form 404 against the iframe's blob: URL.
        const { buildAppHtml } = await loadPyodide();
        const result = buildAppHtml({
            'app/index.html': '<html><head><link rel="stylesheet" href="style.css"></head><body></body></html>',
            'app/style.css': 'body { color: red; }',
        });
        expect(result).toContain('<style>body { color: red; }</style>');
        expect(result).not.toContain('href="style.css"');
    });

    it("leaves external CSS link tags alone (not in appFiles)", async () => {
        // The inlining regex only matches files in `appFiles` (escaped
        // by name), so external URLs like Google Fonts pass through
        // as-is for the browser to fetch. This is what made the
        // CSP `style-src https:` change useful.
        const { buildAppHtml } = await loadPyodide();
        const result = buildAppHtml({
            'app/index.html':
                '<html><head>' +
                '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">' +
                '</head><body></body></html>',
        });
        expect(result).toContain('https://fonts.googleapis.com/css2?family=Inter');
    });

    it("adds JS files to import map as data URIs", async () => {
        const { buildAppHtml } = await loadPyodide();
        const result = buildAppHtml({
            'app/index.html': '<html><head></head><body><script type="module">import { App } from \'./App.js\';</script></body></html>',
            'app/App.js': 'export function App() { return "hello"; }',
        });
        expect(result).toContain('"__app/App.js"');
        expect(result).toContain('data:text/javascript;charset=utf-8,');
        // The inline script should be rewritten too
        expect(result).toContain("from '__app/App.js'");
    });

    it("replaces module script src with import map reference", async () => {
        const { buildAppHtml } = await loadPyodide();
        const result = buildAppHtml({
            'app/index.html': '<html><head></head><body><script type="module" src="./App.js"></script></body></html>',
            'app/App.js': 'console.log("hello");',
        });
        expect(result).toContain("import '__app/App.js'");
        expect(result).not.toContain('src="./App.js"');
    });

    it("inlines non-module script src directly", async () => {
        const { buildAppHtml } = await loadPyodide();
        const result = buildAppHtml({
            'app/index.html': '<html><head></head><body><script src="./legacy.js"></script></body></html>',
            'app/legacy.js': 'var x = 1;',
        });
        expect(result).toContain('<script>var x = 1;</script>');
    });

    it("rewrites nested imports between app files", async () => {
        const { buildAppHtml } = await loadPyodide();
        const result = buildAppHtml({
            'app/index.html': '<html><head></head><body><script type="module" src="./App.js"></script></body></html>',
            'app/App.js': 'import { utils } from \'./utils.js\';\nconsole.log(utils);',
            'app/utils.js': 'export const utils = 42;',
        });
        // Both files should be in the import map
        expect(result).toContain('"__app/App.js"');
        expect(result).toContain('"__app/utils.js"');
        // App.js content in the data URI should have rewritten imports
        const importMap = result.match(/<script type="importmap">([\s\S]*?)<\/script>/);
        expect(importMap).not.toBeNull();
        const map = JSON.parse(importMap[1]);
        const appJsUri = map.imports['__app/App.js'];
        const appJsContent = decodeURIComponent(appJsUri.replace('data:text/javascript;charset=utf-8,', ''));
        expect(appJsContent).toContain("from '__app/utils.js'");
    });

    it("preserves CDN imports in the merged import map", async () => {
        const { buildAppHtml } = await loadPyodide();
        const result = buildAppHtml({
            'app/index.html': '<html><head></head><body></body></html>',
            'app/App.js': 'export const x = 1;',
        });
        const importMap = result.match(/<script type="importmap">([\s\S]*?)<\/script>/);
        const map = JSON.parse(importMap[1]);
        expect(map.imports['preact']).toContain('esm.sh');
        expect(map.imports['htm']).toContain('esm.sh');
        expect(map.imports['__app/App.js']).toContain('data:');
    });

    it("works with single-file apps (no extra files)", async () => {
        const { buildAppHtml } = await loadPyodide();
        const result = buildAppHtml({
            'app/index.html': '<html><head></head><body><h1>Hello</h1></body></html>',
        });
        expect(result).toContain('<h1>Hello</h1>');
        expect(result).toContain('importmap');
        // Should still have CDN imports
        const importMap = result.match(/<script type="importmap">([\s\S]*?)<\/script>/);
        const map = JSON.parse(importMap[1]);
        expect(map.imports['preact']).toBeDefined();
    });

    it("handles self-closing link tags", async () => {
        const { buildAppHtml } = await loadPyodide();
        const result = buildAppHtml({
            'app/index.html': '<html><head><link rel="stylesheet" href="./style.css" /></head><body></body></html>',
            'app/style.css': '.app { margin: 0; }',
        });
        expect(result).toContain('<style>.app { margin: 0; }</style>');
    });
});

describe("buildAppStorageShim", () => {
    it("injects the seed dict as literal JSON", async () => {
        const { buildAppStorageShim } = await loadPyodide();
        const shim = buildAppStorageShim({ seed: { score: "42", name: "alice" } });
        expect(shim).toContain('"score":"42"');
        expect(shim).toContain('"name":"alice"');
    });

    it("defaults to writeable=true", async () => {
        const { buildAppStorageShim } = await loadPyodide();
        const shim = buildAppStorageShim({ seed: {} });
        // `__writeable = true` assigned verbatim in the shim source
        expect(shim).toContain("__writeable = true");
    });

    it("respects writeable=false for read-only mode", async () => {
        const { buildAppStorageShim } = await loadPyodide();
        const shim = buildAppStorageShim({ seed: {}, writeable: false });
        expect(shim).toContain("__writeable = false");
    });

    it("escapes </script sequences in the seed to prevent HTML breakout", async () => {
        const { buildAppStorageShim } = await loadPyodide();
        const shim = buildAppStorageShim({
            seed: { evil: "</script><script>alert(1)</script>" },
        });
        // Exactly one </script> should remain — the shim's own closing
        // tag. Any from the seed payload must be neutralized, otherwise
        // the browser would close the shim element early and execute
        // the injected payload.
        const matches = shim.match(/<\/script>/g) || [];
        expect(matches.length).toBe(1);
        expect(shim).toContain('alert(1)');  // payload is still there, just neutered
        expect(shim).toContain('<\\/script');  // escaped form
    });

    it("installs localStorage, sessionStorage, and indexedDB", async () => {
        const { buildAppStorageShim } = await loadPyodide();
        const shim = buildAppStorageShim({ seed: {} });
        expect(shim).toContain("'localStorage'");
        expect(shim).toContain("'sessionStorage'");
        expect(shim).toContain("'indexedDB'");
    });

    it("includes a quota that matches the Python side (~5MB)", async () => {
        const { buildAppStorageShim } = await loadPyodide();
        const shim = buildAppStorageShim({ seed: {} });
        expect(shim).toContain("5 * 1024 * 1024");
    });
});

describe("buildAppHtml with appStorage", () => {
    it("injects the shim before the query bridge", async () => {
        const { buildAppHtml } = await loadPyodide();
        const result = buildAppHtml(
            { 'app/index.html': '<html><head></head><body></body></html>' },
            { appStorage: { seed: { k: "v" } } },
        );
        // Seed must be present, and the shim must precede the query bridge
        // so app modules see localStorage before they start making queries.
        expect(result).toContain('"k":"v"');
        const shimIdx = result.indexOf('__writeable');
        const queryIdx = result.indexOf('window.query');
        expect(shimIdx).toBeGreaterThan(-1);
        expect(queryIdx).toBeGreaterThan(-1);
        expect(shimIdx).toBeLessThan(queryIdx);
    });

    it("still injects a shim (empty seed) when no appStorage option provided", async () => {
        const { buildAppHtml } = await loadPyodide();
        const result = buildAppHtml({
            'app/index.html': '<html><head></head><body></body></html>',
        });
        expect(result).toContain("__writeable");
        expect(result).toContain("'localStorage'");
    });
});

describe("setQueryHandler", () => {
    it("exports setQueryHandler", async () => {
        const mod = await loadPyodide();
        expect(typeof mod.setQueryHandler).toBe("function");
    });
});

describe("setLiveIframe", () => {
    it("exports setLiveIframe", async () => {
        const mod = await loadPyodide();
        expect(typeof mod.setLiveIframe).toBe("function");
    });
});

describe("test-app message routing", () => {
    it("forwards test-app messages from worker", async () => {
        const { startWorker } = await loadPyodide();
        startWorker();
        const w = MockWorker.instances[0];
        w._receive({ type: "ready" });

        // The worker sends a test-app message — main thread should handle it.
        // We can't fully test the iframe lifecycle in unit tests, but we can
        // verify the message handler doesn't throw on test-app messages.
        expect(() => {
            w._receive({
                type: "test-app",
                id: 1,
                appFilesJson: JSON.stringify({ "app/index.html": "<html></html>" }),
                actionsJson: null,
            });
        }).not.toThrow();
    });

    it("forwards test-app messages with actions", async () => {
        const { startWorker } = await loadPyodide();
        startWorker();
        const w = MockWorker.instances[0];
        w._receive({ type: "ready" });

        const actions = [
            { click: "#btn" },
            { type: "#input", value: "hello" },
            { select: "#dropdown", value: "opt1" },
            { read: "#output" },
            { eval: "1+1" },
            { wait: 100 },
        ];

        expect(() => {
            w._receive({
                type: "test-app",
                id: 2,
                appFilesJson: JSON.stringify({ "app/index.html": "<html></html>" }),
                actionsJson: JSON.stringify(actions),
            });
        }).not.toThrow();
    });

    it("forwards live-app messages", async () => {
        const { startWorker } = await loadPyodide();
        startWorker();
        const w = MockWorker.instances[0];
        w._receive({ type: "ready" });

        expect(() => {
            w._receive({
                type: "live-app",
                id: 1,
                actionsJson: JSON.stringify([{ read: "#date-input", prop: "value" }]),
            });
        }).not.toThrow();
    });
});
