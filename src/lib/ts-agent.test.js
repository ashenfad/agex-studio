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

import {
    _conversationKey,
    _isAgentMemoryKey,
    _usesSessionAffinity,
} from "./ts-agent.js";

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

describe("_usesSessionAffinity", () => {
    const custom = { accessMode: "custom", provider: "anthropic" };

    it("applies to an Anthropic-shape custom endpoint (Meridian)", () => {
        expect(
            _usesSessionAffinity({ ...custom, baseUrl: "http://127.0.0.1:3456" }),
        ).toBe(true);
    });

    it("never applies to endpoints whose CORS would reject the header", () => {
        expect(
            _usesSessionAffinity({
                ...custom,
                baseUrl: "https://api.anthropic.com/v1",
            }),
        ).toBe(false);
        expect(_usesSessionAffinity({ ...custom, baseUrl: "" })).toBe(false);
        expect(
            _usesSessionAffinity({
                accessMode: "openrouter",
                model: "anthropic/claude-opus-5-5",
            }),
        ).toBe(false);
    });

    it("does not apply to OpenAI-shape traffic", () => {
        expect(
            _usesSessionAffinity({
                accessMode: "custom",
                provider: "openai",
                baseUrl: "http://127.0.0.1:3456",
            }),
        ).toBe(false);
    });
});

describe("_conversationKey", () => {
    const opening = { role: "user", content: [{ type: "text", text: "hi" }] };
    const body = (messages) => JSON.stringify({ messages });

    it("is stable as the conversation grows", async () => {
        const first = await _conversationKey("chat-a", body([opening]));
        const later = await _conversationKey(
            "chat-a",
            body([opening, { role: "assistant", content: [] }, opening]),
        );
        expect(first).toMatch(/^agex-studio:chat-a:[0-9a-f]{16}$/);
        expect(later).toBe(first);
    });

    it("ignores cache_control moving onto the opening message", async () => {
        const marked = {
            role: "user",
            content: [
                { type: "text", text: "hi", cache_control: { type: "ephemeral" } },
            ],
        };
        expect(await _conversationKey("chat-a", body([marked]))).toBe(
            await _conversationKey("chat-a", body([opening])),
        );
    });

    it("separates branches and different opening messages", async () => {
        const a = await _conversationKey("chat-a", body([opening]));
        const other = { role: "user", content: [{ type: "text", text: "yo" }] };
        expect(await _conversationKey("chat-b", body([opening]))).not.toBe(a);
        expect(await _conversationKey("chat-a", body([other]))).not.toBe(a);
    });

    it("returns null when there is no opening message", async () => {
        expect(await _conversationKey("chat-a", body([]))).toBeNull();
        expect(await _conversationKey("chat-a", "not json")).toBeNull();
        expect(await _conversationKey("chat-a", undefined)).toBeNull();
    });
});
