import { describe, it, expect, vi, beforeEach } from "vitest";

// sessions.js reads localStorage at import (cold-start session cache);
// the per-branch sync flag lives there too, which is what these assert.
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

// The real adapter pulls in ts-agent.js (worker + `?url` asset imports).
// Branch creation is not what's under test here — the flag write is.
const created = [];
vi.mock("./active-adapter.js", () => ({
    resolveAdapter: async () => ({
        createBranch: async (branch) => {
            created.push(branch);
        },
    }),
}));

beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    created.length = 0;
    vi.resetModules();
});

async function load() {
    return await import("./sessions.js");
}

/** The branch `createSession` just made current. */
function currentBranch(sessionStore) {
    let snapshot;
    sessionStore.subscribe((s) => {
        snapshot = s;
    })();
    return snapshot.currentBranch;
}

describe("createSession sync opt-out", () => {
    it("defaults to synced — no flag written, so the branch inherits ON", async () => {
        const { createSession, sessionStore } = await load();
        const { isSyncEnabled } = await import("./sync-engine.js");

        await createSession({ kernel: "ts" });

        expect(isSyncEnabled(currentBranch(sessionStore))).toBe(true);
    });

    it("writes the opt-out before returning, not after the first turn", async () => {
        const { createSession, sessionStore } = await load();
        const { isSyncEnabled } = await import("./sync-engine.js");

        await createSession({ kernel: "ts", sync: false });

        // The ordering is the whole point: sync defaults ON per branch and
        // the first turn schedules a push, so a flag written any later
        // can't promise the session was never uploaded.
        const branch = currentBranch(sessionStore);
        expect(isSyncEnabled(branch)).toBe(false);
        expect(created).toEqual([branch]);
    });

    it("scopes the opt-out to the one session", async () => {
        const { createSession, sessionStore } = await load();
        const { isSyncEnabled } = await import("./sync-engine.js");

        await createSession({ kernel: "ts", sync: false });
        const localOnly = currentBranch(sessionStore);
        await createSession({ kernel: "ts" });
        const normal = currentBranch(sessionStore);

        expect(localOnly).not.toBe(normal);
        expect(isSyncEnabled(localOnly)).toBe(false);
        expect(isSyncEnabled(normal)).toBe(true);
    });
});
