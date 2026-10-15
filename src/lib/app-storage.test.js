import { beforeEach, describe, expect, it, vi } from "vitest";
import { APP_STORAGE_QUOTA, checkBag, read, write } from "./app-storage.js";

/** Keys whose `setItem` throws, as a full storage would. */
let full = /** @type {(key: string) => boolean} */ (() => false);

// an in-memory localStorage: Node's own global (Node 22+) has none of
// the methods without a backing file
beforeEach(() => {
    full = () => false;
    const items = new Map();
    vi.stubGlobal("localStorage", {
        get length() { return items.size; },
        key: (i) => [...items.keys()][i] ?? null,
        getItem: (k) => items.get(k) ?? null,
        setItem: (k, v) => {
            if (full(k)) throw new Error("full");
            items.set(k, String(v));
        },
        removeItem: (k) => items.delete(k),
    });
});

describe("checkBag", () => {
    it("takes a plain object of strings within the quota", () => {
        expect(checkBag({ a: "1", b: "$$5" })).toEqual({ a: "1", b: "$$5" });
        expect(checkBag({})).toEqual({});
    });

    it("refuses what the shim would never have posted", () => {
        expect(checkBag(null)).toBeNull();
        expect(checkBag("a=1")).toBeNull();
        expect(checkBag(["1"])).toBeNull();
        expect(checkBag({ a: 1 })).toBeNull();
        expect(checkBag({ a: { nested: "x" } })).toBeNull();
        expect(checkBag(new Map([["a", "1"]]))).toBeNull();
    });

    it("refuses a bag past the shim's quota, measured as the shim does", () => {
        const fits = { k: "x".repeat(APP_STORAGE_QUOTA - JSON.stringify({ k: "" }).length) };
        expect(checkBag(fits)).toBe(fits);
        expect(checkBag({ k: fits.k + "x" })).toBeNull();
    });
});

describe("write", () => {
    it("replaces the bag", () => {
        write("ts", "s1", { a: "1", b: "2" });
        write("ts", "s1", { b: "3", c: "$&" });
        expect(read("ts", "s1")).toEqual({ b: "3", c: "$&" });
    });

    it("leaves the bag as it was when the studio's storage runs out", () => {
        write("ts", "s1", { a: "1", b: "2" });
        write("ts", "other", { z: "9" });
        full = (key) => key.endsWith(":big");
        expect(() => write("ts", "s1", { a: "new", big: "x", c: "3" })).toThrow(/full/);
        expect(read("ts", "s1")).toEqual({ a: "1", b: "2" });
        expect(read("ts", "other")).toEqual({ z: "9" });
    });
});
