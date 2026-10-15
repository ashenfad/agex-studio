// @vitest-environment jsdom
// jsdom fetches no scripts, so each test settles a script's load itself
// by firing its `load` or `error` event.
import { afterEach, describe, expect, it, vi } from "vitest";
import { _setImporterForTesting, loadModule, loadScript } from "./cdn.js";

afterEach(() => {
    _setImporterForTesting(null);
    delete (/** @type {any} */ (window)).Fake;
    for (const s of document.head.querySelectorAll("script")) s.remove();
});

describe("loadModule", () => {
    it("imports a URL once, however many ask, while under way and after", async () => {
        /** @type {(mod: any) => void} */
        let finish = () => {};
        const importer = vi.fn(() => new Promise((resolve) => (finish = resolve)));
        _setImporterForTesting(importer);
        const setup = vi.fn((mod) => ({ configured: mod.name }));
        const first = loadModule("https://cdn.test/a.mjs", setup);
        const second = loadModule("https://cdn.test/a.mjs", setup);
        expect(second).toBe(first);
        finish({ name: "a" });
        expect(await first).toEqual({ configured: "a" });
        expect(await loadModule("https://cdn.test/a.mjs", setup)).toEqual({ configured: "a" });
        expect(importer).toHaveBeenCalledTimes(1);
        expect(setup).toHaveBeenCalledTimes(1);
    });

    it("keeps each URL's load apart", async () => {
        const importer = vi.fn(async (url) => ({ url }));
        _setImporterForTesting(importer);
        expect(await loadModule("https://cdn.test/a.mjs")).toEqual({ url: "https://cdn.test/a.mjs" });
        expect(await loadModule("https://cdn.test/b.mjs")).toEqual({ url: "https://cdn.test/b.mjs" });
        expect(importer).toHaveBeenCalledTimes(2);
    });

    it("forgets a failed import, so a later call tries again", async () => {
        const importer = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ ok: true });
        _setImporterForTesting(importer);
        const first = loadModule("https://cdn.test/a.mjs");
        const second = loadModule("https://cdn.test/a.mjs");
        await expect(first).rejects.toThrow("offline");
        await expect(second).rejects.toThrow("offline");
        expect(await loadModule("https://cdn.test/a.mjs")).toEqual({ ok: true });
        expect(importer).toHaveBeenCalledTimes(2);
    });

    it("forgets a load whose setup throws", async () => {
        _setImporterForTesting(async () => ({}));
        let calls = 0;
        const setup = () => {
            if (++calls === 1) throw new Error("bad setup");
            return "ready";
        };
        await expect(loadModule("https://cdn.test/a.mjs", setup)).rejects.toThrow("bad setup");
        expect(await loadModule("https://cdn.test/a.mjs", setup)).toBe("ready");
    });
});

describe("loadScript", () => {
    const SRC = "https://cdn.test/fake.js";
    const scripts = () => [...document.head.querySelectorAll("script")];

    it("adds one script for every caller, and resolves to its global", async () => {
        const loads = [loadScript(SRC, "Fake"), loadScript(SRC, "Fake"), loadScript(SRC, "Fake")];
        expect(scripts()).toHaveLength(1);
        expect(scripts()[0].src).toBe(SRC);
        (/** @type {any} */ (window)).Fake = { draw: true };
        scripts()[0].dispatchEvent(new Event("load"));
        for (const load of loads) expect(await load).toEqual({ draw: true });
        expect(await loadScript(SRC, "Fake")).toEqual({ draw: true });
        expect(scripts()).toHaveLength(1);
    });

    it("adds nothing when the global is already there", async () => {
        (/** @type {any} */ (window)).Fake = "here";
        expect(await loadScript(SRC, "Fake")).toBe("here");
        expect(scripts()).toHaveLength(0);
    });

    it("removes a script that failed, and a later call adds a fresh one", async () => {
        const first = loadScript(SRC, "Fake");
        const again = loadScript(SRC, "Fake");
        scripts()[0].dispatchEvent(new Event("error"));
        await expect(first).rejects.toThrow("didn't load");
        await expect(again).rejects.toThrow("didn't load");
        expect(scripts()).toHaveLength(0);

        const retry = loadScript(SRC, "Fake");
        expect(scripts()).toHaveLength(1);
        (/** @type {any} */ (window)).Fake = 1;
        scripts()[0].dispatchEvent(new Event("load"));
        expect(await retry).toBe(1);
    });

    it("fails a script that loads without setting its global", async () => {
        const load = loadScript(SRC, "Fake");
        scripts()[0].dispatchEvent(new Event("load"));
        await expect(load).rejects.toThrow("set no Fake");
        expect(scripts()).toHaveLength(0);
    });
});
