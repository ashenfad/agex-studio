import { describe, expect, it } from "vitest";
import { dbRestores } from "./db-restore.svelte.js";

const checkpoint = { id: "c1", label: "before", auto: false, time: 0 };

describe("restores waiting on the person", () => {
    it("asks once per database, and answers with what the person said", async () => {
        const asked = dbRestores.ask("s-1", "s-1", checkpoint);
        await expect(dbRestores.ask("s-1", "s-1.scout", checkpoint)).rejects.toThrow(/waiting on the person/);
        expect(dbRestores.asking["s-1"]).toMatchObject({ checkpoint, asker: "s-1" });
        dbRestores.asking["s-1"]?.answer(true);
        expect(await asked).toBe(true);
        expect(dbRestores.asking["s-1"]).toBeUndefined();
    });

    it("takes a question left open when its turn ended as a no", async () => {
        const asked = dbRestores.ask("s-2", "s-2.scout", checkpoint);
        dbRestores.cancel("s-2");
        expect(dbRestores.asking["s-2"]).toBeDefined();
        dbRestores.cancel("s-2.scout");
        expect(await asked).toBe(false);
    });

    it("counts restores for the apps to reload on", () => {
        const before = dbRestores.restored.count;
        dbRestores.announce("db-1");
        expect(dbRestores.restored).toEqual({ count: before + 1, id: "db-1", cause: "restore" });
    });

    it("counts a sync that changed a database too, saying it was a sync", () => {
        const before = dbRestores.restored.count;
        dbRestores.announce("db-1", "sync");
        expect(dbRestores.restored).toEqual({ count: before + 1, id: "db-1", cause: "sync" });
    });
});
