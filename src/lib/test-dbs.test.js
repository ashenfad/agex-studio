import { describe, expect, it } from "vitest";
import { STALE_MS, TEST_DB_ROOT, sweepTestDbs } from "./test-dbs.js";

const NOW = 1_000_000_000;

/** A file whose last write was `age` ms ago, or one open in a worker (`busy`). */
const file = (/** @type {number | "busy"} */ age) => ({
    kind: "file",
    async getFile() {
        if (age === "busy") throw new DOMException("open", "NoModificationAllowedError");
        return { lastModified: NOW - age };
    },
});

/** An OPFS directory of the given entries, recording what's removed. */
function dir(/** @type {Record<string, any>} */ entries) {
    const removed = /** @type {string[]} */ ([]);
    return {
        kind: "directory",
        removed,
        async *entries() {
            yield* Object.entries(entries);
        },
        async getDirectoryHandle(/** @type {string} */ name) {
            const found = entries[name];
            if (found?.kind !== "directory") throw new DOMException("missing", "NotFoundError");
            return found;
        },
        async removeEntry(/** @type {string} */ name) {
            removed.push(name);
        },
    };
}

const locks = (/** @type {string[]} */ held, /** @type {string[]} */ pending = []) => ({
    query: async () => ({ held: held.map((name) => ({ name })), pending: pending.map((name) => ({ name })) }),
});

describe("sweeping test copies", () => {
    it("removes copies no tab has open that were left long enough ago", async () => {
        const tests = dir({
            "test-old": dir({ "db.sqlite": file(STALE_MS + 1), "db.sqlite-journal": file(STALE_MS + 5) }),
            "test-new": dir({ "db.sqlite": file(1_000) }),
            "test-held": dir({ "db.sqlite": file(STALE_MS * 3) }),
            "test-waited": dir({ "db.sqlite": file(STALE_MS * 3) }),
            "test-busy": dir({ "db.sqlite": file("busy") }),
            "test-empty": dir({}),
            "stray.txt": file(STALE_MS * 3),
        });
        const root = dir({ [TEST_DB_ROOT]: tests });
        const removed = await sweepTestDbs({
            root: /** @type {any} */ (root),
            locks: locks(["kvsql:test-held"], ["kvsql:test-waited"]),
            now: NOW,
        });
        expect(removed).toEqual(["test-old", "test-empty"]);
        expect(tests.removed).toEqual(["test-old", "test-empty"]);
    });

    it("does nothing where no copy was ever made", async () => {
        expect(await sweepTestDbs({ root: /** @type {any} */ (dir({})), locks: locks([]), now: NOW })).toEqual([]);
    });
});
