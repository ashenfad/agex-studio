/**
 * Tests for studio-side ts-agent helpers.
 *
 * `ts-agent.js` is mostly thin wrappers around agex-ts that aren't
 * worth unit-testing in isolation — the integration value lives in
 * the `ts-kernel-adapter.test.js` shape suite. But the
 * `_isAgentMemoryKey` predicate IS a real contract: a misclassified
 * prefix would silently delete the wrong keys during a fresh-chat
 * fork (e.g. mistaking `f:` for memory would wipe the VFS). Pin it
 * here so any tweak gets a paper trail.
 */

import { describe, expect, it } from "vitest";

import { _isAgentMemoryKey } from "./ts-agent.js";

describe("_isAgentMemoryKey", () => {
    it("matches event-log entries by their evt/ prefix", () => {
        expect(_isAgentMemoryKey("evt/abc")).toBe(true);
        expect(_isAgentMemoryKey("evt/00000000")).toBe(true);
        expect(_isAgentMemoryKey("evt/")).toBe(true);
    });

    it("matches the event-log index key by exact name", () => {
        expect(_isAgentMemoryKey("__event_log__")).toBe(true);
    });

    it("matches cache entries by their cache/ prefix", () => {
        expect(_isAgentMemoryKey("cache/foo")).toBe(true);
        expect(_isAgentMemoryKey("cache/nested/path")).toBe(true);
    });

    it("matches the legacy sub-task key by exact name", () => {
        expect(_isAgentMemoryKey("__subtasks__")).toBe(true);
    });

    it("does NOT match VFS file blob keys", () => {
        // @agex-ts/termish kvgit-fs prefixes — wiping these would lose
        // every file in the workspace, the exact opposite of what
        // the fresh-chat fork should do.
        expect(_isAgentMemoryKey("f:app/index.html")).toBe(false);
        expect(_isAgentMemoryKey("f:data.csv")).toBe(false);
        expect(_isAgentMemoryKey("f:uploads/photo.jpg")).toBe(false);
        expect(_isAgentMemoryKey("d:app")).toBe(false);
        expect(_isAgentMemoryKey("d:helpers")).toBe(false);
    });

    it("does NOT match session metadata keys", () => {
        // Session identity / title / kernel — fresh-chat keeps
        // these (we just rewrite the title separately).
        expect(_isAgentMemoryKey("__session_title__")).toBe(false);
        expect(_isAgentMemoryKey("__session_name__")).toBe(false);
        expect(_isAgentMemoryKey("__session_description__")).toBe(false);
        expect(_isAgentMemoryKey("__session_updated__")).toBe(false);
        expect(_isAgentMemoryKey("__session_kernel__")).toBe(false);
        expect(_isAgentMemoryKey("__session_external__")).toBe(false);
        // Starring is a user "keep this app" preference, not agent
        // memory — a chat-reset/fresh-fork must not silently unstar.
        expect(_isAgentMemoryKey("__session_starred__")).toBe(false);
    });

    it("does NOT match unknown keys (defensive — keep what we don't recognize)", () => {
        // If a future agex-ts version adds a new internal key,
        // defaulting to "keep" is safer than "wipe" — we'd rather
        // carry over something we shouldn't than silently lose
        // something the new branch needs.
        expect(_isAgentMemoryKey("__some_future_agex_key__")).toBe(false);
        expect(_isAgentMemoryKey("custom/agent-extension/foo")).toBe(false);
        expect(_isAgentMemoryKey("random-key")).toBe(false);
    });

    it("is strict about exact-match keys (no prefix match for them)", () => {
        // __subtasks__ is exact-match, not a prefix — a hypothetical
        // `__subtasks__foo` key shouldn't be wiped.
        expect(_isAgentMemoryKey("__subtasks__foo")).toBe(false);
        expect(_isAgentMemoryKey("__event_log__/index")).toBe(false);
    });
});
