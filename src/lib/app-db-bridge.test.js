import { describe, expect, it, vi } from "vitest";
import { answerDb, dbError } from "./app-db-bridge.js";

/** A client whose calls answer `result`, or throw `error`. */
function fakeDb({ result = /** @type {unknown} */ (null), error = /** @type {unknown} */ (null) } = {}) {
    const run = vi.fn(async () => {
        if (error !== null) throw error;
        return result;
    });
    return { query: run, transaction: run };
}

describe("an app's agex.db calls", () => {
    it("run a query, and a transaction, on the database given", async () => {
        const db = fakeDb({ result: { rows: [], changes: 1, lastInsertRowid: 7 } });
        const reply = await answerDb({ id: "a", op: "query", args: ["INSERT INTO t VALUES (?)", [1]] }, async () => /** @type {any} */ (db));
        expect(db.query).toHaveBeenCalledWith("INSERT INTO t VALUES (?)", [1]);
        expect(reply).toEqual({ type: "agex-db-result", id: "a", value: { rows: [], changes: 1, lastInsertRowid: 7 }, error: null });

        const statements = [["DELETE FROM t"], ["INSERT INTO t VALUES (?)", [2]]];
        await answerDb({ id: "b", op: "transaction", args: [statements] }, async () => /** @type {any} */ (db));
        expect(db.transaction).toHaveBeenLastCalledWith(statements);
    });

    it("answer a query without params with null ones", async () => {
        const db = fakeDb();
        await answerDb({ id: "a", op: "query", args: ["SELECT 1"] }, async () => /** @type {any} */ (db));
        expect(db.query).toHaveBeenCalledWith("SELECT 1", null);
    });

    it("send back an error's name, message and statement index", async () => {
        const failed = Object.assign(new Error("statement 1: UNIQUE constraint failed: t.id"), { name: "StatementError", index: 1 });
        const reply = await answerDb({ id: "a", op: "transaction", args: [[]] }, async () => /** @type {any} */ (fakeDb({ error: failed })));
        expect(reply.error).toEqual({ name: "StatementError", message: "statement 1: UNIQUE constraint failed: t.id", index: 1 });
        expect(reply.value).toBeNull();
        expect(dbError("plain")).toEqual({ name: "Error", message: "plain" });
    });

    it("refuse a call agex.db doesn't make, without opening the database", async () => {
        const open = vi.fn();
        const reply = await answerDb({ id: "a", op: "delete", args: [] }, open);
        expect(reply.error?.message).toMatch(/agex.db has no call "delete"/);
        expect(open).not.toHaveBeenCalled();
        expect((await answerDb({ id: "b", op: "query" }, open)).error?.name).toBe("TypeError");
    });

    it("run a kv store's call as the database's procedure, making the table when it's missing", async () => {
        let made = false;
        const call = vi.fn(async (/** @type {string} */ name, /** @type {any} */ args) => {
            if (!made) throw new Error("no such table: _agex_kv");
            return name === "kv.get" ? new Uint8Array([args.key.length]) : null;
        });
        const query = vi.fn(async () => {
            made = true;
            return { rows: [], changes: 0, lastInsertRowid: 0 };
        });
        const db = async () => /** @type {any} */ ({ call, query });
        const reply = await answerDb({ id: "k", op: "kv", args: ["get", { store: "default", key: "ab" }] }, db);
        expect(reply).toEqual({ type: "agex-db-result", id: "k", value: new Uint8Array([2]), error: null });
        expect(query).toHaveBeenCalledTimes(1);
        expect(query.mock.calls[0][0]).toMatch(/^CREATE TABLE IF NOT EXISTS _agex_kv /);
        expect(call).toHaveBeenLastCalledWith("kv.get", { store: "default", key: "ab" });
        // a call a store doesn't make never reaches the database
        const open = vi.fn();
        for (const args of [["drop", {}], ["get"], [{}, {}]]) {
            expect((await answerDb({ id: "x", op: "kv", args }, open)).error?.message).toMatch(/agex.kvStore has no call/);
        }
        expect(open).not.toHaveBeenCalled();
    });

    it("send back a database that wouldn't open as the call's error", async () => {
        const reply = await answerDb({ id: "a", op: "query", args: ["SELECT 1"] }, () => Promise.reject(new Error("no worker")));
        expect(reply.error).toEqual({ name: "Error", message: "no worker" });
    });
});

describe("mayHaveWritten", () => {
    it("is whether a call changed rows, or ran anything but a read", async () => {
        const { mayHaveWritten } = await import("./app-db-bridge.js");
        const ok = (/** @type {unknown} */ value) => ({ value, error: null });
        const query = (/** @type {string} */ sql) => ({ op: "query", args: [sql] });
        expect(mayHaveWritten(query("SELECT 1"), ok({ changes: 0 }))).toBe(false);
        expect(mayHaveWritten(query("  select * from t"), ok({ changes: 0 }))).toBe(false);
        expect(mayHaveWritten(query("UPDATE t SET v = 1"), ok({ changes: 2 }))).toBe(true);
        // a schema change changes no rows
        expect(mayHaveWritten(query("CREATE TABLE t (id INTEGER PRIMARY KEY)"), ok({ changes: 0 }))).toBe(true);
        expect(mayHaveWritten({ op: "transaction", args: [[["SELECT 1"], ["ALTER TABLE t ADD c"]]] }, ok([{ changes: 0 }, { changes: 0 }]))).toBe(true);
        expect(mayHaveWritten({ op: "transaction", args: [[["SELECT 1"]]] }, ok([{ changes: 0 }]))).toBe(false);
        // a kv store's writes, but not its reads or a comparison that failed
        const kv = (/** @type {string} */ method) => ({ op: "kv", args: [method, { store: "default" }] });
        expect(mayHaveWritten(kv("set"), ok(null))).toBe(true);
        expect(mayHaveWritten(kv("casMany"), ok(true))).toBe(true);
        expect(mayHaveWritten(kv("cas"), ok(false))).toBe(false);
        expect(mayHaveWritten(kv("get"), ok(null))).toBe(false);
        expect(mayHaveWritten(kv("items"), ok([]))).toBe(false);
        // a failed call changed nothing
        expect(mayHaveWritten(query("DROP TABLE t"), { value: null, error: { name: "Error", message: "no" } })).toBe(false);
    });
});
