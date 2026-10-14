import { beforeEach, describe, expect, it, vi } from "vitest";

// esbuild-wasm isn't run in tests anywhere in this repo (heavy; see
// esbuild-terminal.test.js, which stubs runEsbuild). Mock it here too
// so we exercise bundleAppWorkers' orchestration — entry discovery,
// per-worker options, prefix stripping, error surfacing — without a
// real bundle. The esm.sh rewrite itself lives in esbuild-bridge.js
// and is verified live.
vi.mock("./esbuild-bridge.js", () => ({ runEsbuild: vi.fn() }));

import { runEsbuild } from "./esbuild-bridge.js";
import { bundleAppWorkers, buildAppHtml } from "./app-html.js";

beforeEach(() => {
    runEsbuild.mockReset();
    runEsbuild.mockImplementation(async ({ entryPoint }) => ({
        contents: `/*bundled:${entryPoint}*/`,
        errors: [],
        warnings: [],
    }));
});

describe("bundleAppWorkers", () => {
    it("bundles only *.worker.js entries, stripping the app/ prefix", async () => {
        const out = await bundleAppWorkers({
            "app/index.js": "main",
            "app/sim.worker.js": "export const x = 1",
            "app/lib/heavy.worker.js": "export const y = 2",
            "app/notaworker.js": "nope",
        });
        expect(Object.keys(out).sort()).toEqual(["lib/heavy.worker.js", "sim.worker.js"]);
        expect(out["sim.worker.js"]).toContain("bundled:app/sim.worker.js");
    });

    it("requests an ESM bundle with bare imports rewritten to esm.sh URLs", async () => {
        await bundleAppWorkers({ "app/sim.worker.js": "x" });
        expect(runEsbuild).toHaveBeenCalledWith(
            expect.objectContaining({
                entryPoint: "app/sim.worker.js",
                format: "esm",
                bareImports: "esm-url",
            }),
        );
    });

    it("does not load esbuild when there are no workers", async () => {
        const out = await bundleAppWorkers({ "app/index.js": "main" });
        expect(out).toEqual({});
        expect(runEsbuild).not.toHaveBeenCalled();
    });

    it("throws a worker-scoped message on a build error", async () => {
        runEsbuild.mockResolvedValueOnce({
            contents: null,
            errors: [{ text: "Unexpected token" }],
            warnings: [],
        });
        await expect(
            bundleAppWorkers({ "app/bad.worker.js": "import {" }),
        ).rejects.toThrow(/worker build failed for app\/bad\.worker\.js: Unexpected token/);
    });
});

describe("buildAppHtml worker registry injection", () => {
    const indexHtml = "<html><head></head><body></body></html>";

    it("injects appWorker + the bundled sources when workerSources are given", async () => {
        const html = await buildAppHtml(
            { "app/index.html": indexHtml },
            { workerSources: { "sim.worker.js": "self.onmessage=()=>{}" } },
        );
        expect(html).toContain("window.appWorker");
        expect(html).toContain("__agexWorkerSrc");
        expect(html).toContain("self.onmessage=()=>{}");
        expect(html).toContain('type:"module"'); // launched as a module worker
        // No esbuild load when sources are supplied directly.
        expect(runEsbuild).not.toHaveBeenCalled();
    });

    it("escapes </script> in bundled source so it can't break out of the tag", async () => {
        const html = await buildAppHtml(
            { "app/index.html": indexHtml },
            { workerSources: { "x.worker.js": 'var s="</script><b>pwned"' } },
        );
        expect(html).not.toContain("</script><b>pwned"); // raw breakout absent
        expect(html).toContain("\\u003c/script>\\u003cb>pwned"); // escaped form present
    });

    it("emits no registry when there are no workers", async () => {
        const html = await buildAppHtml({ "app/index.html": indexHtml }, { workerSources: {} });
        expect(html).not.toContain("window.appWorker");
        expect(html).not.toContain("__agexWorkerSrc");
    });
});
