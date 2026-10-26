import { beforeEach, describe, expect, it, vi } from "vitest";

// the studio's sessions, by name, as its list shows them
const { sessions } = vi.hoisted(() => ({ sessions: /** @type {any[]} */ ([]) }));

vi.mock("./bundle.js", () => ({
    applyBundle: async () => {},
    bundleFileName: () => "app.agex",
    encodeBundle: async () => new Uint8Array(),
    readBundleHeader: () => ({ header: { head: "h1", title: "Prices" } }),
}));
vi.mock("./gist.js", () => ({ fetchGistBundle: async () => {}, latestRevision: async () => {}, parseGistParam: () => null, publishGist: async () => {} }));
vi.mock("./snapshot.js", () => ({ snapshotBranch: async () => {} }));
vi.mock("./store.js", () => ({ PLANE: "studio", metaOf: async () => ({}), newName: () => "s-new", openStore: async () => ({}) }));
vi.mock("./studio.svelte.js", async () => {
    const { appKeyOf } = await import("./vault.svelte.js");
    return {
        studio: {
            sessions,
            refresh: async () => {},
            switchTo: async () => {},
            appKey: (/** @type {string} */ name) => appKeyOf(sessions.find((s) => s.name === name) ?? { name }),
            withWorkspace: async (/** @type {string} */ name, /** @type {any} */ fn) =>
                fn({
                    plane: () => ({ set: (/** @type {string} */ key, /** @type {any} */ value) => Object.assign(sessions.find((s) => s.name === name), { [key]: value }) }),
                    autoCommit: async () => {},
                }),
        },
    };
});

const { distribution } = await import("./distribution.svelte.js");
const { vault } = await import("./vault.svelte.js");

const need = { name: "STRIPE_KEY", origins: ["https://api.stripe.com"] };
const gist = { owner: "ada", id: "g1", slug: "prices", revision: "r1", pinned: false };

describe("an import opened again from its gist", () => {
    beforeEach(() => {
        sessions.length = 0;
        for (const e of [...vault.entries]) vault.remove(e.id);
        for (const app of Object.keys(vault.grants)) vault.revoke(app);
    });

    it("takes its grants to the app it now is", async () => {
        sessions.push({ name: "s-1", title: "Prices", source: { head: "h1" } });
        const id = vault.add({ label: "Stripe", value: "sk_test_fake_1", origins: ["https://api.stripe.com"] });
        vault.grant("bundle:h1", need, id);

        const out = await distribution.importBundle(new Uint8Array(), { gist });
        expect(out).toEqual({ name: "s-1", existing: true });
        expect(vault.grantsOf("gist:ada/g1")).toEqual({ STRIPE_KEY: id });
        expect(vault.valueFor("gist:ada/g1", need)).toBe("sk_test_fake_1");
        // nothing left behind to come back on a later import of the bundle
        expect(vault.grantsOf("bundle:h1")).toEqual({});
    });

    it("leaves the bundle's grants to another copy that is still the bundle", async () => {
        sessions.push({ name: "s-1", title: "Prices", source: { head: "h1" } }, { name: "s-2", title: "Prices", source: { head: "h1" } });
        const id = vault.add({ label: "Stripe", value: "sk_test_fake_2", origins: ["https://api.stripe.com"] });
        vault.grant("bundle:h1", need, id);
        await distribution.importBundle(new Uint8Array(), { gist });
        expect(vault.grantsOf("gist:ada/g1")).toEqual({ STRIPE_KEY: id });
        expect(vault.grantsOf("bundle:h1")).toEqual({ STRIPE_KEY: id });
    });
});
