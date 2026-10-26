import { beforeEach, describe, expect, it, vi } from "vitest";

// a store of sessions in memory: each session's record by name
const { infos } = vi.hoisted(() => ({ infos: /** @type {Map<string, any>} */ (new Map()) }));

vi.mock("./store.js", () => {
    let n = 0;
    const ws = (/** @type {string} */ session) => ({
        session,
        close: async () => {},
        fork: async (/** @type {string} */ as) => ws(as),
    });
    const store = {
        sessions: async () => [...infos.keys()],
        resolve: async (/** @type {string} */ name) => ({ ...ws(name), info: infos.get(name) }),
        open: async (/** @type {string} */ name) => ws(name),
        delete: async (/** @type {string} */ name) => void infos.delete(name),
        repo: { branches: { has: async () => false } },
    };
    return {
        PLANE: "studio",
        newName: () => `s-new${++n}`,
        openStore: async () => store,
        metaOf: async (/** @type {any} */ view) => view.info,
        settleFork: async (/** @type {any} */ child, /** @type {any} */ meta, /** @type {any} */ source) => {
            infos.set(child.session, { name: child.session, title: meta.title, createdAt: 0, updatedAt: 0, ...(source && { source }) });
        },
    };
});
vi.mock("./app-db-clients.js", () => ({
    appDbs: { share: async () => {}, copyTo: async () => false, forget: async () => {}, release: async () => {} },
}));
vi.mock("./session.svelte.js", () => ({ ChatSession: class {} }));
vi.mock("./profile.js", () => ({ PROFILE: {} }));
vi.mock("./snapshot.js", () => ({ snapshotBranch: async () => {} }));
vi.mock("./app-tasks.svelte.js", () => ({ appAgent: { forget: () => {} } }));
vi.mock("./app-storage.js", () => ({ copy: () => {}, remove: () => {} }));

const { Studio } = await import("./studio.svelte.js");
const { vault } = await import("./vault.svelte.js");

const STRIPE = "https://api.stripe.com";
const need = { name: "STRIPE_KEY", origins: [STRIPE] };
const gist = { owner: "ann", id: "abc123", slug: "prices", revision: "f".repeat(40), pinned: false };

/** @type {string} */
let key;
beforeEach(() => {
    const items = new Map();
    vi.stubGlobal("localStorage", {
        getItem: (/** @type {string} */ k) => items.get(k) ?? null,
        setItem: (/** @type {string} */ k, /** @type {string} */ v) => items.set(k, String(v)),
        removeItem: (/** @type {string} */ k) => items.delete(k),
    });
    for (const e of [...vault.entries]) vault.remove(e.id);
    infos.clear();
    key = vault.add({ label: "Stripe", value: "sk_test_fake_studio", origins: [STRIPE] }, { studioOrigins: [] });
});

describe("the studio's sessions and the vault", () => {
    it("give a fork its parent's grants, as an app of its own", async () => {
        infos.set("s-imp", { name: "s-imp", title: "Prices", createdAt: 0, updatedAt: 0, source: { head: "h1", gist } });
        const studio = new Studio();
        await studio.refresh();
        vault.grant("gist:ann/abc123", need, key);
        const child = await studio.forkAs("s-imp", "Mine");
        expect(studio.appKey(child)).toBe(`session:${child}`);
        expect(vault.grantsOf(`session:${child}`)).toEqual({ STRIPE_KEY: key });
        vault.revoke(`session:${child}`);
        expect(vault.grantsOf("gist:ann/abc123")).toEqual({ STRIPE_KEY: key });
    });

    it("forget a removed session's grants, unless another session is the same app", async () => {
        infos.set("s-a", { name: "s-a", title: "Prices", createdAt: 0, updatedAt: 0, source: { head: "h1", gist } });
        infos.set("s-b", { name: "s-b", title: "Prices v2", createdAt: 0, updatedAt: 0, source: { head: "h2", gist } });
        infos.set("s-own", { name: "s-own", title: "Mine", createdAt: 0, updatedAt: 0 });
        const studio = new Studio();
        await studio.refresh();
        vault.grant("gist:ann/abc123", need, key);
        vault.grant("session:s-own", need, key);
        // keep a session looked at, so removing others doesn't open one
        studio.current = /** @type {any} */ ({ name: "s-own" });
        await studio.remove("s-a");
        expect(vault.grantsOf("gist:ann/abc123")).toEqual({ STRIPE_KEY: key });
        await studio.remove("s-b");
        expect(vault.grantsOf("gist:ann/abc123")).toEqual({});
        studio.current = /** @type {any} */ ({ name: "elsewhere" });
        await studio.remove("s-own");
        expect(vault.usedBy(key)).toEqual([]);
    });
});
