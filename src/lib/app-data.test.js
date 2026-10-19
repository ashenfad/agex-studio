import { Memory } from "@agex-ts/kvgit/backends/memory";
import { Store } from "@agex-ts/world";
import { describe, expect, it } from "vitest";
import { appBranch, commitAppData, moveAppData, readAppData } from "./app-data.js";

describe("app data on a branch of its own", () => {
    it("commits what changed, and nothing for an empty bag never written", async () => {
        const store = await Store.open(new Memory());
        expect(await commitAppData(store, "s-1", { bag: {}, at: 1 })).toBe(false);
        expect(await store.repo.branches.has(appBranch("s-1"))).toBe(false);

        expect(await commitAppData(store, "s-1", { bag: { n: "3" }, at: 10 })).toBe(true);
        expect(await readAppData(store, { branch: appBranch("s-1") })).toEqual({ bag: { n: "3" }, at: 10 });
        // the same data again: nothing to commit
        expect(await commitAppData(store, "s-1", { bag: { n: "3" }, at: 11 })).toBe(false);
        expect(await commitAppData(store, "s-1", { bag: { n: "4" }, at: 12 })).toBe(true);
        // it isn't a session
        expect(await store.sessions()).toEqual([]);
    });

    it("moves to another device's commit", async () => {
        const store = await Store.open(new Memory());
        await commitAppData(store, "s-1", { bag: { n: "1" }, at: 1 });
        const first = await store.repo.branches.get(appBranch("s-1"));
        await commitAppData(store, "s-1", { bag: { n: "2" }, at: 2 });
        await moveAppData(store, "s-1", first);
        expect(await readAppData(store, { branch: appBranch("s-1") })).toEqual({ bag: { n: "1" }, at: 1 });
        expect(await readAppData(store, { branch: appBranch("s-2") })).toBeNull();
    });
});
