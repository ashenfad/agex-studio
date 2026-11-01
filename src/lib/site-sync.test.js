import { beforeEach, describe, expect, it, vi } from "vitest";
import { watchSites } from "./site-sync.js";
import { Vault } from "./vault.svelte.js";

beforeEach(() => {
    const items = new Map();
    vi.stubGlobal("localStorage", {
        getItem: (/** @type {string} */ k) => items.get(k) ?? null,
        setItem: (/** @type {string} */ k, /** @type {string} */ v) => items.set(k, String(v)),
        removeItem: (/** @type {string} */ k) => items.delete(k),
    });
});

/** An extension found, which keeps what it's told (beside the sessions it
 *  knew already), and opens its port on `open()`. */
function fakeExtension(status = "found", knew = /** @type {string[]} */ ([])) {
    /** @type {any[]} */
    const told = [];
    /** @type {() => void} */
    let opened = () => {};
    const ext = {
        status,
        told,
        open: () => opened(),
        call: async (/** @type {string} */ op, /** @type {any} */ args) => {
            if (op === "sessions") return knew.map((session) => ({ session, name: "", domains: ["old.example"] }));
            told.push({ op, ...args });
            return null;
        },
        onOpen: (/** @type {() => void} */ fn) => {
            opened = fn;
            return () => {};
        },
    };
    return ext;
}

/** Let what the port's opening set off finish. */
const settled = () => new Promise((r) => setTimeout(r, 0));

describe("watchSites", () => {
    it("tells none to a session the extension kept whose sites went while it was away", async () => {
        const vault = new Vault();
        vault.grantSites("s1", ["marriott.com"]);
        const ext = fakeExtension("absent", ["s1", "gone"]);
        const sites = watchSites({ vault, extension: /** @type {any} */ (ext), titleOf: () => "Trip" });
        ext.status = "found";
        ext.open();
        await settled();
        expect(ext.told).toEqual([
            { op: "session", session: "s1", name: "Trip", domains: ["marriott.com"] },
            { op: "session", session: "gone", name: "Trip", domains: [] },
        ]);
        sites.stop();
    });

    it("re-tells a session whose title changed, on sync", () => {
        const vault = new Vault();
        vault.grantSites("s1", ["marriott.com"]);
        const ext = fakeExtension();
        let title = "Trip";
        const sites = watchSites({ vault, extension: /** @type {any} */ (ext), titleOf: () => title });
        sites.sync();
        title = "Lisbon trip";
        sites.sync();
        expect(ext.told.map((t) => t.name)).toEqual(["Trip", "Lisbon trip"]);
        sites.stop();
    });

    it("tells the extension each session's sites as they change, by its title, and none once taken back", async () => {
        const vault = new Vault();
        const ext = fakeExtension();
        const sites = watchSites({ vault, extension: /** @type {any} */ (ext), titleOf: (n) => `Trip ${n}` });
        expect(ext.told).toEqual([]);
        vault.grantSites("s1", ["marriott.com"]);
        vault.grantSites("s1", ["hyatt.com"]);
        vault.revokeSites("s1");
        expect(ext.told).toEqual([
            { op: "session", session: "s1", name: "Trip s1", domains: ["marriott.com"] },
            { op: "session", session: "s1", name: "Trip s1", domains: ["marriott.com", "hyatt.com"] },
            { op: "session", session: "s1", name: "Trip s1", domains: [] },
        ]);
        sites.stop();
    });

    it("tells it all again each time the port opens", async () => {
        const vault = new Vault();
        vault.grantSites("s1", ["marriott.com"]);
        const ext = fakeExtension();
        const sites = watchSites({ vault, extension: /** @type {any} */ (ext), titleOf: () => "Trip" });
        ext.open();
        await settled();
        expect(ext.told.map((t) => t.domains)).toEqual([["marriott.com"], ["marriott.com"]]);
        sites.stop();
    });

    it("tells nothing while the extension isn't here, and all once it opens", async () => {
        const vault = new Vault();
        const ext = fakeExtension("absent");
        const sites = watchSites({ vault, extension: /** @type {any} */ (ext), titleOf: () => "Trip" });
        vault.grantSites("s1", ["marriott.com"]);
        expect(ext.told).toEqual([]);
        ext.status = "found";
        ext.open();
        await settled();
        expect(ext.told).toEqual([{ op: "session", session: "s1", name: "Trip", domains: ["marriott.com"] }]);
        sites.stop();
    });
});

describe("telling the extension of a session given a shared tab", () => {
    it("tells it of a session with no sites, once", async () => {
        const ext = fakeExtension();
        const sites = watchSites({ vault: new Vault(), extension: /** @type {any} */ (ext), titleOf: () => "Mail" });
        await sites.tell("s9");
        await sites.tell("s9");
        expect(ext.told).toEqual([{ op: "session", session: "s9", name: "Mail", domains: [] }]);
        sites.stop();
    });
});
