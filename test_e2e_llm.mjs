/**
 * End-to-end manual test: PyfetchOpenAI client in Pyodide.
 *
 * Installs the agex stack into Pyodide (Node.js), then runs a real
 * streaming completion against OpenRouter to verify the full pipeline:
 *   pyfetch → SSE parsing → tokenize_xml_stream → TokenChunk
 *
 * Requires:
 *   OPENROUTER_API_KEY  — set in environment
 *
 * Usage:
 *   OPENROUTER_API_KEY=... node test_e2e_llm.mjs
 */

import { loadPyodide } from "pyodide";

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_KEY) {
    console.error("ERROR: OPENROUTER_API_KEY not set.");
    process.exit(1);
}

function log(msg, level = "info") {
    const prefix = level === "ok" ? "  ✓" : level === "error" ? "  ✗" : level === "warn" ? "  ⚠" : "  ";
    console.log(`${prefix} ${msg}`);
}

async function installPkg(pyodide, name, deps = true) {
    await pyodide.runPythonAsync(`
import micropip
await micropip.install("${name}", deps=${deps ? "True" : "False"})
    `);
    log(`installed ${name} from PyPI`, "ok");
}

async function main() {
    console.log("Loading Pyodide...");
    const pyodide = await loadPyodide();
    console.log("Pyodide loaded.\n");

    await pyodide.loadPackage("micropip");

    // --- Install dependencies ---
    console.log("--- Installing packages ---");

    for (const dep of ["kvgit", "monkeyfs", "termish", "pydantic", "reprobate", "sandtrap", "tiktoken", "diskcache", "pygments"]) {
        await installPkg(pyodide, dep);
    }

    // Install agex (deps=False since we installed them above)
    await installPkg(pyodide, "agex", false);

    // Verify import
    await pyodide.runPythonAsync("import agex");
    log("import agex", "ok");

    await pyodide.runPythonAsync("from agex.llm.pyfetch_openai import PyfetchOpenAI");
    log("import PyfetchOpenAI", "ok");

    // --- Test 1: Non-streaming completion ---
    console.log("\n--- Test 1: acomplete (non-streaming) ---");

    try {
        const result = await pyodide.runPythonAsync(`
from agex.llm.pyfetch_openai import PyfetchOpenAI
from agex.agent.events import TaskStartEvent

client = PyfetchOpenAI(
    model="openai/gpt-4.1-nano",
    api_key="${OPENROUTER_KEY}",
)

events = [TaskStartEvent(
    agent_name="test",
    task_name="test",
    inputs={},
    message="Say exactly: Hello from Pyodide",
)]

response = await client.acomplete(
    system="You are a helpful assistant. Respond with a short title and brief thinking.",
    events=events,
)
f"title={response.title!r} thinking_len={len(response.thinking)} tokens_in={response.input_tokens} tokens_out={response.output_tokens}"
        `);
        log(`acomplete response: ${result}`, "ok");
    } catch (e) {
        const lines = e.message.split("\n").filter(l => l.trim());
        log(`acomplete FAILED: ${lines[lines.length - 1]}`, "error");
    }

    // --- Test 2: Streaming completion ---
    console.log("\n--- Test 2: acomplete_stream (streaming) ---");

    try {
        const result = await pyodide.runPythonAsync(`
from agex.llm.pyfetch_openai import PyfetchOpenAI
from agex.agent.events import TaskStartEvent

client = PyfetchOpenAI(
    model="openai/gpt-4.1-nano",
    api_key="${OPENROUTER_KEY}",
)

events = [TaskStartEvent(
    agent_name="test",
    task_name="test",
    inputs={},
    message="Write a one-line python hello world",
)]

chunks = []
async for token in client.acomplete_stream(
    system="You are a helpful assistant.",
    events=events,
):
    chunks.append(f"{token.type}:{token.content[:30]!r}" if token.content else f"{token.type}:done={token.done}")

f"received {len(chunks)} chunks, types: {set(c.split(':')[0] for c in chunks)}"
        `);
        log(`streaming: ${result}`, "ok");
    } catch (e) {
        const lines = e.message.split("\n").filter(l => l.trim());
        log(`streaming FAILED: ${lines[lines.length - 1]}`, "error");
    }

    // --- Test 3: summarize ---
    console.log("\n--- Test 3: summarize ---");

    try {
        const result = await pyodide.runPythonAsync(`
from agex.llm.pyfetch_openai import PyfetchOpenAI

client = PyfetchOpenAI(
    model="openai/gpt-4.1-nano",
    api_key="${OPENROUTER_KEY}",
)

summary = await client.summarize(
    system="Summarize in exactly 5 words.",
    content="The quick brown fox jumps over the lazy dog.",
)
summary[:100]
        `);
        log(`summarize: ${result}`, "ok");
    } catch (e) {
        const lines = e.message.split("\n").filter(l => l.trim());
        log(`summarize FAILED: ${lines[lines.length - 1]}`, "error");
    }

    // --- Test 4: Streaming with ToolUseWireFormat ---
    console.log("\n--- Test 4: acomplete_stream with ToolUseWireFormat ---");

    try {
        const result = await pyodide.runPythonAsync(`
from agex.llm.pyfetch_openai import PyfetchOpenAI
from agex.llm.formats import ToolUseWireFormat
from agex.llm.core import ResponseBuilder
from agex.agent.events import TaskStartEvent

client = PyfetchOpenAI(
    model="openai/gpt-4.1-nano",
    api_key="${OPENROUTER_KEY}",
    wire_format=ToolUseWireFormat(),
)

events = [TaskStartEvent(
    agent_name="test",
    task_name="test",
    inputs={},
    message="Write a one-line python hello world and call task_success with the printed string.",
)]

builder = ResponseBuilder(agent_name="test")
async for token in client.acomplete_stream(
    system="You are a helpful coding assistant.",
    events=events,
):
    builder.process_token(token)

resp = builder.build()
f"code_len={len(resp.code or '')} title={resp.title!r} tokens_in={resp.input_tokens} tokens_out={resp.output_tokens}"
        `);
        log(`tool-use streaming: ${result}`, "ok");
    } catch (e) {
        const lines = e.message.split("\n").filter(l => l.trim());
        log(`tool-use streaming FAILED: ${lines[lines.length - 1]}`, "error");
    }

    // --- Test 5: Full agent loop (funcy_async) ---
    console.log("\n--- Test 5: full agent loop ---");

    try {
        const result = await pyodide.runPythonAsync(`
import math
from typing import Callable
from agex import Agent, connect_llm, connect_state, clear_agent_registry

# Clear any prior registrations
clear_agent_registry()

llm = connect_llm(
    provider="pyfetch_openai",
    model="openai/gpt-4.1-nano",
    api_key="${OPENROUTER_KEY}",
)

funcy_agent = Agent(
    name="funcy_pyodide",
    primer="You are great at providing custom functions to the user.",
    llm=llm,
    state=connect_state(type="versioned", storage="memory"),
)
funcy_agent.module(math, visibility="low")

@funcy_agent.task(primer="Build a callable function from a text prompt.")
async def fn_builder(prompt: str) -> Callable:
    ...

fn = await fn_builder("a function that returns True if a number is prime, False otherwise")

# Verify the returned function works
results = {n: fn(n) for n in [2, 3, 4, 5, 17, 20]}
f"fn returned, results={results}"
        `);
        log(`agent loop: ${result}`, "ok");
    } catch (e) {
        const lines = e.message.split("\n").filter(l => l.trim());
        const last = lines[lines.length - 1] || e.message;
        log(`agent loop FAILED: ${last}`, "error");
        // Print more context for debugging
        const relevant = lines.slice(-5).join("\n    ");
        if (relevant !== last) console.log(`    ${relevant}`);
    }

    console.log("\n=== DONE ===");
}

main().catch(e => {
    console.error("Fatal:", e);
    process.exit(1);
});
