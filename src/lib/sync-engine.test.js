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
        // Minimal contents-API fake for the app-state sidecar: a flat
        // path → {json, sha} map plus refs, with the same sha-CAS and
        // not-found shapes the engine duck-types on.
        client: (() => {
            const files = new Map();
            let seq = 0;
            let appStateRef = false;
            const client_squash_marker = [];
            const client_force_moves = [];
            return {
                files,
                squashes: client_squash_marker,
                forceMoves: client_force_moves,
                getCommit: async (sha) => ({ sha, tree: `tree-of-${sha}`, parents: [] }),
                createCommit: async (opts) => {
                    if (opts.parents.length === 0) client_squash_marker.push(opts);
                    return `commit-${++seq}`;
                },
                updateRef: async (branch, sha, opts) => {
                    if (opts?.force) client_force_moves.push([branch, sha]);
                    return true;
                },
                getRef: async (b) => {
                    if (b === "app-state") return appStateRef ? "as-ref" : null;
                    return "main-ref";
                },
                createRef: async (b) => {
                    if (b === "app-state") appStateRef = true;
                    return true;
                },
                request: async (method, path, body) => {
                    const fp = path.replace(/\?.*$/, "").replace(/^contents\//, "");
                    if (method === "GET") {
                        if (fp === "app-state") {
                            // Directory listing.
                            const names = [...files.keys()]
                                .filter((k) => k.startsWith("app-state/"))
                                .map((k) => ({ name: k.slice("app-state/".length) }));
                            if (names.length === 0) {
                                throw Object.assign(new Error("Not Found"), { kind: "not-found" });
                            }
                            return names;
                        }
                        const f = files.get(fp);
                        if (!f) throw Object.assign(new Error("Not Found"), { kind: "not-found" });
                        return { content: btoa(f.json), encoding: "base64", sha: f.sha };
                    }
                    if (method === "PUT") {
                        const existing = files.get(fp);
                        if (existing && body.sha !== existing.sha) {
                            throw Object.assign(new Error("sha mismatch"), { kind: "validation" });
                        }
                        files.set(fp, { json: atob(body.content), sha: `s${++seq}` });
                        return { content: { sha: `s${seq}` } };
                    }
                    if (method === "DELETE") {
                        files.delete(fp);
                        return {};
                    }
                    throw new Error(`fake client: ${method} ${path}`);
                },
            };
        })(),
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
    const applied = [];
    let listChanges = 0;
    const world = {
        local,
        remote,
        remoteStore,
        pulled,
        archivedLocally,
        applied,
        appBags: {},
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
        fetchStubTitle: async (_remote, branch) => world.stubTitles?.[branch] ?? null,
        readAppState: (branch) => world.appBags?.[branch] ?? {},
        applyAppState: (branch, entries) => {
            world.appBags = { ...world.appBags, [branch]: entries };
            world.applied.push(branch);
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

describe("progress instrumentation", () => {
    it("live-counts turns through push and pull", async () => {
        connect();
        const world = makeWorld({ branches: ["chat-aa11"] });
        await commitOn(world.local, "chat-aa11", "k1", "a");
        await commitOn(world.local, "chat-aa11", "k2", "b");
        await commitOn(world.local, "chat-aa11", "k3", "c");

        const seen = [];
        const unsub = syncStatusStore.subscribe((statuses) => {
            const st = statuses["chat-aa11"];
            if (st?.detail) seen.push(st.detail);
        });
        await syncNow("chat-aa11"); // initial push: 4 commits (init + 3)
        // First-ever push is determinate: the full local history was
        // precounted.
        expect(seen).toContain("uploading · turn 4 of 4");

        // Fresh device pulls the same session: download counts.
        const dev2 = new Memory();
        configureSyncEngine({
            getStore: async () => dev2,
            listSyncableBranches: () => ["chat-aa11"],
            makeRemote: () => world.remote,
        });
        seen.length = 0;
        await syncNow("chat-aa11");
        expect(seen).toContain("downloading · turn 4");
        unsub();
    });
});

describe("app-state sidecar", () => {
    it("round-trips a bag between devices with LWW semantics", async () => {
        connect();
        const world = makeWorld({ branches: ["chat-aa11"] });
        world.appBags["chat-aa11"] = { todos: "[1,2]" };

        const { scheduleAppStateSync, pushAppState, pullAppState } = await import(
            "./sync-engine.js"
        );
        scheduleAppStateSync("chat-aa11"); // stamps lastLocalWriteAt
        await pushAppState("chat-aa11");
        expect(world.remote.client.files.has("app-state/chat-aa11.json")).toBe(true);

        // "Device 2": a genuinely fresh engine (reset module state —
        // a second device shares nothing but the remote), same file.
        const pushedFile = world.remote.client.files.get("app-state/chat-aa11.json");
        _resetSyncEngineForTesting();
        connect();
        const world2 = makeWorld({ branches: ["chat-aa11"] });
        world2.remote.client.files.set("app-state/chat-aa11.json", pushedFile);
        await pullAppState("chat-aa11");
        expect(world2.appBags["chat-aa11"]).toEqual({ todos: "[1,2]" });
        expect(world2.applied).toEqual(["chat-aa11"]);

        // Re-pull: already applied, no double-apply.
        await pullAppState("chat-aa11");
        expect(world2.applied).toEqual(["chat-aa11"]);
    });

    it("skips inbound apply while local writes are newer", async () => {
        connect();
        const world = makeWorld({ branches: ["chat-aa11"] });
        const { scheduleAppStateSync, pullAppState } = await import("./sync-engine.js");

        // A stale remote bag exists; then the local app saves.
        world.remote.client.files.set("app-state/chat-aa11.json", {
            json: JSON.stringify({ format: 1, kernel: "ts", updatedAt: 1, entries: { old: "x" } }),
            sha: "s0",
        });
        world.appBags["chat-aa11"] = { fresh: "y" };
        scheduleAppStateSync("chat-aa11"); // local write timestamp = now ≫ 1

        await pullAppState("chat-aa11");
        expect(world.applied).toEqual([]); // local pending wins
        expect(world.appBags["chat-aa11"]).toEqual({ fresh: "y" });
    });

    it("squashes app-state history to an orphan every N pushes", async () => {
        connect();
        const world = makeWorld({ branches: ["chat-aa11"] });
        const { scheduleAppStateSync, pushAppState } = await import("./sync-engine.js");
        for (let i = 0; i < 25; i++) {
            world.appBags["chat-aa11"] = { v: String(i) };
            scheduleAppStateSync("chat-aa11");
            await pushAppState("chat-aa11");
        }
        expect(world.remote.client.squashes.length).toBe(1);
        expect(world.remote.client.squashes[0].parents).toEqual([]);
        expect(world.remote.client.forceMoves[0][0]).toBe("app-state");
    });

    it("respects the syncAppState setting", async () => {
        connect();
        updateSettings({ syncAppState: false });
        const world = makeWorld({ branches: ["chat-aa11"] });
        world.appBags["chat-aa11"] = { k: "v" };
        const { scheduleAppStateSync, pushAppState, pullAppState } = await import(
            "./sync-engine.js"
        );
        scheduleAppStateSync("chat-aa11");
        await pushAppState("chat-aa11");
        await pullAppState("chat-aa11");
        expect(world.remote.client.files.size).toBe(0); // nothing pushed or seeded
        updateSettings({ syncAppState: true });
    });

    it("heals an unpushed bag after a 'tab close' (persisted dirty hash)", async () => {
        connect();
        const world = makeWorld({ branches: ["chat-aa11"] });
        const { scheduleAppStateSync, pushAppState, sweep: doSweep } = await import(
            "./sync-engine.js"
        );
        world.appBags["chat-aa11"] = { v: "1" };
        scheduleAppStateSync("chat-aa11");
        await pushAppState("chat-aa11");

        // App saves again; the tab dies inside the debounce window.
        world.appBags["chat-aa11"] = { v: "2" };
        scheduleAppStateSync("chat-aa11");
        const bags = world.appBags;
        _resetSyncEngineForTesting(); // "reload" — timers and memory gone
        connect();
        const world2 = makeWorld({ branches: ["chat-aa11"] });
        world2.appBags = bags;
        world2.remote.client.files.set(
            "app-state/chat-aa11.json",
            world.remote.client.files.get("app-state/chat-aa11.json"),
        );
        // localStorage survived: the persisted hash says dirty, the
        // sweep pushes, and v:2 lands.
        await doSweep({ force: true });
        const file = world2.remote.client.files.get("app-state/chat-aa11.json");
        expect(JSON.parse(file.json).entries).toEqual({ v: "2" });
    });

    it("flushPendingAppState fires debounced pushes immediately", async () => {
        vi.useFakeTimers();
        try {
            connect();
            const world = makeWorld({ branches: ["chat-aa11"] });
            world.appBags["chat-aa11"] = { v: "now" };
            const { scheduleAppStateSync, flushPendingAppState } = await import(
                "./sync-engine.js"
            );
            scheduleAppStateSync("chat-aa11");
            expect(world.remote.client.files.has("app-state/chat-aa11.json")).toBe(false);
            flushPendingAppState();
            vi.useRealTimers();
            await vi.waitFor(() =>
                expect(world.remote.client.files.has("app-state/chat-aa11.json")).toBe(true),
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it("seeds the app-state directory on first contact (no recurring 404s)", async () => {
        connect();
        const world = makeWorld({ branches: ["chat-aa11"] });
        const { pullAppState } = await import("./sync-engine.js");
        // No app state anywhere yet: the first pull's listing 404s and
        // seeds the directory so future listings are clean 200s.
        await pullAppState("chat-aa11");
        expect(world.remote.client.files.has("app-state/.keep")).toBe(true);
        expect(world.applied).toEqual([]); // nothing applied, just seeded
    });

    it("skips pushing an unchanged bag", async () => {
        connect();
        const world = makeWorld({ branches: ["chat-aa11"] });
        world.appBags["chat-aa11"] = { k: "v" };
        const { scheduleAppStateSync, pushAppState } = await import("./sync-engine.js");
        scheduleAppStateSync("chat-aa11");
        await pushAppState("chat-aa11");
        const shaAfterFirst = world.remote.client.files.get("app-state/chat-aa11.json").sha;
        await pushAppState("chat-aa11"); // unchanged
        expect(world.remote.client.files.get("app-state/chat-aa11.json").sha).toBe(shaAfterFirst);
    });
});

describe("kickoffSync", () => {
    it("pushes background sessions immediately and queues the foreground", async () => {
        connect();
        const world = makeWorld({
            branches: ["chat-fore", "chat-back"],
            currentBranch: "chat-fore",
        });
        await commitOn(world.local, "chat-fore", "k", "f");
        await commitOn(world.local, "chat-back", "k", "b");

        const { kickoffSync } = await import("./sync-engine.js");
        await kickoffSync();

        // Background branch is on the remote right away; the
        // foreground rides the normal debounced path (pending now).
        const refs = await world.remote.listRefs();
        expect(refs.map((r) => r.branch)).toEqual(["chat-back"]);
        expect(statusOf("chat-fore").state).toBe("pending");
    });
});

describe("stub titles", () => {
    it("enriches remote-only roster entries via fetchStubTitle", async () => {
        connect();
        const world = makeWorld({ branches: [] });
        world.stubTitles = { "chat-bb22": "Sailboat routes" };

        const other = new Memory();
        const otherRemote = makeRosterRemote(world.remoteStore);
        await commitOn(other, "chat-bb22", "k", "v");
        await pushBranch(other, otherRemote, "chat-bb22");

        const { refreshRoster, syncRosterStore: rosterStore } = await import("./sync-engine.js");
        await refreshRoster();
        let snap;
        rosterStore.subscribe((r) => {
            snap = r;
        })();
        expect(snap.remoteOnly).toEqual([
            { branch: "chat-bb22", head: expect.any(String), title: "Sailboat routes" },
        ]);
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
