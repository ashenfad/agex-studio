import { beforeEach, describe, expect, it } from "vitest";
import { updateSettings } from "./settings.js";
import { DEEP_SEARCH_MODEL, FETCH_MODEL, SEARCH_MODEL, Web } from "./web.js";

/** A fetch that answers each request with `reply(body)`, and keeps
 *  what it was sent. */
function stub(/** @type {(body: any) => { status?: number, json?: unknown, text?: string }} */ reply) {
    /** @type {{ url: string, body: any, headers: any }[]} */
    const sent = [];
    const fetchImpl = /** @type {typeof fetch} */ (
        /** @type {unknown} */ (
            async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
                const body = JSON.parse(String(init.body));
                sent.push({ url, body, headers: init.headers });
                const r = reply(body);
                return new Response(r.text ?? JSON.stringify(r.json), { status: r.status ?? 200 });
            }
        )
    );
    return { fetchImpl, sent };
}

const answer = (/** @type {string} */ content, extra = {}) => ({ choices: [{ message: { content, ...extra } }] });

beforeEach(() => updateSettings({ accessMode: "openrouter", routerKey: "sk-test" }));

describe("web.search", () => {
    it("answers with its numbered sources, on the key in the settings", async () => {
        const { fetchImpl, sent } = stub(() => ({
            json: answer(" Oslo is the capital [1]. ", {
                annotations: [
                    { type: "url_citation", url_citation: { url: "https://a.example", title: "A" } },
                    { type: "url_citation", url_citation: { url: "https://b.example" } },
                ],
            }),
        }));
        const out = await new Web({ fetchImpl }).search("capital of Norway?");
        expect(out).toBe("Oslo is the capital [1].\n\nSources:\n[1] A — https://a.example\n[2] https://b.example");
        expect(sent[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
        expect(sent[0]?.body.model).toBe(SEARCH_MODEL);
        expect(sent[0]?.headers.Authorization).toBe("Bearer sk-test");
    });

    it("runs a deep search on the deeper model", async () => {
        const { fetchImpl, sent } = stub(() => ({ json: answer("ok") }));
        expect(await new Web({ fetchImpl }).search("q", { deep: true })).toBe("ok");
        expect(sent[0]?.body.model).toBe(DEEP_SEARCH_MODEL);
    });

    it("refuses without an OpenRouter key, saying what to change", async () => {
        updateSettings({ accessMode: "custom", routerKey: "" });
        const { fetchImpl, sent } = stub(() => ({ json: answer("ok") }));
        await expect(new Web({ fetchImpl }).search("q")).rejects.toThrow(/web\.search: .*no OpenRouter key/);
        expect(sent).toEqual([]);
    });

    it("names an HTTP failure, and the start of its body", async () => {
        const { fetchImpl } = stub(() => ({ status: 402, text: "Insufficient credits" }));
        await expect(new Web({ fetchImpl }).search("q")).rejects.toThrow("web.search: HTTP 402: Insufficient credits");
    });
});

describe("web.fetch", () => {
    it("reads the page with the fetch tool, and credits it", async () => {
        const { fetchImpl, sent } = stub(() => ({
            json: { ...answer("It says 42."), usage: { server_tool_use_details: { tool_calls_executed: 1 } } },
        }));
        expect(await new Web({ fetchImpl }).fetch("https://x.example/p", "what number?")).toBe(
            "It says 42.\n\nSource: https://x.example/p",
        );
        expect(sent[0]?.body.model).toBe(FETCH_MODEL);
        expect(sent[0]?.body.tools[0].type).toBe("openrouter:web_fetch");
        expect(sent[0]?.body.tool_choice).toBe("required");
    });

    it("refuses an answer given without reading the page", async () => {
        const { fetchImpl } = stub(() => ({ json: answer("From memory: 42.") }));
        await expect(new Web({ fetchImpl }).fetch("https://x.example/p", "q")).rejects.toThrow(/the page was not read/);
    });

    it("refuses what isn't an http(s) URL, or no question", async () => {
        const web = new Web({ fetchImpl: stub(() => ({ json: {} })).fetchImpl });
        await expect(web.fetch("file:///etc/passwd", "q")).rejects.toThrow(/not an http\(s\) URL/);
        await expect(web.fetch("https://x.example", " ")).rejects.toThrow(/say what to find/);
    });
});
