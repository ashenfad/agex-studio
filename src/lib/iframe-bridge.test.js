// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
    dispatchAction,
    handleControlMessage,
    installControlBridge,
    sendControl,
} from "./iframe-bridge.js";

// html2canvas pulls from a CDN in the real bridge; the screenshot tests
// would need a network or a full stub to exercise end-to-end. We test
// the error path (target missing) without invoking html2canvas.

beforeEach(() => {
    document.body.innerHTML = "";
});

describe("dispatchAction — click", () => {
    it("invokes click() on the matching element", async () => {
        document.body.innerHTML = '<button id="go">Go</button>';
        const spy = vi.spyOn(document.getElementById("go"), "click");
        const result = await dispatchAction(document, { click: "#go" });
        expect(spy).toHaveBeenCalledOnce();
        expect(result).toBeNull();
    });

    it("is a no-op when no element matches", async () => {
        const result = await dispatchAction(document, { click: "#nope" });
        expect(result).toBeNull();
    });
});

describe("dispatchAction — type", () => {
    it("sets value and dispatches input/change events", async () => {
        document.body.innerHTML = '<input id="x" />';
        const el = document.getElementById("x");
        const events = [];
        el.addEventListener("input", (e) => events.push(e.type));
        el.addEventListener("change", (e) => events.push(e.type));
        const result = await dispatchAction(document, { type: "#x", value: "hello" });
        expect(el.value).toBe("hello");
        expect(events).toEqual(["input", "change"]);
        expect(result).toBeNull();
    });

    it("defaults to empty string when value is omitted", async () => {
        document.body.innerHTML = '<input id="x" value="preset" />';
        await dispatchAction(document, { type: "#x" });
        expect(document.getElementById("x").value).toBe("");
    });
});

describe("dispatchAction — select", () => {
    it("sets value and dispatches change event", async () => {
        document.body.innerHTML = `
            <select id="s">
                <option value="a">A</option>
                <option value="b">B</option>
            </select>`;
        const el = document.getElementById("s");
        const events = [];
        el.addEventListener("change", (e) => events.push(e.type));
        await dispatchAction(document, { select: "#s", value: "b" });
        expect(el.value).toBe("b");
        expect(events).toEqual(["change"]);
    });
});

describe("dispatchAction — read", () => {
    it("returns textContent by default", async () => {
        document.body.innerHTML = '<span id="out">hello</span>';
        const result = await dispatchAction(document, { read: "#out" });
        expect(result).toEqual({
            type: "read",
            selector: "#out",
            value: "hello",
        });
    });

    it("returns the specified property", async () => {
        document.body.innerHTML = '<input id="x" value="v" />';
        const result = await dispatchAction(document, { read: "#x", prop: "value" });
        expect(result).toMatchObject({ selector: "#x", value: "v" });
    });

    it("returns null value when element is missing", async () => {
        const result = await dispatchAction(document, { read: "#nope" });
        expect(result).toMatchObject({ selector: "#nope", value: null });
    });

    it("stringifies non-string properties", async () => {
        document.body.innerHTML = '<div id="d" data-count="3">d</div>';
        const el = document.getElementById("d");
        el.customProp = 42;
        const result = await dispatchAction(document, { read: "#d", prop: "customProp" });
        expect(result.value).toBe("42");
    });
});

describe("dispatchAction — eval", () => {
    it("returns String(result) for successful eval", async () => {
        // Use a fake scope so we don't pollute global
        const scope = { eval: (expr) => eval(expr), x: 42 };
        const result = await dispatchAction(document, { eval: "2 + 3" }, scope);
        expect(result).toMatchObject({
            type: "eval",
            expr: "2 + 3",
            value: "5",
        });
    });

    it("returns null value for null/undefined results", async () => {
        const scope = { eval: (expr) => eval(expr) };
        const result = await dispatchAction(document, { eval: "undefined" }, scope);
        expect(result.value).toBeNull();
    });

    it("captures error on throw", async () => {
        const scope = { eval: (expr) => eval(expr) };
        const result = await dispatchAction(document, { eval: "throw new Error('boom')" }, scope);
        expect(result).toMatchObject({
            type: "eval",
            expr: "throw new Error('boom')",
            value: null,
        });
        expect(result.error).toContain("boom");
    });
});

describe("dispatchAction — screenshot error path", () => {
    it("returns a log-error entry when the target is missing", async () => {
        const result = await dispatchAction(document, { screenshot: "#gone" });
        expect(result).toMatchObject({
            type: "log",
            level: "error",
        });
        expect(result.message).toMatch(/Screenshot (target not found|failed)/);
    });
});

describe("dispatchAction — get-logs", () => {
    it("returns the window.__agex_logs array", async () => {
        const scope = { __agex_logs: [{ level: "log", message: "hi" }] };
        const result = await dispatchAction(document, { "get-logs": true }, scope);
        expect(result).toEqual({
            type: "logs",
            logs: [{ level: "log", message: "hi" }],
        });
    });

    it("returns empty array when no logs present", async () => {
        const scope = {};
        const result = await dispatchAction(document, { "get-logs": true }, scope);
        expect(result).toEqual({ type: "logs", logs: [] });
    });
});

describe("dispatchAction — unknown action", () => {
    it("throws for unrecognized action shape", async () => {
        await expect(
            dispatchAction(document, { nonsense: true })
        ).rejects.toThrow(/Unknown action/);
    });
});

describe("handleControlMessage", () => {
    it("returns null for non-control messages", async () => {
        const result = await handleControlMessage(document, { type: "something-else" });
        expect(result).toBeNull();
    });

    it("returns null for undefined messages", async () => {
        const result = await handleControlMessage(document, undefined);
        expect(result).toBeNull();
    });

    it("wraps successful dispatch in a response envelope", async () => {
        document.body.innerHTML = '<span id="s">hi</span>';
        const result = await handleControlMessage(document, {
            type: "agex-control",
            id: "abc",
            action: { read: "#s" },
        });
        expect(result).toEqual({
            type: "agex-control-result",
            id: "abc",
            data: { type: "read", selector: "#s", value: "hi" },
            error: null,
        });
    });

    it("wraps thrown dispatch errors in an error response", async () => {
        const result = await handleControlMessage(document, {
            type: "agex-control",
            id: "xyz",
            action: { unknown: true },
        });
        expect(result).toMatchObject({
            type: "agex-control-result",
            id: "xyz",
            data: null,
        });
        expect(result.error).toMatch(/Unknown action/);
    });

    it("preserves id for response correlation", async () => {
        document.body.innerHTML = '<button id="b">b</button>';
        const result = await handleControlMessage(document, {
            type: "agex-control",
            id: "unique-12345",
            action: { click: "#b" },
        });
        expect(result.id).toBe("unique-12345");
    });
});

describe("installControlBridge", () => {
    it("installs a message listener on the window", async () => {
        const win = {
            document,
            addEventListener: vi.fn(),
        };
        installControlBridge(win);
        expect(win.addEventListener).toHaveBeenCalledWith("message", expect.any(Function));
    });

    it("is idempotent — second call does not re-install", async () => {
        const win = {
            document,
            addEventListener: vi.fn(),
        };
        installControlBridge(win);
        installControlBridge(win);
        expect(win.addEventListener).toHaveBeenCalledOnce();
    });

    it("posts response back to event.source on matching message", async () => {
        document.body.innerHTML = '<span id="s">answer</span>';
        let handler = null;
        const win = {
            document,
            addEventListener: (_type, fn) => { handler = fn; },
        };
        installControlBridge(win);

        const source = { postMessage: vi.fn() };
        await handler({
            data: { type: "agex-control", id: "r1", action: { read: "#s" } },
            source,
        });

        expect(source.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "agex-control-result",
                id: "r1",
                data: { type: "read", selector: "#s", value: "answer" },
                error: null,
            }),
            "*",
        );
    });

    it("does not respond to non-control messages", async () => {
        let handler = null;
        const win = {
            document,
            addEventListener: (_type, fn) => { handler = fn; },
        };
        installControlBridge(win);
        const source = { postMessage: vi.fn() };
        await handler({ data: { type: "something-else" }, source });
        expect(source.postMessage).not.toHaveBeenCalled();
    });
});

// -----------------------------------------------------------------------
// Parent side: sendControl
// -----------------------------------------------------------------------

/**
 * Build a mock iframe whose postMessage drives a responseFn that decides
 * what response event to dispatch back on `window`. Used by the sendControl
 * tests to stub the iframe's side without installing a real bridge.
 */
function makeMockIframe(responseFn) {
    const iframe = {
        contentWindow: {
            postMessage: null,
        },
    };
    iframe.contentWindow.postMessage = (msg, _origin) => {
        queueMicrotask(() => {
            const responses = responseFn(msg);
            const list = Array.isArray(responses) ? responses : [responses];
            for (const { data, source } of list) {
                if (data === undefined) continue;
                window.dispatchEvent(new MessageEvent("message", {
                    data,
                    source: source || iframe.contentWindow,
                }));
            }
        });
    };
    return iframe;
}

describe("sendControl", () => {
    it("posts an agex-control message and resolves with response data", async () => {
        const posted = [];
        const iframe = makeMockIframe((msg) => {
            posted.push(msg);
            return {
                data: {
                    type: "agex-control-result",
                    id: msg.id,
                    data: { ok: true, echo: msg.action },
                    error: null,
                },
            };
        });

        const result = await sendControl(iframe, { click: "#x" });
        expect(posted).toHaveLength(1);
        expect(posted[0]).toMatchObject({
            type: "agex-control",
            action: { click: "#x" },
        });
        expect(posted[0].id).toMatch(/^ctrl-/);
        expect(result).toEqual({ ok: true, echo: { click: "#x" } });
    });

    it("rejects when response has an error field", async () => {
        const iframe = makeMockIframe((msg) => ({
            data: {
                type: "agex-control-result",
                id: msg.id,
                data: null,
                error: "boom",
            },
        }));

        await expect(sendControl(iframe, { click: "#x" }))
            .rejects.toThrow("boom");
    });

    it("ignores responses with a mismatched id", async () => {
        const iframe = makeMockIframe((msg) => [
            // Stale response from an earlier call
            {
                data: {
                    type: "agex-control-result",
                    id: "stale-id",
                    data: "stale",
                    error: null,
                },
            },
            // The real response
            {
                data: {
                    type: "agex-control-result",
                    id: msg.id,
                    data: "real",
                    error: null,
                },
            },
        ]);

        const result = await sendControl(iframe, { click: "#x" });
        expect(result).toBe("real");
    });

    it("ignores messages from other sources", async () => {
        const iframe = makeMockIframe((msg) => [
            // Response from a different source (different contentWindow)
            {
                data: {
                    type: "agex-control-result",
                    id: msg.id,
                    data: "wrong-source",
                    error: null,
                },
                source: { iAmNot: "the iframe" },
            },
            // Real response from the iframe
            {
                data: {
                    type: "agex-control-result",
                    id: msg.id,
                    data: "correct",
                    error: null,
                },
            },
        ]);

        const result = await sendControl(iframe, { click: "#x" });
        expect(result).toBe("correct");
    });

    it("ignores non-result messages during the wait", async () => {
        const iframe = makeMockIframe((msg) => [
            // Some other message type that shouldn't trip the handler
            {
                data: { type: "agex-query", id: "irrelevant" },
            },
            // The expected result
            {
                data: {
                    type: "agex-control-result",
                    id: msg.id,
                    data: "done",
                    error: null,
                },
            },
        ]);

        const result = await sendControl(iframe, { click: "#x" });
        expect(result).toBe("done");
    });

    it("allows concurrent calls with independent id tracking", async () => {
        // Each posted id gets its own response
        const iframe = makeMockIframe((msg) => ({
            data: {
                type: "agex-control-result",
                id: msg.id,
                data: `result-for-${msg.action.tag}`,
                error: null,
            },
        }));

        const [a, b] = await Promise.all([
            sendControl(iframe, { tag: "A" }),
            sendControl(iframe, { tag: "B" }),
        ]);
        expect(a).toBe("result-for-A");
        expect(b).toBe("result-for-B");
    });
});

// -----------------------------------------------------------------------
// End-to-end: sendControl → installControlBridge → response
// -----------------------------------------------------------------------

describe("sendControl + installControlBridge round-trip", () => {
    it("completes a read action end-to-end", async () => {
        document.body.innerHTML = '<span id="s">answer</span>';

        // Build an "iframe window" that installs the real bridge
        let bridgeHandler = null;
        const iframeWin = {
            document,
            addEventListener: (type, fn) => {
                if (type === "message") bridgeHandler = fn;
            },
        };
        installControlBridge(iframeWin);

        // When bridge calls event.source.postMessage, route it back to
        // the real window so sendControl's listener picks it up.
        const parentSourceProxy = {
            postMessage: (response, _origin) => {
                window.dispatchEvent(new MessageEvent("message", {
                    data: response,
                    source: iframe.contentWindow,
                }));
            },
        };

        // When parent posts to iframe, invoke the bridge directly
        const iframe = {
            contentWindow: {
                postMessage: (msg, _origin) => {
                    bridgeHandler({ data: msg, source: parentSourceProxy });
                },
            },
        };

        const result = await sendControl(iframe, { read: "#s" });
        expect(result).toEqual({
            type: "read",
            selector: "#s",
            value: "answer",
        });
    });

    it("completes a click action end-to-end (null result payload)", async () => {
        document.body.innerHTML = '<button id="b">b</button>';
        const clickSpy = vi.spyOn(document.getElementById("b"), "click");

        let bridgeHandler = null;
        const iframeWin = {
            document,
            addEventListener: (type, fn) => {
                if (type === "message") bridgeHandler = fn;
            },
        };
        installControlBridge(iframeWin);

        const parentSourceProxy = {
            postMessage: (response, _origin) => {
                window.dispatchEvent(new MessageEvent("message", {
                    data: response,
                    source: iframe.contentWindow,
                }));
            },
        };
        const iframe = {
            contentWindow: {
                postMessage: (msg, _origin) => {
                    bridgeHandler({ data: msg, source: parentSourceProxy });
                },
            },
        };

        const result = await sendControl(iframe, { click: "#b" });
        expect(clickSpy).toHaveBeenCalledOnce();
        expect(result).toBeNull();
    });
});
