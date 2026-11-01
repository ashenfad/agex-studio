/**
 * A model service for the tests, in the OpenAI-compatible shape a custom
 * endpoint speaks: its first reply calls `run_ts`, and once the tool's
 * result is in, it says what the code printed. So a turn on it runs the
 * person's-model path end to end, the tool call included, with no key.
 */

import { createServer } from "node:http";

/** Start it; its base URL (`…/v1`), the requests it got, and `close`. */
export async function modelServer() {
    /** @type {any[]} */
    const requests = [];
    const server = createServer((req, res) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
        if (req.method === "OPTIONS") return void res.end();
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
            const request = JSON.parse(body);
            requests.push(request);
            const last = request.messages.at(-1);
            res.setHeader("Content-Type", "text/event-stream");
            const chunk = (delta, finish = null) =>
                res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: request.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
            if (last.role === "tool") {
                const printed = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
                chunk({ role: "assistant", content: `The code printed ${printed.trim()}.` });
                chunk({}, "stop");
            } else {
                chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "run_ts", arguments: JSON.stringify({ code: "console.log(6 * 7)" }) } }] });
                chunk({}, "tool_calls");
            }
            res.end("data: [DONE]\n\n");
        });
    });
    await new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(undefined)));
    const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
    return { url: `http://127.0.0.1:${port}/v1`, requests, close: () => new Promise((ok) => server.close(ok)) };
}
