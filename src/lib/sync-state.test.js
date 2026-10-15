import { MemoryRemote, getSyncHead, setSyncHead, syncBranch } from "@agex-ts/kvgit";
import { Memory } from "@agex-ts/kvgit/backends/memory";
import { Store } from "@agex-ts/world";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adoptRepo, localNote, nextState } from "./sync-state.js";

describe("whether the repo holds a session", () => {
    it("is known once a sync ends, and carries over while one waits, runs or fails", () => {
        expect(nextState(undefined, "pending").held).toBe(false);
        expect(nextState(undefined, "syncing").held).toBe(false);
        expect(nextState(undefined, "error", "offline").held).toBe(false);
        const synced = nextState(undefined, "synced");
        expect(synced.held).toBe(true);
        expect(nextState(undefined, "diverged").held).toBe(true);
        // a change here waits to be pushed: the repo still holds what it had
        const pending = nextState(synced, "pending");
        expect(pending.held).toBe(true);
        expect(nextState(nextState(pending, "syncing"), "error", "offline").held).toBe(true);
        // gone from the repo, it stays gone until a sync finds it again
        const gone = nextState(synced, "remote-gone", "archived elsewhere");
        expect(gone).toMatchObject({ state: "remote-gone", detail: "archived elsewhere", held: false });
        expect(nextState(gone, "pending").held).toBe(false);
        expect(nextState(nextState(gone, "pending"), "synced").held).toBe(true);
    });
});

describe("sync heads against a repo", () => {
    /** @param {string | null} start */
    const noting = (start) => {
        let value = start;
        return {
            get: () => value,
            /** @param {string} v */
            set: (v) => {
                value = v;
            },
        };
    };

    it("go when another repo is connected, so its sessions aren't taken as lost", async () => {
        const store = await Store.open(new Memory());
        const ws = await store.open("s-1");
        ws.plane("studio").set("meta", { title: "one" });
        await ws.autoCommit({ tool: "test" });
        await ws.close();
        const kv = store.repo.store;
        const noted = noting(null);

        // synced with the first repo: its head is recorded
        expect(await adoptRepo(store.repo, "me/first", noted)).toBe(false);
        expect((await syncBranch(kv, new MemoryRemote(new Memory()), "s-1")).status).toBe("created");
        expect(await getSyncHead(kv, "s-1")).not.toBeNull();

        // the same repo again keeps it
        expect(await adoptRepo(store.repo, "me/first", noted)).toBe(false);
        expect(await getSyncHead(kv, "s-1")).not.toBeNull();

        // another repo: the head goes, so the session is pushed there, not marked gone
        expect(await adoptRepo(store.repo, "me/second", noted)).toBe(true);
        expect(noted.get()).toBe("me/second");
        expect(await getSyncHead(kv, "s-1")).toBeNull();
        expect((await syncBranch(kv, new MemoryRemote(new Memory()), "s-1")).status).toBe("created");
    });

    it("kept under each repo stay through a change of repo, so one connected again picks up", async () => {
        const store = await Store.open(new Memory());
        const ws = await store.open("s-1");
        ws.plane("studio").set("meta", { title: "one" });
        await ws.autoCommit({ tool: "test" });
        await ws.close();
        const kv = store.repo.store;
        const first = new MemoryRemote(new Memory(), { id: "github:me/first" });
        const second = new MemoryRemote(new Memory(), { id: "github:me/second" });
        const noted = noting(null);

        expect(await adoptRepo(store.repo, "me/first", noted)).toBe(false);
        expect((await syncBranch(kv, first, "s-1")).status).toBe("created");
        expect(await adoptRepo(store.repo, "me/second", noted)).toBe(true);
        expect(await getSyncHead(kv, "s-1", first)).not.toBeNull();
        expect(await getSyncHead(kv, "s-1", second)).toBeNull();
        expect((await syncBranch(kv, second, "s-1")).status).toBe("created");

        // back to the first: it's level, not pushed again or taken as lost
        expect(await adoptRepo(store.repo, "me/first", noted)).toBe(true);
        expect((await syncBranch(kv, first, "s-1")).status).toBe("up-to-date");
    });

    it("kept under no repo go when another is connected, before it can take them up", async () => {
        const store = await Store.open(new Memory());
        const ws = await store.open("s-1");
        ws.plane("studio").set("meta", { title: "one" });
        await ws.autoCommit({ tool: "test" });
        await ws.close();
        const kv = store.repo.store;
        const noted = noting("me/first");
        // as a studio kept it before heads were kept per repo
        await setSyncHead(kv, "s-1", /** @type {string} */ (await store.repo.branches.get("s-1")));
        const second = new MemoryRemote(new Memory(), { id: "github:me/second" });

        expect(await adoptRepo(store.repo, "me/second", noted)).toBe(true);
        expect(await getSyncHead(kv, "s-1", second)).toBeNull();
        expect((await syncBranch(kv, second, "s-1")).status).toBe("created");
    });

    it("recorded before the repo was noted are taken as the repo's", async () => {
        const store = await Store.open(new Memory());
        const ws = await store.open("s-1");
        ws.plane("studio").set("meta", { title: "one" });
        await ws.autoCommit({ tool: "test" });
        await ws.close();
        const kv = store.repo.store;
        const remote = new MemoryRemote(new Memory());
        await syncBranch(kv, remote, "s-1");
        const noted = noting(null);
        expect(await adoptRepo(store.repo, "me/first", noted)).toBe(false);
        expect(await getSyncHead(kv, "s-1")).not.toBeNull();
        expect((await syncBranch(kv, remote, "s-1")).status).toBe("up-to-date");
    });
});

describe("the repo noted", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("holds for the page where localStorage is blocked", () => {
        const blocked = () => {
            throw new Error("blocked");
        };
        vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked });
        const note = localNote("agex-sync-repo");
        expect(note.get()).toBeNull();
        note.set("me/first");
        expect(note.get()).toBe("me/first");
    });

    it("is read back from localStorage", () => {
        /** @type {Map<string, string>} */
        const kept = new Map();
        vi.stubGlobal("localStorage", {
            getItem: (/** @type {string} */ k) => kept.get(k) ?? null,
            setItem: (/** @type {string} */ k, /** @type {string} */ v) => void kept.set(k, v),
        });
        localNote("agex-sync-repo").set("me/first");
        expect(localNote("agex-sync-repo").get()).toBe("me/first");
    });
});
