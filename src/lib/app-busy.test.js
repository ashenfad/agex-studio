import { describe, expect, it } from "vitest";
import { afterDbChange, busyCount, liveBusy, setLiveBusy } from "./app-busy.js";

describe("a change to an app's database under it", () => {
    it("reloads an idle app, whatever changed it", () => {
        expect(afterDbChange("sync", 0)).toBe("reload");
        expect(afterDbChange("restore", 0)).toBe("reload");
    });

    it("offers the reload to a busy app after a sync, and reloads it after a restore", () => {
        expect(afterDbChange("sync", 2)).toBe("offer");
        expect(afterDbChange("restore", 2)).toBe("reload");
    });
});

describe("the count a busy message carries", () => {
    it("is a whole number above 0, or 0", () => {
        expect(busyCount(3)).toBe(3);
        for (const v of [0, -1, 1.5, "2", null, undefined, NaN, Infinity]) expect(busyCount(v)).toBe(0);
    });
});

describe("the live preview's busy state", () => {
    it("reads as the preview says, and null once it's gone", () => {
        setLiveBusy(() => ({ busy: 1, offered: true }));
        expect(liveBusy()).toEqual({ busy: 1, offered: true });
        setLiveBusy(null);
        expect(liveBusy()).toBeNull();
    });
});
