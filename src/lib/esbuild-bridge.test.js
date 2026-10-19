import { afterEach, describe, expect, it, vi } from "vitest";
import { _setImporterForTesting } from "./cdn.js";
import { runEsbuild } from "./esbuild-bridge.js";

afterEach(() => _setImporterForTesting(null));

/** An esbuild-wasm stand-in whose build hands back `out`. */
function fakeEsbuild(initialize = vi.fn(async () => {})) {
    return {
        initialize,
        build: vi.fn(async () => ({ outputFiles: [{ text: "out" }], errors: [], warnings: [] })),
    };
}

const ARGS = { files: { "app/index.js": "export {}" }, entryPoint: "app/index.js" };

describe("esbuild-wasm's loading", () => {
    it("tries the import again after one fails", async () => {
        const esbuild = fakeEsbuild();
        const importer = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ default: esbuild });
        _setImporterForTesting(importer);
        await expect(runEsbuild(ARGS)).rejects.toThrow("offline");
        expect((await runEsbuild(ARGS)).contents).toBe("out");
        expect((await runEsbuild(ARGS)).contents).toBe("out");
        expect(importer).toHaveBeenCalledTimes(2);
        expect(esbuild.initialize).toHaveBeenCalledTimes(1);
    });

    it("tries initializing again after it fails", async () => {
        const initialize = vi.fn().mockRejectedValueOnce(new Error("no wasm")).mockResolvedValue(undefined);
        const esbuild = fakeEsbuild(initialize);
        _setImporterForTesting(async () => esbuild);
        await expect(runEsbuild(ARGS)).rejects.toThrow("no wasm");
        expect((await runEsbuild(ARGS)).contents).toBe("out");
        expect(initialize).toHaveBeenCalledTimes(2);
    });
});
