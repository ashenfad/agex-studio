import { Memory } from "@agex-ts/kvgit/backends/memory";
import { Store } from "@agex-ts/world";
import { describe, expect, it, vi } from "vitest";
import { AppDbs, DB_LABEL } from "./app-db-clients.js";
import { dbOf } from "./app-db.js";

/** A manager on a store in memory, with a worker and clients that
 *  record what was asked of them. */
async function setup({ failStarts = 0 } = {}) {
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
        const client = { config, close: vi.fn(async () => {}) };
        connected.push({ config, client });
        return /** @type {any} */ (client);
    });
    const dbs = new AppDbs({ store: async () => store, start, connect: /** @type {any} */ (connect) });
    return { store, dbs, start, connect, connected };
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

    it("opens a scratch database of a test's own each time, on the same worker", async () => {
        const { dbs, start, connected } = await setup();
        const a = await dbs.scratch();
        const b = await dbs.scratch();
        expect(a.config).toMatchObject({ scratch: true, label: DB_LABEL });
        expect(a.config.id).toMatch(/^scratch-[0-9a-f]{16}$/);
        expect(b.config.id).not.toBe(a.config.id);
        expect(start).toHaveBeenCalledTimes(1);
        // not one the page holds for a session
        expect(dbs.held().size).toBe(0);
        expect(connected).toHaveLength(2);
    });

    it("starts the worker again after a start that failed", async () => {
        const { dbs, start } = await setup({ failStarts: 1 });
        await expect(dbs.dbFor("s-1")).rejects.toThrow("no worker");
        expect(dbs.held().size).toBe(0);
        await expect(dbs.dbFor("s-1")).resolves.toBeDefined();
        expect(start).toHaveBeenCalledTimes(2);
    });
});
