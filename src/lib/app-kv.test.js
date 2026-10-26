import { Repo } from "@agex-ts/kvgit";
import { Memory } from "@agex-ts/kvgit/backends/memory";
import { MemoryDirectory, openLog } from "@agex-ts/kvsql";
import { Store } from "@agex-ts/world";
import { describe, expect, it } from "vitest";
import { KV_METHODS, KV_PROCEDURES, KV_TABLE_SQL, kvCall, prefixUpperBound } from "./app-kv.js";

/** A logged database, as the worker opens one, with a client's `call`
 *  and `query` running the procedures as the worker does. */
async function database() {
    const repo = await Repo.open(new Memory(), { codec: "bytes" });
    const db = await openLog({ dir: new MemoryDirectory(), name: "db.sqlite", repo, branch: "db", label: "agex.db" });
    const client = {
        /** @param {string} name @param {unknown} args */
        call: (name, args) => db.transact((tx) => structuredClone(KV_PROCEDURES[name](tx, args))),
        /** @param {string} sql */
        query: (sql) => db.query(sql),
    };
    return { db, client: /** @type {any} */ (client) };
}

/** A kvgit `KVStore` on store `store` of `client`, as the app's shim
 *  makes one. @param {any} client @param {string} store */
function kvStore(client, store) {
    /** @param {string} method @param {Record<string, unknown>} [args] */
    const call = (method, args = {}) => kvCall(client, method, { store, ...args });
    return {
        get: (key) => call("get", { key }),
        has: (key) => call("has", { key }),
        set: (key, value) => call("set", { key, value }),
        remove: (key) => call("remove", { key }),
        getMany: async (keys) => new Map(await call("getMany", { keys: [...keys] })),
        setMany: (items) => call("setMany", { items: [...items] }),
        removeMany: (keys) => call("removeMany", { keys: [...keys] }),
        cas: (key, value, expected) => call("cas", { key, value, expected }),
        casMany: (expected, writes, removes = []) => call("casMany", { expected: [...expected], writes: [...writes], removes: [...removes] }),
        async *keys(prefix) {
            yield* await call("keys", { prefix: prefix ?? null });
        },
        async *items(prefix) {
            yield* await call("items", { prefix: prefix ?? null });
        },
        clear: () => call("clear"),
    };
}

const bytes = (/** @type {number[]} */ ...xs) => new Uint8Array(xs);

/** @param {AsyncIterable<unknown>} it */
async function all(it) {
    const out = [];
    for await (const x of it) out.push(x);
    return out;
}

describe("an app's kv store", () => {
    it("makes its table on the first call, then gets, sets and removes", async () => {
        const { db, client } = await database();
        const kv = kvStore(client, "default");
        expect(await kv.get("a")).toBeNull();
        await kv.set("a", bytes(1, 2));
        // an empty value comes back empty, not missing
        await kv.set("empty", new Uint8Array(0));
        expect(await kv.get("a")).toEqual(bytes(1, 2));
        expect(await kv.get("empty")).toEqual(new Uint8Array(0));
        expect(await kv.has("empty")).toBe(true);
        // a view writes only its own bytes
        await kv.set("view", bytes(9, 8, 7, 6).subarray(1, 3));
        expect(await kv.get("view")).toEqual(bytes(8, 7));
        await kv.remove("a");
        expect(await kv.has("a")).toBe(false);
        expect(await kv.getMany(["a", "empty", "view"])).toEqual(new Map([["empty", new Uint8Array(0)], ["view", bytes(8, 7)]]));
        await kv.setMany([["x", bytes(1)], ["y", bytes(2)]]);
        await kv.removeMany(["x", "view"]);
        expect(await all(kv.keys())).toEqual(["empty", "y"]);
        await db.close();
    });

    it("compares and swaps, one key or many, all or nothing", async () => {
        const { db, client } = await database();
        const kv = kvStore(client, "default");
        expect(await kv.cas("h", bytes(1), null)).toBe(true);
        expect(await kv.cas("h", bytes(2), null)).toBe(false);
        expect(await kv.cas("h", bytes(2), bytes(9))).toBe(false);
        expect(await kv.cas("h", bytes(2), bytes(1))).toBe(true);
        expect(await kv.get("h")).toEqual(bytes(2));

        const ok = await kv.casMany(new Map([["h", bytes(2)], ["new", null]]), new Map([["h", bytes(3)], ["new", bytes(4)]]), ["gone"]);
        expect(ok).toBe(true);
        // one expectation off: nothing lands
        const off = await kv.casMany(new Map([["h", bytes(3)], ["new", null]]), new Map([["h", bytes(5)]]));
        expect(off).toBe(false);
        expect(await kv.get("h")).toEqual(bytes(3));
        await expect(kv.casMany(new Map(), new Map([["k", bytes(1)]]), ["k"])).rejects.toThrow("both written and removed");
        await db.close();
    });

    it("keeps stores apart, and scans a prefix to its end", async () => {
        const { db, client } = await database();
        const a = kvStore(client, "a");
        const b = kvStore(client, "b");
        await a.setMany([["p:1", bytes(1)], ["p:2", bytes(2)], ["p", bytes(0)], ["q", bytes(3)], ["p:\u{10ffff}", bytes(4)], ["p:😀", bytes(5)]]);
        await b.set("p:1", bytes(9));
        expect(await all(a.keys("p:"))).toEqual(["p:1", "p:2", "p:😀", "p:\u{10ffff}"]);
        expect(await all(b.items("p:"))).toEqual([["p:1", bytes(9)]]);
        await a.clear();
        expect(await all(a.keys())).toEqual([]);
        expect(await b.get("p:1")).toEqual(bytes(9));
        await db.close();
    });

    it("makes its table again after a restore took it away", async () => {
        const { db, client } = await database();
        const kv = kvStore(client, "default");
        await kv.set("a", bytes(1));
        await db.query("DROP TABLE _agex_kv");
        expect(await kv.get("a")).toBeNull();
        await kv.set("a", bytes(2));
        expect(await kv.get("a")).toEqual(bytes(2));
        // and a no-op make, when it's there, changes no schema
        const before = db.schemaVersion;
        await db.query(KV_TABLE_SQL);
        expect(db.schemaVersion).toBe(before);
        await db.close();
    });

    it("refuses what isn't a store's call", async () => {
        const { db, client } = await database();
        const kv = kvStore(client, "default");
        await expect(kv.set("a", "text")).rejects.toThrow("a value must be a Uint8Array");
        await expect(kv.get(5)).rejects.toThrow("a key must be a string");
        // SQLite would store it as U+FFFD, the row of another key
        for (const key of ["a\ud800", "\udc00b", "\ud800\ud800\udc00"]) await expect(kv.set(key, bytes(1))).rejects.toThrow("unpaired surrogate");
        await expect(all(kv.keys("p\ud800"))).rejects.toThrow("unpaired surrogate");
        await kv.set("😀", bytes(1));
        expect(await kv.get("😀")).toEqual(bytes(1));
        await expect(kvStore(client, "").get("a")).rejects.toThrow("non-empty string");
        expect([...KV_METHODS].sort()).toEqual(["cas", "casMany", "clear", "get", "getMany", "has", "items", "keys", "remove", "removeMany", "set", "setMany"]);
        await db.close();
    });

    it("holds a kvgit repository and a world, as an app's agent keeps one", async () => {
        const { db, client } = await database();
        const repo = await Repo.open(kvStore(client, "repo"), { codec: "bytes" });
        const tree = await repo.worktree("main", { create: true });
        tree.set("note", bytes(7));
        await tree.commit({ info: { title: "first" } });
        const reopened = await (await Repo.open(kvStore(client, "repo"), { codec: "bytes" })).worktree("main");
        expect(await reopened.get("note")).toEqual(bytes(7));

        const store = await Store.open(kvStore(client, "world"));
        const ws = await store.open("chat");
        await ws.files.write("notes.txt", "kept");
        const again = await (await Store.open(kvStore(client, "world"))).open("chat");
        expect(await again.files.readText("notes.txt")).toBe("kept");
        await db.close();
    });
});

describe("a prefix's upper bound", () => {
    it("bumps the last code point, carrying past the last and over the surrogates", () => {
        expect(prefixUpperBound("ab")).toBe("ac");
        expect(prefixUpperBound("a\u{10ffff}")).toBe("b");
        expect(prefixUpperBound("\u{10ffff}")).toBeNull();
        expect(prefixUpperBound("a\ud7ff")).toBe("a\ue000");
        expect(prefixUpperBound("")).toBeNull();
    });
});
