import { Repo } from "@agex-ts/kvgit";
import { Memory } from "@agex-ts/kvgit/backends/memory";
import { MemoryDirectory, openLog } from "@agex-ts/kvsql";
import { Store } from "@agex-ts/world";
import { describe, expect, it } from "vitest";
import { REGISTRY, dbBranch, dbOf, ensureDb, firstDbId, nameDb, newDbId, sessionsNaming, shareDb, unlinkDb } from "./app-db.js";

describe("the app-database registry", () => {
    it("names a database on first use, the same one after", async () => {
        const store = await Store.open(new Memory());
        expect(await dbOf(store, "s-1")).toBeNull();
        // looking creates nothing
        expect(await store.repo.branches.has(REGISTRY)).toBe(false);

        const ref = await ensureDb(store, "s-1");
        expect(ref.id).toMatch(/^db-[0-9a-f]{16}$/);
        expect(ref.branch).toBe(dbBranch(ref.id));
        expect(await ensureDb(store, "s-1")).toEqual(ref);
        expect(await dbOf(store, "s-1")).toEqual(ref);
        // another session gets one of its own
        expect((await ensureDb(store, "s-2")).id).not.toBe(ref.id);
    });

    it("names a session's first database alike on every device", async () => {
        const [a, b] = [await Store.open(new Memory()), await Store.open(new Memory())];
        const ref = await ensureDb(a, "s-1");
        expect(ref.id).toBe(await firstDbId("s-1"));
        expect(await ensureDb(b, "s-1")).toEqual(ref);
        const ids = new Set(await Promise.all(Array.from({ length: 200 }, (_, i) => firstDbId(`s-${i}`))));
        expect(ids.size).toBe(200);
    });

    it("isn't a session, nor in any session's history", async () => {
        const store = await Store.open(new Memory());
        const ws = await store.open("s-1");
        await ws.autoCommit({ tool: "test" });
        const head = await store.repo.branches.get("s-1");
        const ref = await ensureDb(store, "s-1");
        expect(await store.sessions()).toEqual(["s-1"]);
        expect(await store.repo.branches.get("s-1")).toBe(head);
        // undoing the session's turns can't lose the link
        await ws.checkout(head);
        expect(await dbOf(store, "s-1")).toEqual(ref);
        await ws.close();
    });

    it("has a fork name its parent's database, named first if it has none", async () => {
        const store = await Store.open(new Memory());
        const fresh = await shareDb(store, "s-1", "s-2");
        expect(await dbOf(store, "s-1")).toEqual(fresh);
        expect(await dbOf(store, "s-2")).toEqual(fresh);

        const used = await ensureDb(store, "s-3");
        expect(await shareDb(store, "s-3", "s-4")).toEqual(used);
        expect(await sessionsNaming(store, used.id)).toEqual(["s-3", "s-4"]);
    });

    it("has a fork name a copy of its own, apart from its parent's", async () => {
        const store = await Store.open(new Memory());
        const parent = await ensureDb(store, "s-1");
        const id = newDbId();
        expect(id).toMatch(/^db-[0-9a-f]{16}$/);
        expect(newDbId()).not.toBe(id);
        await nameDb(store, "s-2", { id, branch: dbBranch(id) });
        expect(await dbOf(store, "s-2")).toEqual({ id, branch: dbBranch(id) });
        expect(await dbOf(store, "s-1")).toEqual(parent);
        expect(await sessionsNaming(store, id)).toEqual(["s-2"]);
        expect(await unlinkDb(store, "s-2")).toEqual({ ref: { id, branch: dbBranch(id) }, named: false });
    });

    it("drops a deleted session's entry, saying whether another names the database", async () => {
        const store = await Store.open(new Memory());
        expect(await unlinkDb(store, "s-1")).toBeNull();
        const ref = await ensureDb(store, "s-1");
        await shareDb(store, "s-1", "s-2");

        expect(await unlinkDb(store, "s-2")).toEqual({ ref, named: true });
        expect(await dbOf(store, "s-2")).toBeNull();
        expect(await unlinkDb(store, "s-2")).toBeNull();
        expect(await unlinkDb(store, "s-1")).toEqual({ ref, named: false });
        expect(await sessionsNaming(store, ref.id)).toEqual([]);
    });

    it("gives two tabs naming a session's database at once the same one", async () => {
        const kv = new Memory();
        const [a, b] = await Promise.all([Store.open(kv), Store.open(kv)]);
        for (let i = 0; i < 10; i++) {
            const [x, y] = await Promise.all([ensureDb(a, `s-${i}`), ensureDb(b, `s-${i}`)]);
            expect(x).toEqual(y);
        }
        // ten sessions and the ten databases they name
        expect(await (await a.repo.snapshot({ branch: REGISTRY })).keys()).toHaveLength(20);
    });
});

describe("a database's log on the studio's store", () => {
    it("is kept by the store's sweeps and rebuilds the database", async () => {
        const kv = new Memory();
        const store = await Store.open(kv);
        const ws = await store.open("s-1");
        await ws.autoCommit({ tool: "test" });
        const { id, branch } = await ensureDb(store, "s-1");

        // the database worker's handle: the same store, logs as bytes
        const repo = await Repo.open(kv, { codec: "bytes" });
        const db = await openLog({ dir: new MemoryDirectory(), name: "db.sqlite", repo, branch, label: "agex.db" });
        await db.query("CREATE TABLE notes (id TEXT PRIMARY KEY NOT NULL, body TEXT)");
        await db.query("INSERT INTO notes VALUES (?, ?)", ["n1", "hello"]);
        await db.close();

        // deleting another session sweeps what nothing reaches, at once
        const other = await store.open("s-2");
        await other.autoCommit({ tool: "test" });
        await ws.close();
        await other.close();
        await store.delete("s-2", { minAge: 0 });
        expect(await store.sessions()).toEqual(["s-1"]);

        // an empty directory replays the log
        const again = await openLog({ dir: new MemoryDirectory(), name: "db.sqlite", repo, branch });
        expect((await again.query("SELECT * FROM notes")).rows).toEqual([{ id: "n1", body: "hello" }]);
        await again.close();
        expect(await sessionsNaming(store, id)).toEqual(["s-1"]);
    });

    it("holds a fork's own copy, which goes its own way and rebuilds from its own log", async () => {
        const kv = new Memory();
        const store = await Store.open(kv);
        const ws = await store.open("s-1");
        await ws.autoCommit({ tool: "test" });
        const repo = await Repo.open(kv, { codec: "bytes" });
        const db = await openLog({ dir: new MemoryDirectory(), name: "db.sqlite", repo, branch: (await ensureDb(store, "s-1")).branch });
        await db.query("CREATE TABLE notes (id TEXT PRIMARY KEY NOT NULL, body TEXT)");
        await db.query("INSERT INTO notes VALUES (?, ?)", ["n1", "hello"]);

        // the fork's copy, as the database worker makes it
        const id = newDbId();
        const ref = { id, branch: dbBranch(id) };
        const dir = new MemoryDirectory();
        await db.copy({ dir, name: "db.sqlite", repo, branch: ref.branch });
        await nameDb(store, "s-2", ref);
        await db.query("INSERT INTO notes VALUES (?, ?)", ["n2", "parent's"]);
        await db.close();
        const fork = await openLog({ dir, name: "db.sqlite", repo, branch: ref.branch });
        await fork.query("INSERT INTO notes VALUES (?, ?)", ["n3", "fork's"]);
        await fork.close();

        // the store's sweeps keep the copy's log, as they keep any branch
        await ws.close();
        await store.delete("s-1", { minAge: 0 });
        const again = await openLog({ dir: new MemoryDirectory(), name: "db.sqlite", repo, branch: ref.branch });
        expect((await again.query("SELECT id FROM notes ORDER BY id")).rows).toEqual([{ id: "n1" }, { id: "n3" }]);
        await again.close();
    });
});
