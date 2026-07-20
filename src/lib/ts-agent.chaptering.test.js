/**
 * Regression test for chaptering-band reconstruction in `loadHistory`.
 *
 * Bug (found in a real exported session, "apoca-laps"): when a later
 * chaptering run re-folds an earlier run's chapter — nesting it — the
 * history reload rendered "0 chapters created" for the most-recent
 * bands, even though the folds had happened and the token context had
 * shrunk. Root cause: `_doFlatten` collected metadata only for
 * *top-level* chapters, but the main walk re-expands every historical
 * `__chapter__` run into its own band; with fewer top-level chapters
 * than bands, the FIFO drain starved the later (recent) bands.
 *
 * The fix collects chapter metadata at every nesting depth and orders
 * it by application time so each band drains its own run's chapters.
 *
 * These tests drive `_reconstructHistory` directly with a synthetic
 * `{ iter, byKey }` log modeling the re-fold, so no agent pool or LLM
 * is needed.
 */

import { describe, expect, it } from "vitest";
import { _reconstructHistory } from "./ts-agent.js";

/** Build a fake EventLog over an in-memory {stateKey -> event} map.
 *  `activeKeys` is the active index (what `iter()` yields, in order);
 *  every key (active or folded-away) is resolvable via `byKey`. */
function fakeLog(store, activeKeys) {
    return {
        async *iter() {
            for (const k of activeKeys) yield store.get(k);
        },
        async byKey(k) {
            return store.get(k) ?? null;
        },
    };
}

/** Terse event builders. Timestamps are ISO strings so both `_toDate`
 *  and the chapter-order sort see real, comparable values. */
const iso = (n) => `2026-01-01T00:00:${String(n).padStart(2, "0")}.000Z`;
const userStart = (ts, msg) => ({
    type: "taskStart",
    taskName: "Answer the user's chat message.",
    inputs: msg,
    timestamp: iso(ts),
});
const chapterStart = (ts) => ({
    type: "taskStart",
    taskName: "__chapter__",
    inputs: "index",
    timestamp: iso(ts),
});
const success = (ts, result) => ({ type: "success", result, timestamp: iso(ts) });
const chapterEvent = (ts, name, eventRefs) => ({
    type: "chapter",
    name,
    message: `summary of ${name}`,
    slug: name.toLowerCase().replace(/\s+/g, "-"),
    eventRefs,
    timestamp: iso(ts),
});

/** Names of the chapters attached to each chaptering band, in order. */
function bandChapterNames(messages) {
    return messages
        .filter((m) => m.role === "chaptering")
        .map((m) => (m.chapters || []).map((c) => c.name));
}

describe("loadHistory chaptering bands — nested re-fold", () => {
    // Scenario mirroring the real session at minimum size:
    //   1. user turns A, B                          (keys uA*, uB*)
    //   2. run 1 folds A+B into chapter C1          (keys r1*, C1)
    //   3. user turn C                              (keys uC*)
    //   4. run 2 re-folds [C1, run-1 bookkeeping, C]
    //      into a single chapter C2 — nesting C1.   (keys r2*, C2)
    // Final active index is just [C2, r2_start, r2_success]; everything
    // else lives folded under C2 (and C1) and resolves via byKey.
    function buildRefoldLog() {
        const store = new Map();
        const put = (k, ev) => store.set(k, ev);

        // Run-1 originals (folded under C1)
        put("uA_start", userStart(1, "userA"));
        put("uA_success", success(2, "replyA"));
        put("uB_start", userStart(3, "userB"));
        put("uB_success", success(4, "replyB"));
        put("C1", chapterEvent(7, "C1", ["uA_start", "uA_success", "uB_start", "uB_success"]));

        // Run-1 bookkeeping (folded under C2) + user turn C (folded under C2)
        put("r1_start", chapterStart(5));
        put("r1_success", success(6, [{ name: "C1" }]));
        put("uC_start", userStart(8, "userC"));
        put("uC_success", success(9, "replyC"));

        // Run-2 chapter re-folding C1 + run-1 bookkeeping + turn C
        put("C2", chapterEvent(13, "C2", [
            "C1",
            "r1_start",
            "r1_success",
            "uC_start",
            "uC_success",
        ]));
        // Run-2 bookkeeping (stays top-level in the active index)
        put("r2_start", chapterStart(11));
        put("r2_success", success(12, [{ name: "C2" }]));

        return fakeLog(store, ["C2", "r2_start", "r2_success"]);
    }

    it("renders one band per run, each populated with its own chapters", async () => {
        const messages = await _reconstructHistory(buildRefoldLog());
        const bands = bandChapterNames(messages);

        // Two chaptering runs => two bands, and — the crux — neither is
        // empty. Pre-fix, band #1 (the recent run) came back as [].
        expect(bands).toHaveLength(2);
        expect(bands[0]).toHaveLength(1);
        expect(bands[1]).toHaveLength(1);
    });

    it("attributes each band to the chapters its own run produced", async () => {
        const messages = await _reconstructHistory(buildRefoldLog());
        const bands = bandChapterNames(messages);

        // Run 1's band shows C1; run 2's band shows C2. Pre-fix, the
        // single top-level chapter (C2) landed on the *first* band and
        // the second band was empty — both wrong.
        expect(bands[0]).toEqual(["C1"]);
        expect(bands[1]).toEqual(["C2"]);
    });

    it("still surrounds the bands with the pre-fold turns", async () => {
        const messages = await _reconstructHistory(buildRefoldLog());
        const userContent = messages
            .filter((m) => m.role === "user")
            .map((m) => m.content);
        // The originals folded away under C1/C2 are re-expanded into the
        // visible scroll, so all three user turns still render.
        expect(userContent).toEqual(["userA", "userB", "userC"]);
    });
});

describe("loadHistory chaptering bands — flat (no nesting)", () => {
    // Guard the ordinary case: two independent runs, no re-fold. Both
    // chapters stay top-level; each band gets its own. (Confirms the
    // all-depth collect + sort didn't regress the common path.)
    it("pairs each run with its chapter", async () => {
        const store = new Map();
        const put = (k, ev) => store.set(k, ev);
        put("uA_start", userStart(1, "userA"));
        put("uA_success", success(2, "replyA"));
        put("C1", chapterEvent(4, "C1", ["uA_start", "uA_success"]));
        put("r1_start", chapterStart(3));
        put("r1_success", success(5, [{ name: "C1" }]));
        put("uB_start", userStart(6, "userB"));
        put("uB_success", success(7, "replyB"));
        put("C2", chapterEvent(9, "C2", ["uB_start", "uB_success"]));
        put("r2_start", chapterStart(8));
        put("r2_success", success(10, [{ name: "C2" }]));

        // Active index: C1, run-1 bookkeeping, C2, run-2 bookkeeping.
        const log = fakeLog(store, [
            "C1",
            "r1_start",
            "r1_success",
            "C2",
            "r2_start",
            "r2_success",
        ]);
        const bands = bandChapterNames(await _reconstructHistory(log));
        expect(bands).toEqual([["C1"], ["C2"]]);
    });
});
