import { MemoryRemote, Repo } from "@agex-ts/kvgit";
import { Memory } from "@agex-ts/kvgit/backends/memory";
import { PackRemote } from "@agex-ts/kvgit/github";
import { FakeGithub } from "@agex-ts/kvgit/github/fake";
import { MemoryDirectory, openLog } from "@agex-ts/kvsql";
import { Store } from "@agex-ts/world";
import { afterEach, describe, expect, it } from "vitest";
import { REGISTRY, dbBranch, dbOf, ensureDb, nameDb } from "./app-db.js";
import { syncDb, syncRegistry } from "./db-sync.js";

const ID = "db-0123456789abcdef";

/** @type {import("@agex-ts/kvsql").LoggedDatabase[]} */
const opened = [];
afterEach(async () => {
    for (const db of opened.splice(0)) if (!db.closed) await db.close().catch(() => {});
});

/** @typedef {(kv: Memory) => import("@agex-ts/kvgit").Remote} Remotes */

/** One remote for every device, in memory. @returns {Remotes} */
function inMemory() {
    const remote = new MemoryRemote(new Memory());
    return () => remote;
}

/** A remote for each device on one fake GitHub repo. @returns {Remotes} */
function onGithub() {
    const gh = new FakeGithub();
    return (kv) => new PackRemote(gh.client(), kv);
}

/**
 * A device: one store, its page's view (the registry) and its worker's
 * (the database's log), and the database.
 * @param {Remotes} remotes
 */
async function device(remotes) {
    const kv = new Memory();
    const remote = remotes(kv);
    const store = await Store.open(kv);
    const repo = await Repo.open(kv, { codec: "bytes" });
    const db = await openLog({ dir: new MemoryDirectory(), name: "app.db", repo, branch: dbBranch(ID), flush: { every: 0, maxAgeMs: 0 } });
    opened.push(db);
    /** The database as the sync sees its client. */
    const client = {
        flush: () => db.flush(),
        info: async () => ({ branch: db.branch }),
        /** @param {string} [onto] @param {any} [options] */
        rebase: (onto, options) => db.rebase(onto, options),
        /** @param {string} tip @param {any} [options] */
        adopt: (tip, options) => db.adopt(tip, options),
        /** @param {string} sql */
        query: (sql) => db.query(sql),
    };
    /** Sync the database once. @param {Partial<Parameters<typeof syncDb>[0]>} [more] */
    const sync = async (more = {}) => {
        const heads = new Map((await remote.listRefs()).map((r) => [r.branch, r.head]));
        return syncDb({ kv, repo: store.repo, remote, id: ID, heads, db: async () => client, ...more });
    };
    /** The repo's branches. */
    const branches = async () => (await remote.listRefs()).map((r) => r.branch);
    return { kv, store, repo, db, sync, branches };
}

/** @param {import("@agex-ts/kvsql").LoggedDatabase} db */
async function rows(db) {
    return (await db.query("SELECT * FROM t ORDER BY id")).rows;
}

/** Two devices level on a table of two rows. */
async function level(remotes = inMemory()) {
    const a = await device(remotes);
    await a.db.query("CREATE TABLE t (id INTEGER PRIMARY KEY NOT NULL, x TEXT, y TEXT)");
    await a.db.query("INSERT INTO t VALUES (1, 'x1', 'y1'), (2, 'x2', 'y2')");
    expect(await a.sync()).toMatchObject({ state: "synced" });
    const b = await device(remotes);
    expect(await b.sync()).toMatchObject({ state: "synced", moved: true });
    expect(await rows(b.db)).toEqual(await rows(a.db));
    return { a, b };
}

describe("syncing an app's database", () => {
    it("pushes it, and another device takes it in", async () => {
        const { a, b } = await level();
        await a.db.query("INSERT INTO t VALUES (3, 'a', 'a')");
        expect(await a.sync()).toMatchObject({ state: "synced", moved: false });
        expect(await b.sync()).toMatchObject({ state: "synced", moved: true });
        expect(await rows(b.db)).toEqual(await rows(a.db));
        expect(await b.sync()).toMatchObject({ state: "synced", moved: false });
    });

    it("rebases one device's changes after another's, and both end the same", async () => {
        const { a, b } = await level();
        await a.db.query("UPDATE t SET x = 'a' WHERE id = 1");
        await b.db.query("UPDATE t SET y = 'b' WHERE id = 1");
        await b.db.query("INSERT INTO t VALUES (3, 'b', 'b')");
        await a.sync();
        expect(await b.sync()).toMatchObject({ state: "synced", moved: true });
        await a.sync();
        expect(await rows(a.db)).toEqual([
            { id: 1, x: "a", y: "b" },
            { id: 2, x: "x2", y: "y2" },
            { id: 3, x: "b", y: "b" },
        ]);
        expect(await rows(b.db)).toEqual(await rows(a.db));
    });

    it("stops at a conflict with nothing changed, and settles on the side kept", async () => {
        const { a, b } = await level();
        await a.db.query("UPDATE t SET x = 'a' WHERE id = 1");
        await b.db.query("UPDATE t SET x = 'b' WHERE id = 1");
        await a.sync();
        const mine = await rows(b.db);
        const stopped = await b.sync();
        expect(stopped).toMatchObject({ state: "conflict", conflict: { step: "rebase" } });
        expect(await rows(b.db)).toEqual(mine);
        expect(await b.sync({ keep: "theirs" })).toMatchObject({ state: "synced", moved: true });
        expect(await rows(b.db)).toEqual(await rows(a.db));
        // b's side is a checkpoint
        expect((await b.db.checkpoints()).map((c) => c.label)).toContain("this copy's changes, replaced by sync");
    });

    it("moves onto a newer epoch another device started, its own changes with it", async () => {
        const { a, b } = await level();
        await b.db.query("INSERT INTO t VALUES (3, 'b', 'b')");
        await a.db.query("UPDATE t SET x = 'a' WHERE id = 1");
        await a.db.newEpoch();
        expect(await a.sync()).toMatchObject({ state: "synced" });
        // the old epoch is gone from the repo
        expect(await a.branches()).toEqual([`db/${ID}/1`]);
        expect(await b.sync()).toMatchObject({ state: "synced", moved: true });
        expect(b.db.branch).toBe(`db/${ID}/1`);
        await a.sync();
        expect(await rows(a.db)).toEqual(await rows(b.db));
        expect((await rows(a.db)).map((r) => r.id)).toEqual([1, 2, 3]);
    });

    it("takes in what another device pushed to the old epoch while this one started the next", async () => {
        const { a, b } = await level();
        // a's change is in its log, never synced, when it starts the epoch
        await a.db.query("UPDATE t SET x = 'a' WHERE id = 1");
        await a.db.flush();
        await a.db.newEpoch();
        await b.db.query("UPDATE t SET y = 'b' WHERE id = 2");
        expect(await b.sync()).toMatchObject({ state: "synced" });
        expect(await a.sync()).toMatchObject({ state: "synced", moved: true });
        expect(await a.branches()).toEqual([`db/${ID}/1`]);
        expect(await b.sync()).toMatchObject({ state: "synced", moved: true });
        expect(b.db.branch).toBe(`db/${ID}/1`);
        expect(await rows(b.db)).toEqual([
            { id: 1, x: "a", y: "y1" },
            { id: 2, x: "x2", y: "b" },
        ]);
        expect(await rows(a.db)).toEqual(await rows(b.db));
    });

    it("keeps a database over the cap here unless it's allowed", async () => {
        const a = await device(inMemory());
        await a.db.query("CREATE TABLE t (id INTEGER PRIMARY KEY NOT NULL, x TEXT, y TEXT)");
        expect(await a.sync({ cap: 1 })).toMatchObject({ state: "too-large" });
        expect(await a.branches()).toEqual([]);
        expect(await a.sync({ cap: 1, large: true })).toMatchObject({ state: "synced" });
        expect(await a.branches()).toEqual([`db/${ID}/0`]);
    });

    it("syncs through GitHub's API (a fake of it), epochs and all", async () => {
        const { a, b } = await level(onGithub());
        await a.db.query("UPDATE t SET x = 'a' WHERE id = 1");
        await a.db.flush();
        await a.db.newEpoch();
        await b.db.query("UPDATE t SET y = 'b' WHERE id = 2");
        expect(await b.sync()).toMatchObject({ state: "synced" });
        expect(await a.sync()).toMatchObject({ state: "synced", moved: true });
        expect(await a.branches()).toEqual([`db/${ID}/1`]);
        expect(await b.sync()).toMatchObject({ state: "synced", moved: true });
        expect(await rows(b.db)).toEqual(await rows(a.db));
        expect(await rows(b.db)).toEqual([
            { id: 1, x: "a", y: "y1" },
            { id: 2, x: "x2", y: "b" },
        ]);
    });
});

describe("syncing the registry", () => {
    it("merges two devices' entries key by key, this device's where both set one", async () => {
        const remote = new MemoryRemote(new Memory());
        const [a, b] = [await Store.open(new Memory()), await Store.open(new Memory())];
        const shared = await ensureDb(a, "s-1");
        await ensureDb(b, "s-1");
        await ensureDb(b, "s-2");
        await nameDb(a, "s-3", { id: "db-aaaaaaaaaaaaaaaa", branch: "db/db-aaaaaaaaaaaaaaaa/0" });
        await nameDb(b, "s-3", { id: "db-bbbbbbbbbbbbbbbb", branch: "db/db-bbbbbbbbbbbbbbbb/0" });
        await syncRegistry({ repo: a.repo, remote });
        await syncRegistry({ repo: b.repo, remote });
        await syncRegistry({ repo: a.repo, remote });
        for (const store of [a, b]) {
            expect(await dbOf(store, "s-1")).toEqual(shared);
            expect(await dbOf(store, "s-2")).not.toBeNull();
            expect((await dbOf(store, "s-3"))?.id).toBe("db-bbbbbbbbbbbbbbbb");
        }
        expect(await a.repo.branches.get(REGISTRY)).toBe(await b.repo.branches.get(REGISTRY));
    });

    it("takes the repo's on a device that has none", async () => {
        const remote = new MemoryRemote(new Memory());
        const a = await Store.open(new Memory());
        const ref = await ensureDb(a, "s-1");
        await syncRegistry({ repo: a.repo, remote });
        const b = await Store.open(new Memory());
        await syncRegistry({ repo: b.repo, remote });
        expect(await dbOf(b, "s-1")).toEqual(ref);
    });
});
