import { MemoryRemote, getSyncHead, syncBranch } from "@agex-ts/kvgit";
import { Memory } from "@agex-ts/kvgit/backends/memory";
import { Store } from "@agex-ts/world";
import { describe, expect, it } from "vitest";
import { adoptRepo, nextState } from "./sync-state.js";

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
