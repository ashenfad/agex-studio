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

/** An extension found, which keeps what it's told, and opens its port on `open()`. */
function fakeExtension(status = "found") {
    /** @type {any[]} */
    const told = [];
    /** @type {() => void} */
    let opened = () => {};
    const ext = {
        status,
        told,
        open: () => opened(),
        call: async (/** @type {string} */ op, /** @type {any} */ args) => {
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

describe("watchSites", () => {
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

    it("tells it all again each time the port opens", () => {
        const vault = new Vault();
        vault.grantSites("s1", ["marriott.com"]);
        const ext = fakeExtension();
        const sites = watchSites({ vault, extension: /** @type {any} */ (ext), titleOf: () => "Trip" });
        ext.open();
        expect(ext.told.map((t) => t.domains)).toEqual([["marriott.com"], ["marriott.com"]]);
        sites.stop();
    });

    it("tells nothing while the extension isn't here, and all once it opens", () => {
        const vault = new Vault();
        const ext = fakeExtension("absent");
        const sites = watchSites({ vault, extension: /** @type {any} */ (ext), titleOf: () => "Trip" });
        vault.grantSites("s1", ["marriott.com"]);
        expect(ext.told).toEqual([]);
        ext.status = "found";
        ext.open();
        expect(ext.told).toEqual([{ op: "session", session: "s1", name: "Trip", domains: ["marriott.com"] }]);
        sites.stop();
    });
});
