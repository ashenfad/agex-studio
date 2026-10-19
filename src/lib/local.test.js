import { afterEach, describe, expect, it, vi } from "vitest";
import { readLocal, readLocalJson, writeLocal, writeLocalJson } from "./local.js";

/** A localStorage that keeps what it's given. */
function memory() {
    /** @type {Map<string, string>} */
    const kept = new Map();
    return {
        getItem: (/** @type {string} */ k) => kept.get(k) ?? null,
        setItem: (/** @type {string} */ k, /** @type {string} */ v) => void kept.set(k, String(v)),
    };
}

const blocked = () => {
    throw new DOMException("blocked", "SecurityError");
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("the studio's notes in localStorage", () => {
    it("reads back what was written", () => {
        vi.stubGlobal("localStorage", memory());
        expect(readLocal("agex-x")).toBeNull();
        expect(writeLocal("agex-x", "on")).toBe(true);
        expect(readLocal("agex-x")).toBe("on");
    });

    it("finds nothing, and keeps nothing, where storage is blocked", () => {
        vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked });
        expect(readLocal("agex-x")).toBeNull();
        expect(writeLocal("agex-x", "on")).toBe(false);
    });

    it("says a write that runs out of room wasn't kept", () => {
        vi.stubGlobal("localStorage", {
            getItem: () => null,
            setItem: () => {
                throw new DOMException("full", "QuotaExceededError");
            },
        });
        expect(writeLocalJson("agex-x", { a: 1 })).toBe(false);
    });

    it("reads back JSON written as JSON", () => {
        vi.stubGlobal("localStorage", memory());
        expect(readLocalJson("agex-x")).toBeNull();
        writeLocalJson("agex-x", { at: 3, models: ["m"] });
        expect(readLocalJson("agex-x")).toEqual({ at: 3, models: ["m"] });
    });

    it("finds nothing where what's kept isn't JSON", () => {
        vi.stubGlobal("localStorage", memory());
        writeLocal("agex-x", "{not json");
        expect(readLocalJson("agex-x")).toBeNull();
    });
});
