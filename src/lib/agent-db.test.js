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
    const client = {
        query: vi.fn(async () => ({ rows: [{ n: 1 }], changes: 0, lastInsertRowid: 0 })),
        transaction: vi.fn(async (/** @type {unknown[]} */ s) => s.map(() => ({ rows: [], changes: 1, lastInsertRowid: 0 }))),
    };
    const dbFor = vi.fn(async () => /** @type {any} */ (client));
    /** @param {string} session */
    const db = (session) => new AgentDb(/** @type {any} */ ({ session }), { dbs: { dbFor }, store: async () => store });
    return { db, dbFor, client };
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
});
