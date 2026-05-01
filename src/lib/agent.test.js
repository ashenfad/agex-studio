import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Convenience: read an extracted Python module once.  Some assertions
// originally targeted the JS-emitted heredoc and now target the .py
// file directly because that's where the code moved.
const readPy = (name) =>
    readFileSync(
        resolve(__dirname, `../../public/python/${name}`),
        "utf-8",
    );

const readPrimer = (name) =>
    readFileSync(
        resolve(__dirname, `../../public/primers/${name}`),
        "utf-8",
    );

const readSkill = (name) =>
    readFileSync(
        resolve(__dirname, `../../public/skills/${name}`),
        "utf-8",
    );

// localStorage stub — agent.js reads debug flags at init time
vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
});

// Mock runPython — capture calls and return a canned JSON response.
// The events array uses the post-Wave-2 emission-list shape that the
// real Python serializer (event_serialization._synthesize_action) ships.
const runPythonCalls = [];
const mockResponse = JSON.stringify({
    result: "mock response",
    events: [
        {
            type: "action",
            title: "Test",
            report: "",
            emissions: [
                { kind: "thinking", idx: 0, text: "I thought", redacted: false },
                { kind: "python", idx: 1, code: "print(1)", title: "Test", thinking: "" },
            ],
            input_tokens: 100,
            output_tokens: 50,
        },
    ],
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

    it("registers test_app function with auto-display", () => {
        // test_app definition + registration moved to agent_helpers.py
        const py = readPy("agent_helpers.py");
        expect(py).toContain("async def test_app(");
        expect(py).toContain("fresh: bool = False");
        expect(py).toContain("_js_test_app");
        expect(py).toContain("_display_app_results");
        expect(py).toContain('agent.fn(test_app, visibility="low")');
    });

    it("registers interactive app skill", () => {
        // Static-skill list + agent.skill(...) calls live in agent_modules.py.
        const py = readPy("agent_modules.py");
        expect(py).toContain("interactive-app.md");
        expect(py).toContain("agent.skill");
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

    it("registers drive skill and mentions /downloads in task primer", () => {
        // Skill registration moved to agent_modules.py; primer text
        // moved to public/primers/chat_task.md.
        expect(readPy("agent_modules.py")).toContain("drive.md");
        // Primer now references /downloads/ (where imported files land),
        // not /drive/ (the old live mount).
        const primer = readPrimer("chat_task.md");
        expect(primer).toContain("/downloads/");
        expect(primer).toContain("cat /skills/drive/SKILL.md");
    });


    it("handles fresh ImageAction without _png_bytes in serializer", () => {
        // Serializer logic lives in public/python/event_serialization.py
        // (loaded into pyodide at init-time via _install_module).  The
        // assertion targets that file directly now that the heredoc
        // version is gone from agent.js.
        const py = readFileSync(
            resolve(__dirname, "../../public/python/event_serialization.py"),
            "utf-8",
        );
        // Must use getattr for fresh ImageAction instances (not unpickled)
        expect(py).toContain('getattr(part, "_png_bytes", None)');
        expect(py).toContain("part.png_bytes()");
    });

    it("documents test_app() actions and auto-display", () => {
        // Detailed test_app/live_app/actions docs live in the
        // interactive-app skill, not the primer (which just points to
        // the skill).  Verify the skill still covers the load-bearing
        // pieces.
        const skill = readSkill("interactive-app.md");
        expect(skill).toContain("test_app()");
        expect(skill).toContain('actions=[');
        expect(skill).toContain("read");
        expect(skill).toContain("eval");

        // Primer should still point at the skill.
        const primer = readPrimer("chat_task.md");
        expect(primer).toContain("/skills/interactive-app/SKILL.md");
    });

    it("defines _display_app_results helper", () => {
        const py = readPy("agent_helpers.py");
        expect(py).toContain("def _display_app_results(");
        expect(py).toContain('[read ');
        expect(py).toContain('[eval error]');
        expect(py).toContain('[eval]');
    });

    it("strips screenshot base64 from returned results", () => {
        // Regression: the screenshot is already delivered as an ImageAction
        // via the __AGEX_IMAGE__: marker.  Leaving raw base64 in the return
        // value would inflate the next prompt by a megabyte per screenshot
        // once the result lands in the event log.
        const py = readPy("agent_helpers.py");
        expect(py).toContain("def _strip_screenshot_payload(");
        // Both helpers must route through the stripper before returning.
        expect(py).toContain("return _strip_screenshot_payload(results)");
        expect(py).toContain('"<shown via view_image>"');
    });

    it("registers live_app function with auto-display", () => {
        const py = readPy("agent_helpers.py");
        expect(py).toContain("async def live_app(actions");
        expect(py).toContain("_js_live_app");
        expect(py).toContain("_display_app_results");
        expect(py).toContain('agent.fn(live_app, visibility="low")');
        expect(py).toContain("LAST COMMITTED");
    });

    it("registers render_pdf with high visibility", () => {
        const py = readPy("agent_helpers.py");
        expect(py).toContain("async def render_pdf(data");
        expect(py).toContain("_js_render_pdf");
        expect(py).toContain('agent.fn(render_pdf, visibility="high")');
    });

    it("registers pdf_page_count with high visibility", () => {
        const py = readPy("agent_helpers.py");
        expect(py).toContain("def pdf_page_count(data");
        expect(py).toContain('agent.fn(pdf_page_count, visibility="high")');
    });

    it("mentions render_pdf in task primer", () => {
        const primer = readPrimer("chat_task.md");
        expect(primer).toContain("render_pdf(");
        expect(primer).toContain("pdf_page_count(");
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
        // Library registrations are delegated to agent_modules.register_all;
        // the rich heredoc just calls into it.
        expect(rich).toContain("agent_modules.register_all(_agent)");
        expect(rich).toContain("@_agent.task(primer=_TASK_PRIMER)");
        // Reuses _agent created in basics; doesn't reconstruct.
        expect(rich).not.toContain("_agent = Agent(");

        // The actual register_pandas / register_plotly calls live in
        // agent_modules.py — verify they're still wired up there.
        const py = readPy("agent_modules.py");
        expect(py).toContain("register_pandas(agent)");
        expect(py).toContain("register_plotly(agent)");
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
        // Action events ship as the emission-list shape: title +
        // emissions[] + token counts.  Per-emission code / thinking
        // live inside the emissions array, not as flat fields.
        expect(response.events[0].type).toBe("action");
        expect(response.events[0].title).toBe("Test");
        expect(response.events[0].emissions).toHaveLength(2);
        expect(response.events[0].emissions[0].kind).toBe("thinking");
        expect(response.events[0].emissions[0].text).toBe("I thought");
        expect(response.events[0].emissions[1].kind).toBe("python");
        expect(response.events[0].emissions[1].code).toBe("print(1)");
    });

    it("delegates streaming setup to streaming.run_chat_task", async () => {
        // The on_event / on_token wiring lives in streaming.py now;
        // the JS heredoc is just a thin wrapper that imports the
        // module and awaits the runner.
        await sendMessage("hello");
        const code = runPythonCalls[0];
        expect(code).toContain("import streaming as _streaming");
        expect(code).toContain("await _streaming.run_chat_task(chat, _agent");

        // Verify the callbacks + bridge surface still live in the
        // module — the actual streaming invariants we care about.
        const py = readPy("streaming.py");
        expect(py).toContain("on_event=on_event");
        expect(py).toContain("on_token=on_token");
        expect(py).toContain("ActionEvent");
        expect(py).toContain("post_token");
        // emission_index threading is the load-bearing detail — every
        // synthesized token for emission types must carry it.
        expect(py).toContain('"emission_index": eidx');
    });
});

describe("runQuery", () => {
    // The runQuery body now lives in public/python/queries.py; the JS
    // heredoc is just a thin wrapper.  Substring assertions about the
    // serializer + result-var collection target the .py file.

    it("includes recursive serializer that handles DataFrames, Figures, dicts, and lists", () => {
        const py = readPy("queries.py");
        expect(py).toContain("def _serialize(val):");
        expect(py).toContain('"__type__": "dataframe"');
        expect(py).toContain('"__type__": "plotly"');
        // Recursion into dicts and lists
        expect(py).toContain("{k: _serialize(v) for k, v in val.items()}");
        expect(py).toContain("[_serialize(v) for v in val]");
    });

    it("uses _serialize for each result variable", () => {
        const py = readPy("queries.py");
        // Result vars come out of the post-exec namespace returned by
        // aexecute_sandboxed (agex >= 0.12.0), not out of state.
        expect(py).toContain("_serialize(ns[name])");
    });

    it("JS wrapper passes code + result_vars into queries.run_query", async () => {
        await runQuery("x = 1", ["x"]).catch(() => {});
        const code = runPythonCalls[0];
        expect(code).toContain("await _queries.run_query(_agent");
        expect(code).toContain('"x = 1"');
        expect(code).toContain('["x"]');
    });
});

// Reasoning-effort kwarg matrix.
//
// _reasoningKwargLine picks the LLM client constructor kwarg shape
// based on the (provider, model_prefix, toolUseWireFormat) triple.
// The shapes are NOT interchangeable — OpenRouter's unified
// `reasoning` config silently disables reasoning on the Anthropic
// route when given an effort value, and direct-Anthropic uses a
// different field name entirely.  These tests pin the matrix down so
// a future "let's just unify these" refactor fails loudly.
describe("reasoning kwarg matrix", () => {
    const baseSettings = {
        apiKey: "sk-test-123",
        toolUseWireFormat: true,
        reasoningEffort: "medium",
    };

    it("Anthropic direct → thinking={type, budget_tokens}", async () => {
        await initAgent({
            ...baseSettings,
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            reasoningEffort: "high",
        });
        const code = allInitCode();
        expect(code).toContain('thinking={"type": "enabled", "budget_tokens": 4096}');
        expect(code).not.toContain('reasoning={');
    });

    it("OpenRouter → Anthropic backend → reasoning={enabled, max_tokens}", async () => {
        await initAgent({
            ...baseSettings,
            model: "anthropic/claude-sonnet-4-6",
            reasoningEffort: "medium",
        });
        const code = allInitCode();
        expect(code).toContain('reasoning={"enabled": True, "max_tokens": 2048}');
        // Must NOT use effort on the Anthropic route — OpenRouter
        // silently disables reasoning if you pass effort here.
        expect(code).not.toContain('"effort":');
        expect(code).not.toContain('thinking={');
    });

    it("OpenRouter → Google backend → reasoning={enabled, max_tokens}", async () => {
        await initAgent({
            ...baseSettings,
            model: "google/gemini-2.5-pro",
            reasoningEffort: "low",
        });
        const code = allInitCode();
        expect(code).toContain('reasoning={"enabled": True, "max_tokens": 1024}');
        expect(code).not.toContain('"effort":');
    });

    it("OpenRouter → OpenAI backend → reasoning={enabled, effort}", async () => {
        await initAgent({
            ...baseSettings,
            model: "openai/gpt-5.4",
            reasoningEffort: "medium",
        });
        const code = allInitCode();
        expect(code).toContain('reasoning={"enabled": True, "effort": "medium"}');
        // Must NOT use max_tokens on the OpenAI route.
        expect(code).not.toContain('"max_tokens":');
        expect(code).not.toContain('thinking={');
    });

    it("toolUseWireFormat=false → no reasoning kwarg at all", async () => {
        await initAgent({
            ...baseSettings,
            toolUseWireFormat: false,
            model: "anthropic/claude-sonnet-4-6",
            reasoningEffort: "high",
        });
        const code = allInitCode();
        // Both shapes absent — narration-in-schema path is used instead.
        expect(code).not.toContain('reasoning={');
        expect(code).not.toContain('thinking={');
        // And the wire format opt-out IS present.
        expect(code).toContain("ToolUseWireFormat(native_thinking=False)");
    });

    it("budget mapping: low=1024, medium=2048, high=4096", async () => {
        await initAgent({
            ...baseSettings,
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            reasoningEffort: "low",
        });
        expect(allInitCode()).toContain('"budget_tokens": 1024');

        runPythonCalls.length = 0;
        await initAgent({
            ...baseSettings,
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            reasoningEffort: "medium",
        });
        expect(allInitCode()).toContain('"budget_tokens": 2048');

        runPythonCalls.length = 0;
        await initAgent({
            ...baseSettings,
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            reasoningEffort: "high",
        });
        expect(allInitCode()).toContain('"budget_tokens": 4096');
    });
});
