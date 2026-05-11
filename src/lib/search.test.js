/**
 * Unit tests for `search.js`.
 *
 * Coverage focus on `runSearch` (the orchestrator). The
 * `search()` wrapper is just `getSettings()` + `runSearch` so it
 * doesn't earn its own tests beyond the integration call site.
 */

import { describe, expect, it, vi } from "vitest";

import { runSearch } from "./search.js";

const baseSettings = {
    apiKey: "sk-test",
    accessMode: "openrouter",
};

/** Build a minimal `fetch` stub that returns the given body / status.
 *  Returns the stub function and a captured-args ref so tests can
 *  assert on URL / headers / body. */
function stubFetch({ body = {}, status = 200, statusText = "OK", throwOn = null } = {}) {
    const captured = { url: null, init: null };
    const stub = vi.fn(async (url, init) => {
        captured.url = url;
        captured.init = init;
        if (throwOn) throw new Error(throwOn);
        return {
            ok: status >= 200 && status < 300,
            status,
            statusText,
            json: async () => body,
            text: async () =>
                typeof body === "string" ? body : JSON.stringify(body),
        };
    });
    return { stub, captured };
}

function okBody(content = "Wikipedia says...") {
    return { choices: [{ message: { content } }] };
}

describe("runSearch", () => {
    it("posts to /chat/completions on the resolved base URL with bearer auth", async () => {
        const { stub, captured } = stubFetch({ body: okBody() });
        await runSearch({
            query: "what is the capital of France?",
            settings: baseSettings,
            fetchImpl: stub,
        });

        expect(captured.url).toBe(
            "https://openrouter.ai/api/v1/chat/completions",
        );
        expect(captured.init.method).toBe("POST");
        expect(captured.init.headers).toMatchObject({
            "Content-Type": "application/json",
            Authorization: "Bearer sk-test",
        });
        const sent = JSON.parse(captured.init.body);
        expect(sent.model).toBe("perplexity/sonar");
        expect(sent.messages[1]).toEqual({
            role: "user",
            content: "what is the capital of France?",
        });
        expect(sent.messages[0].role).toBe("system");
    });

    it("uses the deep model when `deep: true`", async () => {
        const { stub, captured } = stubFetch({ body: okBody() });
        await runSearch({
            query: "trace the history of the printing press",
            deep: true,
            settings: baseSettings,
            fetchImpl: stub,
        });
        expect(JSON.parse(captured.init.body).model).toBe(
            "perplexity/sonar-pro-search",
        );
    });

    it("returns the model's text content", async () => {
        const { stub } = stubFetch({ body: okBody("Paris (source: ...).") });
        const out = await runSearch({
            query: "?",
            settings: baseSettings,
            fetchImpl: stub,
        });
        expect(out).toBe("Paris (source: ...).");
    });

    it("falls back to OpenRouter base URL when settings has no baseUrl/accessMode", async () => {
        const { stub, captured } = stubFetch({ body: okBody() });
        await runSearch({
            query: "x",
            settings: { apiKey: "sk-test" }, // no accessMode, no baseUrl
            fetchImpl: stub,
        });
        expect(captured.url).toBe(
            "https://openrouter.ai/api/v1/chat/completions",
        );
    });

    it("honors a custom baseUrl from settings", async () => {
        const { stub, captured } = stubFetch({ body: okBody() });
        await runSearch({
            query: "x",
            settings: {
                apiKey: "sk-test",
                baseUrl: "https://my-gateway.example.com/v1",
            },
            fetchImpl: stub,
        });
        expect(captured.url).toBe(
            "https://my-gateway.example.com/v1/chat/completions",
        );
    });

    it("trims trailing slash on baseUrl before joining", async () => {
        const { stub, captured } = stubFetch({ body: okBody() });
        await runSearch({
            query: "x",
            settings: { apiKey: "sk-test", baseUrl: "https://example.com/v1/" },
            fetchImpl: stub,
        });
        expect(captured.url).toBe("https://example.com/v1/chat/completions");
    });

    it("throws on missing API key", async () => {
        const { stub } = stubFetch({});
        await expect(
            runSearch({ query: "x", settings: { apiKey: "" }, fetchImpl: stub }),
        ).rejects.toThrow(/no API key configured/);
        expect(stub).not.toHaveBeenCalled();
    });

    it("throws on empty query", async () => {
        const { stub } = stubFetch({});
        await expect(
            runSearch({ query: "", settings: baseSettings, fetchImpl: stub }),
        ).rejects.toThrow(/query must be a non-empty string/);
        expect(stub).not.toHaveBeenCalled();
    });

    it("throws on non-string query", async () => {
        const { stub } = stubFetch({});
        await expect(
            runSearch({
                query: undefined,
                settings: baseSettings,
                fetchImpl: stub,
            }),
        ).rejects.toThrow(/query must be a non-empty string/);
    });

    it("wraps transport errors with a 'network error' prefix", async () => {
        const { stub } = stubFetch({ throwOn: "Failed to fetch" });
        await expect(
            runSearch({ query: "x", settings: baseSettings, fetchImpl: stub }),
        ).rejects.toThrow(/network error — Failed to fetch/);
    });

    it("surfaces non-2xx with status + truncated body", async () => {
        const { stub } = stubFetch({
            status: 500,
            statusText: "Internal Server Error",
            body: "x".repeat(800),
        });
        await expect(
            runSearch({ query: "x", settings: baseSettings, fetchImpl: stub }),
        ).rejects.toThrow(/HTTP 500 Internal Server Error.*xxx.*…/s);
    });

    it("surfaces non-2xx with no body when text() throws", async () => {
        const stub = vi.fn(async () => ({
            ok: false,
            status: 401,
            statusText: "Unauthorized",
            text: async () => {
                throw new Error("nope");
            },
            json: async () => ({}),
        }));
        await expect(
            runSearch({ query: "x", settings: baseSettings, fetchImpl: stub }),
        ).rejects.toThrow(/HTTP 401 Unauthorized$/);
    });

    it("throws on non-JSON response body", async () => {
        const stub = vi.fn(async () => ({
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => {
                throw new Error("Unexpected token <");
            },
            text: async () => "<html>...",
        }));
        await expect(
            runSearch({ query: "x", settings: baseSettings, fetchImpl: stub }),
        ).rejects.toThrow(/response was not valid JSON/);
    });

    it("throws when the response shape lacks choices[0].message.content", async () => {
        const { stub } = stubFetch({ body: { choices: [{ message: {} }] } });
        await expect(
            runSearch({ query: "x", settings: baseSettings, fetchImpl: stub }),
        ).rejects.toThrow(/missing choices\[0\]\.message\.content/);
    });

    it("supports running multiple searches in parallel", async () => {
        // The orchestrator itself doesn't 'do' parallelism — that's
        // the caller's job — but we verify there's no shared mutable
        // state that breaks under concurrent calls.
        const { stub } = stubFetch({ body: okBody("answer") });
        const results = await Promise.all([
            runSearch({ query: "a", settings: baseSettings, fetchImpl: stub }),
            runSearch({ query: "b", settings: baseSettings, fetchImpl: stub }),
            runSearch({ query: "c", settings: baseSettings, fetchImpl: stub }),
        ]);
        expect(results).toEqual(["answer", "answer", "answer"]);
        expect(stub).toHaveBeenCalledTimes(3);
        const queries = stub.mock.calls.map((c) =>
            JSON.parse(c[1].body).messages[1].content,
        );
        expect(queries.sort()).toEqual(["a", "b", "c"]);
    });
});
