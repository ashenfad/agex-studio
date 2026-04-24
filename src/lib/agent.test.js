import { describe, it, expect, vi, beforeEach } from "vitest";

// localStorage stub — agent.js reads debug flags at init time
vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
});

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

// Helper: initAgent runs basics + rich (two runPython calls). Most
// assertions don't care which phase a snippet lives in — they just
// want to know the substring appears somewhere in the setup code.
const allInitCode = () => runPythonCalls.join("\n---\n");

describe("initAgent", () => {
    it("runs basics + rich as two runPython calls", async () => {
        await initAgent({ apiKey: "sk-test-123", model: "openai/gpt-5.4" });
        expect(runPythonCalls).toHaveLength(2);
    });

    it("sends Python setup code with correct model and adapter (no api_key in scope)", async () => {
        await initAgent({ apiKey: "sk-test-123", model: "openai/gpt-5.4" });

        const code = allInitCode();
        expect(code).toContain('model="openai/gpt-5.4"');
        // Key never enters Python scope — adapter routes to main thread
        expect(code).not.toContain('api_key="sk-test-123"');
        expect(code).toContain('api_key=""');
        expect(code).toContain("JsBridgeAdapter");
        expect(code).toContain("PyfetchOpenAI");
        expect(code).toContain("clear_agent_registry()");
    });

    it("registers test_app function with auto-display", async () => {
        await initAgent({ apiKey: "sk-test-123", model: "openai/gpt-5.4" });

        const code = allInitCode();
        expect(code).toContain("async def test_app(actions");
        expect(code).toContain("_js_test_app");
        expect(code).toContain("_display_app_results");
        expect(code).toContain('_agent.fn(test_app, visibility="low")');
    });

    it("registers interactive app skill", async () => {
        await initAgent({ apiKey: "sk-test-123", model: "openai/gpt-5.4" });

        const code = allInitCode();
        expect(code).toContain("interactive-app.md");
        expect(code).toContain("_agent.skill");
    });

    // Gmail module disabled until app verification (restricted scopes)

    // Sheets/Docs REST API modules disabled — scopes removed for minimal demo

    it("no longer installs drive_fs live-mount code", async () => {
        await initAgent({ apiKey: "sk-test-123", model: "openai/gpt-5.4" });

        const code = allInitCode();
        // Drive is now a download-to-VFS flow, not a live /drive/ mount.
        expect(code).not.toContain("drive_fs.py");
        expect(code).not.toContain("GoogleDriveFS");
        expect(code).not.toContain("_update_drive_files");
        expect(code).not.toContain('mount("/drive"');
        // And no OAuth token in Python scope
        expect(code).not.toContain("_google_access_token");
        expect(code).not.toContain("google_token()");
    });

    it("registers drive skill and mentions /downloads in task primer", async () => {
        await initAgent({ apiKey: "sk-test-123", model: "openai/gpt-5.4" });

        const code = allInitCode();
        expect(code).toContain("drive.md");
        // Primer now references /downloads/ (where imported files land),
        // not /drive/ (the old live mount).
        expect(code).toContain("/downloads/");
        expect(code).toContain("cat /skills/drive/SKILL.md");
    });


    it("handles fresh ImageAction without _png_bytes in serializer", async () => {
        await initAgent({ apiKey: "sk-test-123", model: "openai/gpt-5.4" });

        const code = allInitCode();
        // Must use getattr for fresh ImageAction instances (not unpickled)
        expect(code).toContain('getattr(part, "_png_bytes", None)');
        expect(code).toContain("part.png_bytes()");
    });

    it("mentions test_app auto-display in task primer", async () => {
        await initAgent({ apiKey: "sk-test-123", model: "openai/gpt-5.4" });

        const code = allInitCode();
        expect(code).toContain("test_app()");
        expect(code).toContain("auto-displayed");
        expect(code).toContain("query() calls in the app work during testing");
        expect(code).toContain('actions=[{"click"');
    });

    it("defines _display_app_results helper", async () => {
        await initAgent({ apiKey: "sk-test-123", model: "openai/gpt-5.4" });

        const code = allInitCode();
        expect(code).toContain("def _display_app_results(");
        expect(code).toContain('[read ');
        expect(code).toContain('[eval error]');
        expect(code).toContain('[eval]');
    });

    it("strips screenshot base64 from returned results", async () => {
        // Regression: the screenshot is already delivered as an ImageAction
        // via the __AGEX_IMAGE__: marker.  Leaving raw base64 in the return
        // value would inflate the next prompt by a megabyte per screenshot
        // once the result lands in the event log.
        await initAgent({ apiKey: "sk-test-123", model: "openai/gpt-5.4" });

        const code = allInitCode();
        expect(code).toContain("def _strip_screenshot_payload(");
        // Both helpers must route through the stripper before returning.
        expect(code).toContain("return _strip_screenshot_payload(_results)");
        expect(code).toContain('"<shown via view_image>"');
    });

    it("registers live_app function with auto-display", async () => {
        await initAgent({ apiKey: "sk-test-123", model: "openai/gpt-5.4" });

        const code = allInitCode();
        expect(code).toContain("async def live_app(actions");
        expect(code).toContain("_js_live_app");
        expect(code).toContain("_display_app_results");
        expect(code).toContain('_agent.fn(live_app, visibility="low")');
        expect(code).toContain("LAST COMMITTED");
    });

    it("registers render_pdf with high visibility", async () => {
        await initAgent({ apiKey: "sk-test-123", model: "openai/gpt-5.4" });

        const code = allInitCode();
        expect(code).toContain("async def render_pdf(data");
        expect(code).toContain("_js_render_pdf");
        expect(code).toContain('_agent.fn(render_pdf, visibility="high")');
    });

    it("registers pdf_page_count with high visibility", async () => {
        await initAgent({ apiKey: "sk-test-123", model: "openai/gpt-5.4" });

        const code = allInitCode();
        expect(code).toContain("def pdf_page_count(data");
        expect(code).toContain('_agent.fn(pdf_page_count, visibility="high")');
    });

    it("mentions render_pdf in task primer", async () => {
        await initAgent({ apiKey: "sk-test-123", model: "openai/gpt-5.4" });

        const code = allInitCode();
        expect(code).toContain("render_pdf(");
        expect(code).toContain("pdf_page_count(");
    });

    it("wires up setQueryHandler", async () => {
        const { setQueryHandler } = await import("./pyodide.js");
        await initAgent({ apiKey: "sk-test-123", model: "openai/gpt-5.4" });

        expect(setQueryHandler).toHaveBeenCalled();
    });

    it("basics constructs Agent + LLM and defines event helpers", async () => {
        await initAgent({ apiKey: "sk-test-123", model: "openai/gpt-5.4" });
        const basics = runPythonCalls[0];
        // Wave-2 capabilities — agent constructed, history-readable.
        expect(basics).toContain("clear_agent_registry()");
        expect(basics).toContain("_agent = Agent(");
        expect(basics).toContain("_serialize_chapter_events");
        // No module/skill/task registration in basics.
        expect(basics).not.toContain("register_pandas");
        expect(basics).not.toContain("@_agent.task");
    });

    it("rich registers modules + skills + chat task", async () => {
        await initAgent({ apiKey: "sk-test-123", model: "openai/gpt-5.4" });
        const rich = runPythonCalls[1];
        expect(rich).toContain("register_pandas(_agent)");
        expect(rich).toContain("register_plotly(_agent)");
        expect(rich).toContain("@_agent.task(primer=_TASK_PRIMER)");
        // Reuses _agent created in basics; doesn't reconstruct.
        expect(rich).not.toContain("_agent = Agent(");
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
