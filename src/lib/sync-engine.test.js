import { beforeEach, describe, expect, it, vi } from "vitest";

// localStorage stub (settings.js touches it at import; the engine
// uses it for per-branch enable flags).
const store = {};
vi.stubGlobal("localStorage", {
    getItem: (k) => store[k] ?? null,
    setItem: (k, v) => {
        store[k] = v;
    },
    removeItem: (k) => {
        delete store[k];
    },
});

import { Memory } from "@agex-ts/kvgit/backends/memory";
import { MemoryRemote, VersionedKV, pushBranch } from "@agex-ts/kvgit";
import { updateSettings } from "./settings.js";
import {
    _lastScheduledSyncForTesting,
    _resetSyncEngineForTesting,
    configureSyncEngine,
    isSyncEnabled,
    schedulePush,
    setSyncEnabled,
    sweep,
    syncNow,
    syncStatusStore,
} from "./sync-engine.js";

const enc = new TextEncoder();
const bytes = (s) => enc.encode(s);

function connect() {
    updateSettings({ syncRepo: "u/agex-sync", syncPat: "tok" });
}

/** MemoryRemote + the GithubRemote roster surface (archive/restore/
 *  trash) so the engine's lifecycle ops run over real kvgit transfer
 *  machinery. Archived branches hide from listRefs, like the real
 *  ref-rename does. */
function makeRosterRemote(remoteStore) {
    const inner = new MemoryRemote(remoteStore);
    const archived = new Map();
    return {
        listRefs: async () => (await inner.listRefs()).filter((r) => !archived.has(r.branch)),
        fetch: (want, have) => inner.fetch(want, have),
        push: (b, e, n, c) => inner.push(b, e, n, c),
        listArchivedRefs: async () =>
            [...archived].map(([branch, head]) => ({ branch, head })),
        archiveBranch: async (branch) => {
            const live = (await inner.listRefs()).find(
                (r) => r.branch === branch && !archived.has(branch),
            );
            if (!live) return false;
            archived.set(branch, live.head);
            return true;
        },
        restoreBranch: async (branch) => {
            if (!archived.has(branch)) throw new Error(`nothing archived under '${branch}'`);
            archived.delete(branch);
            return branch;
        },
        deleteForever: async (branch) => archived.delete(branch),
        emptyTrash: async () => {
            const n = archived.size;
            archived.clear();
            return n;
        },
    };
}

/** Local ts store + a roster-capable fake remote, wired into the
 *  engine via the deps seam — the full engine path over real kvgit
 *  machinery, no network. */
function makeWorld({ branches = [], currentBranch = null } = {}) {
    const local = new Memory();
    const remoteStore = new Memory();
    const remote = makeRosterRemote(remoteStore);
    const pulled = [];
    const archivedLocally = [];
    let listChanges = 0;
    const world = {
        local,
        remote,
        remoteStore,
        pulled,
        archivedLocally,
        branches,
        listChanges: () => listChanges,
    };
    configureSyncEngine({
        getStore: async () => local,
        listSyncableBranches: () => world.branches,
        currentBranch: () => currentBranch,
        onBranchPulled: async (branch) => {
            pulled.push(branch);
        },
        onBranchArchivedRemotely: async (branch) => {
            archivedLocally.push(branch);
        },
        onSessionListChanged: async () => {
            listChanges++;
        },
        makeRemote: () => remote,
    });
    return world;
}

async function commitOn(kvStore, branch, key, value) {
    const vk = await VersionedKV.open(kvStore, { branch });
    await vk.commit({ updates: new Map([[key, bytes(value)]]) });
    return vk.currentCommit;
}

function statusOf(branch) {
    let snapshot;
    syncStatusStore.subscribe((s) => {
        snapshot = s;
    })();
    return snapshot[branch];
}

beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    _resetSyncEngineForTesting();
    updateSettings({ syncRepo: "", syncPat: "" });
});

describe("syncNow", () => {
    it("pushes a local session to the remote and reports synced", async () => {
        connect();
        const { local, remote } = makeWorld({ branches: ["chat-aa11"] });
        const head = await commitOn(local, "chat-aa11", "greeting", "hello");

        const outcome = await syncNow("chat-aa11");
        expect(outcome.status).toBe("created");
        expect(statusOf("chat-aa11").state).toBe("synced");
        expect((await remote.listRefs())[0]).toEqual({ branch: "chat-aa11", head });
    });

    it("pulls remote turns, fires onBranchPulled, and stays fast-forward only", async () => {
        connect();
        const { local, remote, remoteStore, pulled } = makeWorld({ branches: ["chat-aa11"] });
        await commitOn(local, "chat-aa11", "greeting", "hello");
        await syncNow("chat-aa11");

        // "Another device": extends the same branch and pushes.
        const other = new Memory();
        const otherRemote = new MemoryRemote(remoteStore);
        const { applyWire, walkDelta } = await import("@agex-ts/kvgit");
        const tip = (await otherRemote.listRefs())[0].head;
        await applyWire(other, otherRemote.fetch(tip, []), { createBranch: "chat-aa11" });
        await commitOn(other, "chat-aa11", "from-b", "b-turn");
        expect((await pushBranch(other, otherRemote, "chat-aa11")).status).toBe("pushed");
        void walkDelta; // imported for symmetry with engine internals

        const outcome = await syncNow("chat-aa11");
        expect(outcome.pull.status).toBe("fast-forwarded");
        expect(pulled).toEqual(["chat-aa11"]);
        const vk = await VersionedKV.open(local, { branch: "chat-aa11" });
        expect(new TextDecoder().decode(await vk.get("from-b"))).toBe("b-turn");
    });

    it("surfaces divergence as a status without merging or moving refs", async () => {
        connect();
        const { local, remote, remoteStore } = makeWorld({ branches: ["chat-aa11"] });
        await commitOn(local, "chat-aa11", "seed", "0");
        await syncNow("chat-aa11");

        // Device B pushes a turn; we also commit locally before syncing.
        const other = new Memory();
        const otherRemote = new MemoryRemote(remoteStore);
        const { applyWire } = await import("@agex-ts/kvgit");
        const tip = (await otherRemote.listRefs())[0].head;
        await applyWire(other, otherRemote.fetch(tip, []), { createBranch: "chat-aa11" });
        await commitOn(other, "chat-aa11", "from-b", "b");
        await pushBranch(other, otherRemote, "chat-aa11");
        const localHead = await commitOn(local, "chat-aa11", "from-a", "a");

        const outcome = await syncNow("chat-aa11");
        expect(outcome.status).toBe("diverged");
        expect(statusOf("chat-aa11").state).toBe("diverged");
        // Local ref untouched; B's key not merged in.
        const vk = await VersionedKV.open(local, { branch: "chat-aa11" });
        expect(vk.currentCommit).toBe(localHead);
        expect(await vk.get("from-b")).toBeNull();
    });

    it("no-ops when sync isn't connected or the branch opted out", async () => {
        const { local } = makeWorld({ branches: ["chat-aa11"] });
        await commitOn(local, "chat-aa11", "k", "v");
        expect(await syncNow("chat-aa11")).toBeNull(); // not connected

        connect();
        setSyncEnabled("chat-aa11", false);
        expect(isSyncEnabled("chat-aa11")).toBe(false);
        expect(await syncNow("chat-aa11")).toBeNull(); // opted out
    });
});

describe("roster and lifecycle", () => {
    it("surfaces remote-only sessions, downloads them, archives, restores, empties", async () => {
        connect();
        const world = makeWorld({ branches: ["chat-aa11"] });
        await commitOn(world.local, "chat-aa11", "k", "local");
        await syncNow("chat-aa11");

        // A second device pushes a branch this device doesn't have.
        const other = new Memory();
        const otherRemote = makeRosterRemote(world.remoteStore);
        await commitOn(other, "chat-bb22", "k", "elsewhere");
        await pushBranch(other, otherRemote, "chat-bb22");

        const { refreshRoster, downloadRemoteSession, archiveSessionRemotely } = await import(
            "./sync-engine.js"
        );
        const { restoreRemoteSession, emptyTrashRemote, syncRosterStore: rosterStore } =
            await import("./sync-engine.js");
        const rosterOf = () => {
            let snap;
            rosterStore.subscribe((r) => {
                snap = r;
            })();
            return snap;
        };

        await refreshRoster();
        expect(rosterOf().remoteOnly.map((r) => r.branch)).toEqual(["chat-bb22"]);

        // Cloud-stub download: branch materializes locally.
        await downloadRemoteSession("chat-bb22");
        world.branches.push("chat-bb22");
        const vk = await VersionedKV.open(world.local, { branch: "chat-bb22" });
        expect(new TextDecoder().decode(await vk.get("k"))).toBe("elsewhere");
        expect(world.listChanges()).toBeGreaterThan(0);
        await refreshRoster();
        expect(rosterOf().remoteOnly).toEqual([]);

        // Archive → trash; restore → live again; empty → gone.
        expect(await archiveSessionRemotely("chat-bb22")).toBe(true);
        world.branches = world.branches.filter((b) => b !== "chat-bb22");
        await refreshRoster();
        expect(rosterOf().archived.map((r) => r.branch)).toEqual(["chat-bb22"]);
        expect(await restoreRemoteSession("chat-bb22")).toBe("chat-bb22");
        world.branches.push("chat-bb22");
        expect(await archiveSessionRemotely("chat-bb22")).toBe(true);
        world.branches = world.branches.filter((b) => b !== "chat-bb22");
        expect(await emptyTrashRemote()).toBe(1);
        expect(rosterOf().archived).toEqual([]);
    });

    it("propagates remote tombstones to local removal, sparing the foreground", async () => {
        connect();
        const world = makeWorld({
            branches: ["chat-aa11", "chat-fore"],
            currentBranch: "chat-fore",
        });
        await commitOn(world.local, "chat-aa11", "k", "v");
        await commitOn(world.local, "chat-fore", "k", "f");
        await syncNow("chat-aa11");
        await syncNow("chat-fore");

        // Another device archives BOTH branches we hold locally.
        await world.remote.archiveBranch("chat-aa11");
        await world.remote.archiveBranch("chat-fore");
        const { refreshRoster } = await import("./sync-engine.js");
        await refreshRoster();
        // Background branch removed; the foreground session is never
        // deleted out from under the user.
        expect(world.archivedLocally).toEqual(["chat-aa11"]);
    });

    it("fork keeps both sides of a divergence; reset takes the remote", async () => {
        connect();
        const world = makeWorld({ branches: ["chat-aa11"] });
        await commitOn(world.local, "chat-aa11", "seed", "0");
        await syncNow("chat-aa11");

        const other = new Memory();
        const otherRemote = makeRosterRemote(world.remoteStore);
        const { applyWire: apply } = await import("@agex-ts/kvgit");
        const tip = (await otherRemote.listRefs())[0].head;
        await apply(other, otherRemote.fetch(tip, []), { createBranch: "chat-aa11" });
        await commitOn(other, "chat-aa11", "from-b", "b");
        await pushBranch(other, otherRemote, "chat-aa11");
        const localHead = await commitOn(world.local, "chat-aa11", "from-a", "a");
        expect((await syncNow("chat-aa11")).status).toBe("diverged");

        const { forkDivergedSession, resetSessionToRemote, isSyncEnabled: enabled } =
            await import("./sync-engine.js");

        // Fork: remote side lands on a new sync-disabled branch; the
        // original keeps its local turn.
        const fork = await forkDivergedSession("chat-aa11");
        expect(fork).toMatch(/^chat-[0-9a-f]{8}$/);
        expect(enabled(fork)).toBe(false);
        const forkVk = await VersionedKV.open(world.local, { branch: fork });
        expect(new TextDecoder().decode(await forkVk.get("from-b"))).toBe("b");
        expect(await forkVk.get("from-a")).toBeNull();
        const origVk = await VersionedKV.open(world.local, { branch: "chat-aa11" });
        expect(origVk.currentCommit).toBe(localHead);

        // Reset: original adopts the remote head and reports synced.
        await resetSessionToRemote("chat-aa11");
        const after = await VersionedKV.open(world.local, { branch: "chat-aa11" });
        expect(new TextDecoder().decode(await after.get("from-b"))).toBe("b");
        expect(await after.get("from-a")).toBeNull();
        expect(statusOf("chat-aa11").state).toBe("synced");
        expect(world.pulled).toContain("chat-aa11");
    });
});

describe("status transitions", () => {
    it("clears stale detail when recovering from an error state", async () => {
        connect();
        const world = makeWorld({ branches: ["chat-aa11"] });
        await commitOn(world.local, "chat-aa11", "k", "v");

        // First sync fails (store accessor throws) → error with detail.
        let broken = true;
        configureSyncEngine({
            getStore: async () => {
                if (broken) throw new Error("boom-detail");
                return world.local;
            },
            listSyncableBranches: () => ["chat-aa11"],
            makeRemote: () => world.remote,
        });
        await syncNow("chat-aa11");
        expect(statusOf("chat-aa11").state).toBe("error");
        expect(statusOf("chat-aa11").detail).toBe("boom-detail");

        // Recovery: the synced status must not keep the old tooltip.
        broken = false;
        await syncNow("chat-aa11");
        expect(statusOf("chat-aa11").state).toBe("synced");
        expect(statusOf("chat-aa11").detail).toBe("");
    });
});

describe("cross-tab broadcast", () => {
    it("notifies sibling tabs after a pull, and disposes on their notifications", async () => {
        connect();
        const { local, remoteStore, pulled } = makeWorld({ branches: ["chat-aa11"] });
        await commitOn(local, "chat-aa11", "greeting", "hello");
        await syncNow("chat-aa11");

        // Another device pushes a turn so our next sync pulls.
        const other = new Memory();
        const otherRemote = new MemoryRemote(remoteStore);
        const { applyWire } = await import("@agex-ts/kvgit");
        const tip = (await otherRemote.listRefs())[0].head;
        await applyWire(other, otherRemote.fetch(tip, []), { createBranch: "chat-aa11" });
        await commitOn(other, "chat-aa11", "from-b", "b");
        await pushBranch(other, otherRemote, "chat-aa11");

        // A "sibling tab" listens on the channel: the pulling tab must
        // broadcast the branch.
        const sibling = new BroadcastChannel("agex-session-sync");
        const heard = new Promise((resolve) => {
            sibling.onmessage = (e) => resolve(e.data.branch);
        });
        try {
            await syncNow("chat-aa11");
            expect(await heard).toBe("chat-aa11");

            // Inverse: a sibling's broadcast triggers OUR dispose path.
            pulled.length = 0;
            sibling.postMessage({ branch: "chat-zz99" });
            await vi.waitFor(() => expect(pulled).toEqual(["chat-zz99"]));
        } finally {
            sibling.close();
        }
    });
});

describe("schedulePush", () => {
    it("debounces bursts into one sync and ignores py sessions", async () => {
        vi.useFakeTimers();
        try {
            connect();
            const { local, remote } = makeWorld({ branches: ["chat-aa11"] });
            await commitOn(local, "chat-aa11", "k", "v");

            schedulePush("chat-aa11", { kernel: "py" }); // ignored
            schedulePush("chat-aa11");
            schedulePush("chat-aa11"); // coalesces with the previous
            await vi.advanceTimersByTimeAsync(5000); // fires the debounce
            vi.useRealTimers(); // let the async sync work run for real
            await _lastScheduledSyncForTesting();
            expect((await remote.listRefs()).length).toBe(1);
            expect(statusOf("chat-aa11").state).toBe("synced");
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("status lifecycle", () => {
    it("marks queued pushes pending, and clears status on opt-out", async () => {
        vi.useFakeTimers();
        try {
            connect();
            const { local } = makeWorld({ branches: ["chat-aa11"] });
            await commitOn(local, "chat-aa11", "k", "v");

            schedulePush("chat-aa11");
            // Honest indicator: queued, not synced, during the debounce.
            expect(statusOf("chat-aa11").state).toBe("pending");

            // Opting out cancels the pending push and removes the
            // status entry entirely (no glyph for local-only sessions).
            setSyncEnabled("chat-aa11", false);
            expect(statusOf("chat-aa11")).toBeUndefined();
            await vi.advanceTimersByTimeAsync(5000);
            expect(statusOf("chat-aa11")).toBeUndefined(); // timer was cancelled
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("sweep", () => {
    it("syncs background branches, skips the foreground one, and honors the TTL", async () => {
        connect();
        const { local, remote } = makeWorld({
            branches: ["chat-fore", "chat-back"],
            currentBranch: "chat-fore",
        });
        await commitOn(local, "chat-fore", "k", "f");
        await commitOn(local, "chat-back", "k", "b");

        await sweep({ force: true });
        const refs = await remote.listRefs();
        expect(refs.map((r) => r.branch)).toEqual(["chat-back"]); // foreground skipped

        // Within the TTL a second sweep is a no-op even with new work.
        await commitOn(local, "chat-back", "k2", "b2");
        await sweep();
        const after = await remote.listRefs();
        const vk = await VersionedKV.open(local, { branch: "chat-back" });
        expect(after[0].head).not.toBe(vk.currentCommit); // not re-synced yet
    });
});
