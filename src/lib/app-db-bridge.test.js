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

    it("send back a database that wouldn't open as the call's error", async () => {
        const reply = await answerDb({ id: "a", op: "query", args: ["SELECT 1"] }, () => Promise.reject(new Error("no worker")));
        expect(reply.error).toEqual({ name: "Error", message: "no worker" });
    });
});
