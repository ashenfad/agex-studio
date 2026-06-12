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

/** Local ts store + a MemoryRemote standing in for GitHub, wired into
 *  the engine via the deps seam — the full engine path over real
 *  kvgit machinery, no network. */
function makeWorld({ branches = [], currentBranch = null } = {}) {
    const local = new Memory();
    const remoteStore = new Memory();
    const remote = new MemoryRemote(remoteStore);
    const pulled = [];
    configureSyncEngine({
        getStore: async () => local,
        listSyncableBranches: () => branches,
        currentBranch: () => currentBranch,
        onBranchPulled: async (branch) => {
            pulled.push(branch);
        },
        makeRemote: () => remote,
    });
    return { local, remote, remoteStore, pulled };
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
