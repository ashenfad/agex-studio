import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal localStorage stub — vitest's default env doesn't provide one
// (matches session-index.test.js / settings.test.js).
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

import {
    CHECK_TTL_MS,
    checkGistUpdate,
    getImportInfo,
    hasUpdate,
    ignoreUpdate,
    isUnviewed,
    latestRevisionOf,
    makeImportInfo,
    markUpdatesSeen,
    parseGistSource,
    setImportInfo,
} from "./gist-update.js";

const SHA1 = "a".repeat(40);
const SHA2 = "b".repeat(40);

/** Fake fetch returning a Response-like object. */
function resp(status, body) {
    return async () => ({
        status,
        ok: status >= 200 && status < 300,
        json: async () => body,
    });
}
const gist = (version) => ({ history: [{ version }] });

beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
});

describe("parseGistSource", () => {
    it("parses a 3-part HEAD-tracking shorthand", () => {
        expect(parseGistSource("alice/deadbeef/my-app")).toEqual({
            user: "alice",
            id: "deadbeef",
            slug: "my-app",
            pinned: false,
            sha: null,
        });
    });

    it("parses a 4-part SHA-pinned shorthand as pinned", () => {
        const s = parseGistSource(`bob/cafe1234/${SHA1}/widget`);
        expect(s).toMatchObject({ id: "cafe1234", pinned: true, sha: SHA1 });
    });

    it("rejects arbitrary URLs and malformed shorthands", () => {
        expect(parseGistSource("https://example.com/x.b64")).toBeNull();
        expect(parseGistSource("alice/deadbeef")).toBeNull(); // 2-part
        expect(parseGistSource("alice/NOThex/slug")).toBeNull();
        expect(parseGistSource("alice/dead/badsha/slug")).toBeNull();
        expect(parseGistSource(null)).toBeNull();
    });
});

describe("latestRevisionOf", () => {
    it("reads history[0].version", () => {
        expect(latestRevisionOf(gist(SHA1))).toBe(SHA1);
    });
    it("returns null for malformed responses", () => {
        expect(latestRevisionOf({})).toBeNull();
        expect(latestRevisionOf({ history: [] })).toBeNull();
        expect(latestRevisionOf(null)).toBeNull();
    });
});

describe("hasUpdate / isUnviewed", () => {
    const base = makeImportInfo(
        { id: "g", user: "u", slug: "s", pinned: false, sha: null },
        "head1",
    );

    it("no update when latest matches imported", () => {
        expect(
            hasUpdate({ ...base, importedRevision: SHA1, latestRevision: SHA1 }),
        ).toBe(false);
    });

    it("update when latest differs from imported", () => {
        expect(
            hasUpdate({ ...base, importedRevision: SHA1, latestRevision: SHA2 }),
        ).toBe(true);
    });

    it("no update for pinned, deleted, or dismissed revisions", () => {
        const upd = { ...base, importedRevision: SHA1, latestRevision: SHA2 };
        expect(hasUpdate({ ...upd, pinned: true })).toBe(false);
        expect(hasUpdate({ ...upd, deleted: true })).toBe(false);
        expect(hasUpdate({ ...upd, ignoredRevision: SHA2 })).toBe(false);
    });

    it("unviewed only until the latest revision has been seen", () => {
        const upd = { ...base, importedRevision: SHA1, latestRevision: SHA2 };
        expect(isUnviewed(upd)).toBe(true);
        expect(isUnviewed({ ...upd, lastSeenUpdateRevision: SHA2 })).toBe(false);
    });
});

describe("checkGistUpdate", () => {
    const source = { id: "g1", user: "u", slug: "s", pinned: false, sha: null };

    it("baselines importedRevision on the first check (no spurious update)", async () => {
        setImportInfo("chat-a", makeImportInfo(source, "head1"));
        const info = await checkGistUpdate("chat-a", {
            fetchImpl: resp(200, gist(SHA1)),
            now: 1000,
        });
        expect(info.importedRevision).toBe(SHA1);
        expect(info.latestRevision).toBe(SHA1);
        expect(hasUpdate(info)).toBe(false);
    });

    it("flags an update when a newer revision lands after baseline", async () => {
        setImportInfo("chat-a", makeImportInfo(source, "head1"));
        await checkGistUpdate("chat-a", { fetchImpl: resp(200, gist(SHA1)), now: 1 });
        const info = await checkGistUpdate("chat-a", {
            fetchImpl: resp(200, gist(SHA2)),
            force: true,
            now: 2,
        });
        expect(hasUpdate(info)).toBe(true);
        expect(info.importedRevision).toBe(SHA1);
        expect(info.latestRevision).toBe(SHA2);
    });

    it("skips the poll inside the TTL window unless forced", async () => {
        setImportInfo("chat-a", {
            ...makeImportInfo(source, "head1"),
            importedRevision: SHA1,
            latestRevision: SHA1,
            lastCheckedAt: 1000,
        });
        let called = false;
        const spy = async () => {
            called = true;
            return { status: 200, ok: true, json: async () => gist(SHA2) };
        };
        await checkGistUpdate("chat-a", {
            fetchImpl: spy,
            now: 1000 + CHECK_TTL_MS - 1,
        });
        expect(called).toBe(false);
        // forced bypasses the window
        const info = await checkGistUpdate("chat-a", {
            fetchImpl: spy,
            force: true,
            now: 1000 + 1,
        });
        expect(called).toBe(true);
        expect(info.latestRevision).toBe(SHA2);
    });

    it("marks the source deleted on 404", async () => {
        setImportInfo("chat-a", makeImportInfo(source, "head1"));
        const info = await checkGistUpdate("chat-a", {
            fetchImpl: resp(404, {}),
            now: 1,
        });
        expect(info.deleted).toBe(true);
        expect(hasUpdate(info)).toBe(false);
    });

    it("leaves the record untouched on rate-limit / network error", async () => {
        const seed = {
            ...makeImportInfo(source, "head1"),
            importedRevision: SHA1,
            latestRevision: SHA1,
        };
        setImportInfo("chat-a", seed);
        await checkGistUpdate("chat-a", { fetchImpl: resp(403, {}), force: true });
        expect(getImportInfo("chat-a")).toEqual(seed);
        await checkGistUpdate("chat-a", {
            fetchImpl: async () => {
                throw new Error("net");
            },
            force: true,
        });
        expect(getImportInfo("chat-a")).toEqual(seed);
    });

    it("authenticates with a PAT when provided", async () => {
        setImportInfo("chat-a", makeImportInfo(source, "head1"));
        let seenHeaders = null;
        const spy = async (_url, init) => {
            seenHeaders = init.headers;
            return { status: 200, ok: true, json: async () => gist(SHA1) };
        };
        await checkGistUpdate("chat-a", { fetchImpl: spy, pat: "tok123", now: 1 });
        expect(seenHeaders.Authorization).toBe("token tok123");
    });

    it("uses a provided importInfo without reading storage", async () => {
        // No setImportInfo for chat-x — checkGistUpdate must use the
        // passed-in record rather than returning early on a null lookup.
        let called = false;
        const spy = async () => {
            called = true;
            return { status: 200, ok: true, json: async () => gist(SHA1) };
        };
        const out = await checkGistUpdate("chat-x", {
            fetchImpl: spy,
            importInfo: makeImportInfo(source, "head1"),
            now: 1,
        });
        expect(called).toBe(true);
        expect(out.latestRevision).toBe(SHA1);
    });

    it("never polls a pinned source", async () => {
        setImportInfo(
            "chat-a",
            makeImportInfo({ ...source, pinned: true, sha: SHA1 }, "head1"),
        );
        let called = false;
        await checkGistUpdate("chat-a", {
            fetchImpl: async () => {
                called = true;
                return { status: 200, ok: true, json: async () => gist(SHA2) };
            },
            force: true,
        });
        expect(called).toBe(false);
    });
});

describe("markUpdatesSeen / ignoreUpdate", () => {
    const source = { id: "g1", user: "u", slug: "s", pinned: false, sha: null };

    it("markUpdatesSeen clears the badge but not the card marker", () => {
        setImportInfo("chat-a", {
            ...makeImportInfo(source, "head1"),
            importedRevision: SHA1,
            latestRevision: SHA2,
        });
        expect(isUnviewed(getImportInfo("chat-a"))).toBe(true);
        markUpdatesSeen(["chat-a"]);
        const info = getImportInfo("chat-a");
        expect(isUnviewed(info)).toBe(false); // badge cleared
        expect(hasUpdate(info)).toBe(true); // card marker remains
    });

    it("ignoreUpdate suppresses the current revision", () => {
        setImportInfo("chat-a", {
            ...makeImportInfo(source, "head1"),
            importedRevision: SHA1,
            latestRevision: SHA2,
        });
        ignoreUpdate("chat-a");
        expect(hasUpdate(getImportInfo("chat-a"))).toBe(false);
    });
});
