import { describe, expect, it } from "vitest";
import { askPersist, isPersisted } from "./persist.js";

describe("persistent storage", () => {
    it("says whether the browser keeps the studio's storage, or null if it can't", async () => {
        expect(await isPersisted({ persisted: async () => true })).toBe(true);
        expect(await isPersisted({ persisted: async () => false })).toBe(false);
        expect(await isPersisted({})).toBeNull();
        expect(await isPersisted(undefined)).toBeNull();
        expect(await isPersisted({ persisted: async () => Promise.reject(new Error("no")) })).toBeNull();
    });

    it("asks, answering false where it can't", async () => {
        expect(await askPersist({ persist: async () => true })).toBe(true);
        expect(await askPersist({})).toBe(false);
        expect(await askPersist({ persist: async () => Promise.reject(new Error("no")) })).toBe(false);
    });
});
