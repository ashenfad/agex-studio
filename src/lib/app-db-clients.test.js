import { Memory } from "@agex-ts/kvgit/backends/memory";
import { Store } from "@agex-ts/world";
import { describe, expect, it, vi } from "vitest";
import { AppDbs, DB_LABEL } from "./app-db-clients.js";
import { dbOf } from "./app-db.js";

/** A manager on a store in memory, with a worker and clients that
 *  record what was asked of them. */
async function setup({ failStarts = 0, persist = vi.fn(async () => true), sweep = vi.fn(async () => []) } = {}) {
    const store = await Store.open(new Memory());
    let fails = failStarts;
    const worker = { postMessage() {} };
    const start = vi.fn(async () => {
        if (fails-- > 0) throw new Error("no worker");
        return worker;
    });
    /** @type {{ config: any, client: any }[]} */
    const connected = [];
    const connect = vi.fn((w, config) => {
        expect(w).toBe(worker);
        const client = {
            config,
            close: vi.fn(async () => {}),
            export: vi.fn(async () => new Uint8Array([83, 81, 76])),
            copy: vi.fn(async () => ({ bytes: 8192, seq: 3, schema: 1, base: "c0" })),
            query: vi.fn(async (/** @type {string} */ sql) =>
                sql.includes("page_count") ? { rows: [{ bytes: 8192 }] } : { rows: [{ name: "notes" }, { name: "tags" }] },
            ),
        };
        connected.push({ config, client });
        return /** @type {any} */ (client);
    });
    const dbs = new AppDbs({ store: async () => store, start, connect: /** @type {any} */ (connect), persist, sweep });
    return { store, dbs, start, connect, connected, persist, sweep };
}

describe("the page's app databases", () => {
    it("starts the worker and connects on first use, once", async () => {
        const { store, dbs, start, connect } = await setup();
        expect(start).not.toHaveBeenCalled();

        const [a, b] = await Promise.all([dbs.dbFor("s-1"), dbs.dbFor("s-1")]);
        expect(a).toBe(b);
        expect(await dbs.dbFor("s-1")).toBe(a);
        expect(start).toHaveBeenCalledTimes(1);
        expect(connect).toHaveBeenCalledTimes(1);
        const ref = await dbOf(store, "s-1");
        expect(a.config).toEqual({ id: ref?.id, branch: ref?.branch, label: DB_LABEL });

        // another session: its own database, on the same worker
        const c = await dbs.dbFor("s-2");
        expect(c).not.toBe(a);
        expect(start).toHaveBeenCalledTimes(1);
    });

    it("gives a fork its parent's client", async () => {
        const { dbs, connect } = await setup();
        const parent = await dbs.dbFor("s-1");
        await dbs.share("s-1", "s-2");
        expect(await dbs.dbFor("s-2")).toBe(parent);
        expect(connect).toHaveBeenCalledTimes(1);
        expect(dbs.held()).toEqual(new Map([[parent.config.id, ["s-1", "s-2"]]]));
    });

    it("moves a fork this page looked up before the share to its parent's", async () => {
        const { dbs } = await setup();
        const parent = await dbs.dbFor("s-1");
        const own = await dbs.dbFor("s-2");
        expect(own.config.id).not.toBe(parent.config.id);

        await dbs.share("s-1", "s-2");
        expect(own.close).toHaveBeenCalledTimes(1);
        expect(await dbs.dbFor("s-2")).toBe(parent);
        expect(dbs.held()).toEqual(new Map([[parent.config.id, ["s-1", "s-2"]]]));
    });

    it("closes a client once no session here uses it", async () => {
        const { dbs, connect } = await setup();
        const client = await dbs.dbFor("s-1");
        await dbs.share("s-1", "s-2");
        await dbs.dbFor("s-2");

        await dbs.release("s-1");
        expect(client.close).not.toHaveBeenCalled();
        await dbs.release("s-2");
        expect(client.close).toHaveBeenCalledTimes(1);
        expect(dbs.held().size).toBe(0);
        // releasing again, or a session never used, does nothing
        await dbs.release("s-2");
        await dbs.release("s-9");

        // used again: a new connection to the same database
        const again = await dbs.dbFor("s-1");
        expect(again).not.toBe(client);
        expect(again.config).toEqual(client.config);
        expect(connect).toHaveBeenCalledTimes(2);
    });

    it("drops a deleted session's entry and its client, leaving a fork's", async () => {
        const { store, dbs } = await setup();
        const client = await dbs.dbFor("s-1");
        await dbs.share("s-1", "s-2");
        const ref = await dbOf(store, "s-1");

        await dbs.forget("s-1");
        expect(await dbOf(store, "s-1")).toBeNull();
        expect(await dbOf(store, "s-2")).toEqual(ref);
        expect(client.close).toHaveBeenCalledTimes(1);
        expect((await dbs.dbFor("s-2")).config.id).toBe(ref?.id);

        // a session that never used one
        await dbs.forget("s-3");
        expect(await dbOf(store, "s-3")).toBeNull();
    });

    it("drops what a lookup still in flight names for a session being deleted", async () => {
        const { store, dbs, connect } = await setup();
        const opening = dbs.dbFor("s-1");
        opening.catch(() => {}); // rejects before it's awaited below
        await dbs.forget("s-1");
        await expect(opening).rejects.toThrow("s-1 is deleted");
        expect(await dbOf(store, "s-1")).toBeNull();
        expect(dbs.held().size).toBe(0);
        expect(connect).not.toHaveBeenCalled();

        // and it's never named again here
        await expect(dbs.dbFor("s-1")).rejects.toThrow("s-1 is deleted");
        expect(await dbOf(store, "s-1")).toBeNull();
    });

    it("gives a delegate the database of the session it works for", async () => {
        const { store, dbs, connect } = await setup();
        const lead = await dbs.dbFor("s-1");
        expect(await dbs.dbFor("s-1.scout")).toBe(lead);
        expect(await dbs.dbFor("s-1.scout.notes")).toBe(lead);
        expect(connect).toHaveBeenCalledTimes(1);
        // the registry names top-level sessions only
        expect(await dbOf(store, "s-1.scout")).toBeNull();
    });

    it("gives a test a detached copy of the session's database, its own each time", async () => {
        const { store, dbs, start, connected, sweep } = await setup();
        const lead = /** @type {any} */ (await dbs.dbFor("s-1"));
        const a = /** @type {any} */ (await dbs.testDb("s-1"));
        const b = /** @type {any} */ (await dbs.testDb("s-1.scout"));
        expect(a.config).toEqual({ id: expect.stringMatching(/^test-[0-9a-f]{16}$/), label: DB_LABEL, detached: true });
        expect(b.config.id).not.toBe(a.config.id);
        // made by the session's client (a delegate's, its lead's), then connected to
        expect(lead.copy.mock.calls).toEqual([[a.config], [b.config]]);
        expect(start).toHaveBeenCalledTimes(1);
        // not held for a session
        expect([...dbs.held().keys()]).toEqual([(await dbOf(store, "s-1"))?.id]);
        expect(connected).toHaveLength(3);
        // old copies are swept once a page
        expect(sweep).toHaveBeenCalledOnce();
    });

    it("gives a test an empty database where the session has none, or empty is asked", async () => {
        const { store, dbs, connected } = await setup();
        const a = /** @type {any} */ (await dbs.testDb("s-1"));
        expect(a.config.detached).toBe(true);
        // looking named none
        expect(await dbOf(store, "s-1")).toBeNull();
        expect(connected).toHaveLength(1);

        const lead = /** @type {any} */ (await dbs.dbFor("s-1"));
        await dbs.testDb("s-1", { empty: true });
        expect(lead.copy).not.toHaveBeenCalled();
    });

    it("asks for persistent storage once, when an app first keeps data", async () => {
        const { dbs, persist } = await setup();
        await dbs.testDb("s-9");
        expect(persist).not.toHaveBeenCalled();
        await dbs.dbFor("s-1");
        await dbs.dbFor("s-2");
        expect(persist).toHaveBeenCalledOnce();
    });

    it("describes a session's database for its dialog, naming none by looking", async () => {
        const { store, dbs, connect } = await setup();
        expect(await dbs.describe("s-1")).toBeNull();
        expect(await dbOf(store, "s-1")).toBeNull();
        expect(connect).not.toHaveBeenCalled();

        await dbs.dbFor("s-1");
        await dbs.share("s-1", "s-2");
        const ref = await dbOf(store, "s-1");
        expect(await dbs.describe("s-1")).toEqual({ id: ref?.id, bytes: 8192, tables: ["notes", "tags"], sessions: ["s-1", "s-2"] });
        // a delegate's is its lead's
        expect((await dbs.describe("s-2.scout"))?.id).toBe(ref?.id);
    });

    it("exports a session's database as a file", async () => {
        const { dbs } = await setup();
        const client = await dbs.dbFor("s-1");
        expect(await dbs.exportFile("s-1")).toEqual(new Uint8Array([83, 81, 76]));
        expect(client.export).toHaveBeenCalledOnce();
    });

    it("starts the worker again after a start that failed", async () => {
        const { dbs, start } = await setup({ failStarts: 1 });
        await expect(dbs.dbFor("s-1")).rejects.toThrow("no worker");
        expect(dbs.held().size).toBe(0);
        await expect(dbs.dbFor("s-1")).resolves.toBeDefined();
        expect(start).toHaveBeenCalledTimes(2);
    });
});
