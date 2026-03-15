import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock runPython — capture calls and return a canned JSON response
const runPythonCalls = [];
const mockResponse = JSON.stringify({
    result: "mock response",
    events: [{ title: "Test", thinking: "I thought", code: "print(1)", terminal: null }],
});

vi.mock("./pyodide.js", () => ({
    runPython: vi.fn((code) => {
        runPythonCalls.push(code);
        return Promise.resolve(mockResponse);
    }),
    runPythonStreaming: vi.fn((code, onToken) => {
        runPythonCalls.push(code);
        return Promise.resolve(mockResponse);
    }),
    setQueryHandler: vi.fn(),
    setLiveIframe: vi.fn(),
}));

import { initAgent, sendMessage, runQuery } from "./agent.js";

beforeEach(() => {
    runPythonCalls.length = 0;
});

describe("initAgent", () => {
    it("sends Python setup code with correct model and key", async () => {
        await initAgent({ apiKey: "sk-test-123", model: "openai/gpt-5.4" });

        expect(runPythonCalls).toHaveLength(1);
        const code = runPythonCalls[0];
        expect(code).toContain('model="openai/gpt-5.4"');
        expect(code).toContain('api_key="sk-test-123"');
        expect(code).toContain("clear_agent_registry()");
        expect(code).toContain("connect_llm");
    });

    it("registers test_app function with auto-display", async () => {
        await initAgent({ apiKey: "sk-test-123", model: "openai/gpt-5.4" });

        const code = runPythonCalls[0];
        expect(code).toContain("async def test_app(actions");
        expect(code).toContain("_js_test_app");
        expect(code).toContain("_display_app_results");
        expect(code).toContain('_agent.fn(test_app, visibility="low")');
    });

    it("registers interactive app skill", async () => {
        await initAgent({ apiKey: "sk-test-123", model: "openai/gpt-5.4" });

        const code = runPythonCalls[0];
        expect(code).toContain("interactive-app.md");
        expect(code).toContain("_agent.skill");
    });

    it("loads gmail module and registers skill", async () => {
        await initAgent({ apiKey: "sk-test-123", model: "openai/gpt-5.4" });

        const code = runPythonCalls[0];
        expect(code).toContain('_open_url("/gmail.py")');
        expect(code).toContain('_sys.modules["gmail"] = _gmail_mod');
        expect(code).toContain("network_access=True");
        expect(code).toContain("gmail.md");
    });

    it("loads sheets module and registers skill", async () => {
        await initAgent({ apiKey: "sk-test-123", model: "openai/gpt-5.4" });

        const code = runPythonCalls[0];
        expect(code).toContain('_open_url("/sheets.py")');
        expect(code).toContain('_sys.modules["sheets"] = _sheets_mod');
        expect(code).toContain("sheets.md");
    });

    it("loads docs module and registers skill", async () => {
        await initAgent({ apiKey: "sk-test-123", model: "openai/gpt-5.4" });

        const code = runPythonCalls[0];
        expect(code).toContain('_open_url("/docs.py")');
        expect(code).toContain('_sys.modules["docs"] = _docs_mod');
        expect(code).toContain("docs.md");
    });

    it("mentions gmail in task primer", async () => {
        await initAgent({ apiKey: "sk-test-123", model: "openai/gpt-5.4" });

        const code = runPythonCalls[0];
        expect(code).toContain("cat /skills/gmail/SKILL.md");
        expect(code).toContain("email, inbox, messages");
    });

    it("mentions test_app auto-display in task primer", async () => {
        await initAgent({ apiKey: "sk-test-123", model: "openai/gpt-5.4" });

        const code = runPythonCalls[0];
        expect(code).toContain("test_app()");
        expect(code).toContain("auto-displayed");
        expect(code).toContain("query() calls in the app work during testing");
        expect(code).toContain('actions=[{"click"');
    });

    it("defines _display_app_results helper", async () => {
        await initAgent({ apiKey: "sk-test-123", model: "openai/gpt-5.4" });

        const code = runPythonCalls[0];
        expect(code).toContain("def _display_app_results(");
        expect(code).toContain('[read ');
        expect(code).toContain('[eval error]');
        expect(code).toContain('[eval]');
    });

    it("registers live_app function with auto-display", async () => {
        await initAgent({ apiKey: "sk-test-123", model: "openai/gpt-5.4" });

        const code = runPythonCalls[0];
        expect(code).toContain("async def live_app(actions");
        expect(code).toContain("_js_live_app");
        expect(code).toContain("_display_app_results");
        expect(code).toContain('_agent.fn(live_app, visibility="low")');
        expect(code).toContain("LAST COMMITTED");
    });

    it("wires up setQueryHandler", async () => {
        const { setQueryHandler } = await import("./pyodide.js");
        await initAgent({ apiKey: "sk-test-123", model: "openai/gpt-5.4" });

        expect(setQueryHandler).toHaveBeenCalled();
    });
});

describe("sendMessage", () => {
    it("escapes backslashes in user input", async () => {
        await sendMessage("path\\to\\file");

        const code = runPythonCalls[0];
        expect(code).toContain("path\\\\to\\\\file");
    });

    it("escapes double quotes in user input", async () => {
        await sendMessage('say "hello"');

        const code = runPythonCalls[0];
        expect(code).toContain('say \\"hello\\"');
    });

    it("escapes newlines in user input", async () => {
        await sendMessage("line1\nline2");

        const code = runPythonCalls[0];
        expect(code).toContain("line1\\nline2");
    });

    it("returns parsed structured response", async () => {
        const response = await sendMessage("hi");
        expect(response.result).toBe("mock response");
        expect(response.events).toHaveLength(1);
        expect(response.events[0].title).toBe("Test");
        expect(response.events[0].thinking).toBe("I thought");
        expect(response.events[0].code).toBe("print(1)");
        expect(response.events[0].terminal).toBeNull();
    });

    it("includes on_event and on_token callbacks in Python code", async () => {
        await sendMessage("hello");

        const code = runPythonCalls[0];
        expect(code).toContain("on_event=_on_event");
        expect(code).toContain("on_token=_on_token");
        expect(code).toContain("ActionEvent");
        expect(code).toContain("_post_token");
    });
});

describe("runQuery", () => {
    it("includes recursive serializer that handles DataFrames, Figures, dicts, and lists", async () => {
        await runQuery("x = 1", ["x"]).catch(() => {});

        const code = runPythonCalls[0];
        expect(code).toContain("def _serialize(val):");
        expect(code).toContain('"__type__": "dataframe"');
        expect(code).toContain('"__type__": "plotly"');
        // Recursion into dicts and lists
        expect(code).toContain("{k: _serialize(v) for k, v in val.items()}");
        expect(code).toContain("[_serialize(v) for v in val]");
    });

    it("uses _serialize for each result variable", async () => {
        await runQuery("x = 1", ["x"]).catch(() => {});

        const code = runPythonCalls[0];
        expect(code).toContain("_serialize(_query_state[_name])");
    });

});
