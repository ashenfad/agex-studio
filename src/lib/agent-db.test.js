import { Memory } from "@agex-ts/kvgit/backends/memory";
import { Store } from "@agex-ts/world";
import { describe, expect, it, vi } from "vitest";
import { AgentDb } from "./agent-db.js";

/** A store holding session `s-1`, and a stand-in for the page's
 *  databases that records which session's was asked for. */
async function setup() {
    const store = await Store.open(new Memory());
    const ws = await store.open("s-1");
    await ws.autoCommit({ tool: "test" });
    await ws.close();
    const cp = { id: "kvsql/checkpoint/db/x/3-ab", label: "before", auto: false, seq: 3, schema: 1, time: Date.UTC(2026, 9, 17), commit: "c3" };
    const client = {
        query: vi.fn(async () => ({ rows: [{ n: 1 }], changes: 0, lastInsertRowid: 0 })),
        transaction: vi.fn(async (/** @type {unknown[]} */ s) => s.map(() => ({ rows: [], changes: 1, lastInsertRowid: 0 }))),
        checkpoint: vi.fn(async () => cp),
        checkpoints: vi.fn(async () => [cp]),
        info: vi.fn(async () => ({ base: "c5", pendingCount: 0 })),
    };
    const dbFor = vi.fn(async () => /** @type {any} */ (client));
    const restore = vi.fn(async () => /** @type {any} */ ({ how: "undo", undone: 2, checkpoint: cp, seq: 6, branch: "db/x/0" }));
    const ask = vi.fn(async () => true);
    /** @param {string} session */
    const db = (session) =>
        new AgentDb(/** @type {any} */ ({ session }), { dbs: { dbFor, restore }, store: async () => store, ask });
    return { db, dbFor, client, restore, ask, cp };
}

describe("the agent's db", () => {
    it("runs on the session's database, a statement or several", async () => {
        const { db, dbFor, client } = await setup();
        const mine = db("s-1");
        expect(await mine.query("SELECT 1 AS n")).toEqual({ rows: [{ n: 1 }], changes: 0, lastInsertRowid: 0 });
        expect(client.query).toHaveBeenCalledWith("SELECT 1 AS n", null);
        await mine.query("SELECT ?", [2]);
        expect(client.query).toHaveBeenLastCalledWith("SELECT ?", [2]);
        await mine.transaction(["DELETE FROM t", ["INSERT INTO t VALUES (?)", [1]]]);
        expect(client.transaction).toHaveBeenCalledWith([["DELETE FROM t"], ["INSERT INTO t VALUES (?)", [1]]]);
        expect(dbFor).toHaveBeenCalledTimes(1);
        expect(dbFor).toHaveBeenCalledWith("s-1");
    });

    it("lists the app's schema, without SQLite's or the log's own tables", async () => {
        const { db, client } = await setup();
        await db("s-1").tables();
        expect(client.query).toHaveBeenCalledWith(expect.stringMatching(/FROM sqlite_schema WHERE substr\(name, 1, 7\) NOT IN \('sqlite_', '_kvsql_'\)/));
    });

    it("gives a delegate its lead's", async () => {
        const { db, dbFor } = await setup();
        await db("s-1.scout").query("SELECT 1");
        expect(dbFor).toHaveBeenCalledWith("s-1");
    });

    it("refuses a world that isn't a studio session, naming no database for it", async () => {
        const { db, dbFor } = await setup();
        await expect(db("summarize-1a2b3c4d").query("SELECT 1")).rejects.toThrow(/isn't a studio session/);
        expect(dbFor).not.toHaveBeenCalled();
    });

    it("takes and lists checkpoints, their times as ISO strings", async () => {
        const { db, client } = await setup();
        const shown = { id: "kvsql/checkpoint/db/x/3-ab", label: "before", auto: false, time: "2026-10-17T00:00:00.000Z", seq: 3 };
        expect(await db("s-1").checkpoint("before")).toEqual(shown);
        expect(client.checkpoint).toHaveBeenCalledWith("before");
        expect(await db("s-1").checkpoints()).toEqual([shown]);
    });

    it("restores once the person allows it, asking for the lead's database", async () => {
        const { db, restore, ask } = await setup();
        expect(await db("s-1.scout").restore("kvsql/checkpoint/db/x/3-ab")).toMatchObject({ how: "undo", undone: 2, checkpoint: { label: "before" } });
        expect(ask).toHaveBeenCalledWith("s-1", "s-1.scout", { id: "kvsql/checkpoint/db/x/3-ab", label: "before", auto: false, time: Date.UTC(2026, 9, 17) });
        expect(restore).toHaveBeenCalledWith("s-1.scout", "kvsql/checkpoint/db/x/3-ab");
    });

    it("doesn't restore when the person says no, nor asks when there's nothing to undo", async () => {
        const { db, restore, ask, client } = await setup();
        ask.mockResolvedValueOnce(false);
        await expect(db("s-1").restore("kvsql/checkpoint/db/x/3-ab")).rejects.toThrow(/didn't allow the restore/);
        expect(restore).not.toHaveBeenCalled();

        client.info.mockResolvedValueOnce({ base: "c3", pendingCount: 0 });
        await db("s-1").restore("kvsql/checkpoint/db/x/3-ab");
        expect(ask).toHaveBeenCalledTimes(1);
        expect(restore).toHaveBeenCalledTimes(1);

        await expect(db("s-1").restore("nope")).rejects.toThrow(/no checkpoint "nope"/);
    });
});
