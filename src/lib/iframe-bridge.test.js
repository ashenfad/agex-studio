// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
    actionWaitMs,
    dispatchAction,
    handleControlMessage,
    installControlBridge,
    waitForFrame,
} from "./iframe-bridge.js";

// html2canvas pulls from a CDN in the real bridge; the screenshot tests
// would need a network or a full stub to exercise end-to-end. We test
// the error path (target missing) without invoking html2canvas.

beforeEach(() => {
    document.body.innerHTML = "";
});

describe("dispatchAction — click", () => {
    it("dispatches a mouse's events at the element's center, ending in one click", async () => {
        document.body.innerHTML = '<button id="go">Go</button>';
        const el = document.getElementById("go");
        el.getBoundingClientRect = () => /** @type {any} */ ({ left: 10, top: 20, width: 100, height: 40 });
        const seen = [];
        for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
            el.addEventListener(type, (e) => seen.push([e.type, e.clientX, e.clientY, e.bubbles, e.cancelable]));
        }
        const result = await dispatchAction(document, { click: "#go" });
        expect(result).toBeNull();
        expect(seen).toEqual([
            ["pointerdown", 60, 40, true, true],
            ["mousedown", 60, 40, true, true],
            ["pointerup", 60, 40, true, true],
            ["mouseup", 60, 40, true, true],
            ["click", 60, 40, true, true],
        ]);
    });

    it("clicks an SVG element, which has no click() of its own", async () => {
        document.body.innerHTML = '<svg><g id="perk"><rect width="10" height="10"/></g></svg>';
        const clicked = vi.fn();
        document.body.addEventListener("click", (e) => clicked(/** @type {Element} */ (e.target).id));
        await dispatchAction(document, { click: "#perk" });
        expect(clicked).toHaveBeenCalledWith("perk");
    });

    it("holds back the mouse events after a cancelled pointerdown, and still clicks", async () => {
        document.body.innerHTML = '<div id="d"></div>';
        const el = document.getElementById("d");
        const seen = [];
        el.addEventListener("pointerdown", (e) => e.preventDefault());
        for (const type of ["mousedown", "mouseup", "click"]) el.addEventListener(type, (e) => seen.push(e.type));
        await dispatchAction(document, { click: "#d" });
        expect(seen).toEqual(["click"]);
    });

    it("waits for a target that appears after the action starts", async () => {
        const clicked = vi.fn();
        setTimeout(() => {
            document.body.innerHTML = '<button id="later">x</button>';
            document.getElementById("later").addEventListener("click", clicked);
        }, 120);
        await dispatchAction(document, { click: "#later" });
        expect(clicked).toHaveBeenCalledOnce();
    });

    it("fails with an ActionError when nothing matches within its timeout", async () => {
        const start = Date.now();
        await expect(dispatchAction(document, { click: "#nope", timeout: 100 })).rejects.toThrow(
            /^ActionError: click "#nope": nothing matches it \(waited 100ms\)/,
        );
        expect(Date.now() - start).toBeGreaterThanOrEqual(100);
    });

    it("fails, without clicking, on a disabled element", async () => {
        document.body.innerHTML = '<button id="b" disabled>x</button>';
        const clicked = vi.fn();
        document.getElementById("b").addEventListener("click", clicked);
        await expect(dispatchAction(document, { click: "#b" })).rejects.toThrow(
            /^ActionError: click "#b": the element is disabled/,
        );
        expect(clicked).not.toHaveBeenCalled();
    });
});

describe("dispatchAction — how long an action waits", () => {
    it("is a second for a target, five for waitFor and waitUntil, the action's own timeout, capped", () => {
        expect(actionWaitMs({ click: "#a" })).toBe(1000);
        expect(actionWaitMs({ type: "#a" })).toBe(1000);
        expect(actionWaitMs({ select: "#a", timeout: 0 })).toBe(0);
        expect(actionWaitMs({ waitFor: "#a" })).toBe(5000);
        expect(actionWaitMs({ waitUntil: "x", timeout: 250 })).toBe(250);
        expect(actionWaitMs({ waitFor: "#a", timeout: 10_000_000 })).toBe(60_000);
        expect(actionWaitMs({ waitFor: "#a", timeout: "soon" })).toBe(5000);
        expect(actionWaitMs({ read: "#a", timeout: 9000 })).toBe(0);
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

    it("fails on a missing or disabled input", async () => {
        await expect(dispatchAction(document, { type: "#x", value: "a", timeout: 0 })).rejects.toThrow(
            /^ActionError: type "#x": nothing matches it/,
        );
        document.body.innerHTML = '<input id="x" disabled />';
        await expect(dispatchAction(document, { type: "#x", value: "a" })).rejects.toThrow(/disabled/);
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

    it("fails on a value none of its options has, naming the values it has", async () => {
        document.body.innerHTML = '<select id="s"><option value="a">A</option><option value="b">B</option></select>';
        const events = [];
        document.getElementById("s").addEventListener("change", (e) => events.push(e.type));
        await expect(dispatchAction(document, { select: "#s", value: "B" })).rejects.toThrow(
            /^ActionError: select "#s": no option has the value "B" \(its values: "a", "b"\)/,
        );
        expect(events).toEqual([]);
    });
});

describe("dispatchAction — waitFor and waitUntil", () => {
    it("waitFor settles once the selector matches", async () => {
        setTimeout(() => (document.body.innerHTML = '<p id="done">ok</p>'), 120);
        expect(await dispatchAction(document, { waitFor: "#done" })).toBeNull();
    });

    it("waitFor fails, naming what it waited for, when it runs out", async () => {
        await expect(dispatchAction(document, { waitFor: "#never", timeout: 100 })).rejects.toThrow(
            /^ActionError: waitFor "#never": still nothing matches it after 100ms/,
        );
    });

    it("waitUntil settles once the expression is true, a throw counting as not yet, a Promise awaited", async () => {
        const scope = { eval: (expr) => eval(expr) };
        const g = /** @type {any} */ (globalThis);
        setTimeout(() => (g.__later = { n: 3 }), 120);
        try {
            // reads a property of something that isn't there yet: throws until it is
            expect(await dispatchAction(document, { waitUntil: "Promise.resolve(__later.n === 3)" }, scope)).toBeNull();
        } finally {
            delete g.__later;
        }
    });

    it("waitUntil fails when it runs out, with what it last threw", async () => {
        const scope = { eval: (expr) => eval(expr) };
        await expect(dispatchAction(document, { waitUntil: "false", timeout: 60 }, scope)).rejects.toThrow(
            /^ActionError: waitUntil false: still not true after 60ms$/,
        );
        await expect(dispatchAction(document, { waitUntil: "notYet.ready", timeout: 60 }, scope)).rejects.toThrow(
            /still not true after 60ms; it last threw ReferenceError: notYet is not defined/,
        );
    });

    it("waitUntil holds a Promise to the timeout: late or never settling, it fails on time", async () => {
        const scope = { eval: (expr) => eval(expr) };
        for (const expr of ["new Promise((r) => setTimeout(() => r(true), 400))", "new Promise(() => {})"]) {
            const start = Date.now();
            await expect(dispatchAction(document, { waitUntil: expr, timeout: 80 }, scope)).rejects.toThrow(
                /still not true after 80ms$/,
            );
            expect(Date.now() - start).toBeLessThan(300);
        }
    });
});

describe("dispatchAction — read", () => {
    it("returns innerText by default, a line between blocks", async () => {
        document.body.innerHTML = '<div id="out"><p>into the dark</p><p>3 idle settlers</p></div>';
        const result = await dispatchAction(document, { read: "#out" });
        expect(result).toEqual({
            type: "read",
            selector: "#out",
            value: "into the dark\n3 idle settlers",
        });
        const raw = await dispatchAction(document, { read: "#out", prop: "textContent" });
        expect(raw.value).toBe("into the dark3 idle settlers");
    });

    it("reads an SVG element's text, which has no innerText", async () => {
        document.body.innerHTML = '<svg><text id="t">42 embers</text></svg>';
        const t = /** @type {any} */ (document.getElementById("t"));
        if (t.innerText !== undefined) Object.defineProperty(t, "innerText", { value: undefined });
        const result = await dispatchAction(document, { read: "#t" });
        expect(result.value).toBe("42 embers");
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

    it("caps oversized read values with a truncation notice", async () => {
        // Simulate an agent reading `outerHTML` of a giant subtree
        // (or `<style>` body, or a serialized JSON dump pasted into
        // a textarea). Without the cap the raw value would flow
        // back into testApp's return and from there into the
        // agent's next-turn context.
        const big = "x".repeat(80_000);
        document.body.innerHTML = `<div id="big">${big}</div>`;
        const result = await dispatchAction(document, {
            read: "#big",
            prop: "textContent",
        });
        expect(result.value.length).toBeLessThan(60_000);
        expect(result.value).toMatch(/^\[truncated: read value was 80000 bytes/);
        // Truncated payload should still carry the head of the
        // original so the agent can recognize it.
        expect(result.value).toContain("xxxxx");
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

    it("carries a label, which names it in an error in place of its code", async () => {
        const scope = { eval: (expr) => eval(expr) };
        expect(await dispatchAction(document, { eval: "1 + 1", label: "sum" }, scope)).toEqual({
            type: "eval", expr: "1 + 1", label: "sum", value: "2",
        });
        const failed = await dispatchAction(document, { eval: "boom()", label: "setup" }, scope);
        expect(failed.error).toMatch(/^ReferenceError: boom is not defined \(in: setup\)$/);
    });

    it("returns null value for null/undefined results", async () => {
        const scope = { eval: (expr) => eval(expr) };
        const result = await dispatchAction(document, { eval: "undefined" }, scope);
        expect(result.value).toBeNull();
    });

    it("captures error on throw with name + expression text", async () => {
        const scope = { eval: (expr) => eval(expr) };
        const result = await dispatchAction(document, { eval: "throw new Error('boom')" }, scope);
        expect(result).toMatchObject({
            type: "eval",
            expr: "throw new Error('boom')",
            value: null,
        });
        // Error message includes the original message AND the
        // expression text so agents looking at just the error
        // string can correlate it to which eval threw.
        expect(result.error).toContain("Error: boom");
        expect(result.error).toContain("(in: throw new Error('boom'))");
    });

    it("preserves error name for typed errors (ReferenceError, TypeError, ...)", async () => {
        const scope = { eval: (expr) => eval(expr) };
        const result = await dispatchAction(
            document,
            { eval: "undefinedThing.foo" },
            scope,
        );
        expect(result.type).toBe("eval");
        // ReferenceError, TypeError, etc. — whichever the browser
        // raises — keeps its class name in the message so the agent
        // can pattern-match on it.
        expect(result.error).toMatch(/^(ReferenceError|TypeError):/);
        expect(result.error).toContain("(in: undefinedThing.foo)");
    });

    it("awaits Promise results and returns the resolved value", async () => {
        // Without auto-await, agents fall back to a fragile pattern:
        // stash results on globals, sleep, read by separate eval.
        // With it, `await testApp([{ eval: 'Plotly.toImage(...)' }])`
        // Just Works. Expression is self-contained — the scope-passed
        // helper-fn approach wouldn't be visible to the inner eval
        // (eval sees lexical scope, not the scope object's props).
        const scope = { eval: (expr) => eval(expr) };
        const result = await dispatchAction(
            document,
            {
                eval: "new Promise((resolve) => setTimeout(() => resolve(42), 5))",
            },
            scope,
        );
        expect(result.type).toBe("eval");
        // The bridge sends an eval's value JSON-encoded: the text the
        // agent reads.
        expect(result.value).toBe("42");
        expect(result.error).toBeUndefined();
    });

    it("awaits Promise.all and returns the resolved array", async () => {
        // Parallel pattern: `Promise.all([fn(), fn(), fn()])` runs
        // multiple async operations concurrently and returns one
        // array. This is how the agent should chain parallel
        // Plotly.toImage / fetch / etc. calls — no globals,
        // no `{wait: N}` guess.
        const scope = { eval: (expr) => eval(expr) };
        const result = await dispatchAction(
            document,
            {
                eval:
                    "Promise.all([" +
                    "  new Promise((r) => setTimeout(() => r(1), 3))," +
                    "  new Promise((r) => setTimeout(() => r(2), 5))," +
                    "  new Promise((r) => setTimeout(() => r(3), 1))," +
                    "])",
            },
            scope,
        );
        expect(result.value).toBe("[1,2,3]");
    });

    it("surfaces rejected Promise as an error with the expression text", async () => {
        // Async errors flow through the same `<ErrorName>: <msg>
        // (in: <expr>)` shape as synchronous throws.
        const scope = { eval: (expr) => eval(expr) };
        const evalExpr =
            "new Promise((_, reject) => setTimeout(() => reject(new Error('nope')), 3))";
        const result = await dispatchAction(
            document,
            { eval: evalExpr },
            scope,
        );
        expect(result.value).toBeNull();
        expect(result.error).toContain("Error: nope");
        expect(result.error).toContain(`(in: ${evalExpr})`);
    });

    it("caps oversized eval results with a JSON-encoded truncation notice", async () => {
        // Reproduces the real-world case: eval returns an array of
        // objects whose stringified form exceeds the cap (e.g. the
        // user's script-tag enumeration where each `.src` was a
        // multi-KB inlined data URI). The returned `value` must
        // still be valid JSON so the agent's JSON.parse works —
        // they get the notice as a string instead of the structure.
        const scope = {
            eval: () =>
                Array.from({ length: 100 }, (_, i) => ({
                    type: "text/javascript",
                    src: "data:application/javascript," + "A".repeat(2000),
                    idx: i,
                })),
        };
        const result = await dispatchAction(
            document,
            { eval: "huge" },
            scope,
        );
        expect(typeof result.value).toBe("string");
        // value is a JSON-encoded string when capped (parse-safe).
        const parsed = JSON.parse(result.value);
        expect(typeof parsed).toBe("string");
        expect(parsed).toMatch(/^\[truncated: eval\/read value was \d+ bytes/);
        // Original size mentioned, head of original preserved.
        expect(parsed).toContain('"data:application/javascript,AAA');
    });
});

describe("dispatchAction — assert", () => {
    it("returns null for a passing (truthy) assertion", async () => {
        const scope = { eval: (expr) => eval(expr) };
        const result = await dispatchAction(
            document,
            { assert: "1 + 1 === 2" },
            scope,
        );
        expect(result).toBeNull();
    });

    it("throws AssertionError-prefixed Error for a failing (falsy) assertion", async () => {
        // Throwing (not returning a result entry) is load-bearing:
        // the prefix marker tells parent-side orchestration to let
        // the error propagate so the agent's emission errors out and
        // the recoverable-error path lets the agent self-correct on
        // the next turn — instead of the agent silently committing
        // a broken app because a check returned `false` in some array.
        const scope = { eval: (expr) => eval(expr) };
        await expect(
            dispatchAction(document, { assert: "1 + 1 === 3" }, scope),
        ).rejects.toThrow(/^AssertionError: 1 \+ 1 === 3/);
    });

    it("includes the agent's `message` tag in the throw", async () => {
        const scope = { eval: (expr) => eval(expr) };
        await expect(
            dispatchAction(
                document,
                { assert: "false", message: "expected true here" },
                scope,
            ),
        ).rejects.toThrow(/expected true here/);
    });

    it("includes the actual value in the failure message", async () => {
        const scope = { eval: (expr) => eval(expr) };
        await expect(
            dispatchAction(document, { assert: "0" }, scope),
        ).rejects.toThrow(/got/);
    });

    it("with soft: true, reports a failure as a result rather than throwing", async () => {
        const scope = { eval: (expr) => eval(expr) };
        expect(await dispatchAction(document, { assert: "1 > 2", message: "order", soft: true }, scope)).toEqual({
            type: "assert",
            soft: true,
            message: "AssertionError: order — 1 > 2 (got false)",
        });
        expect(await dispatchAction(document, { assert: "nope()", soft: true }, scope)).toMatchObject({
            message: expect.stringMatching(/^AssertionError: nope\(\) threw — /),
        });
        expect(await dispatchAction(document, { assert: "true", soft: true }, scope)).toBeNull();
    });

    it("throws AssertionError when the assertion expression itself throws", async () => {
        const scope = { eval: (expr) => eval(expr) };
        await expect(
            dispatchAction(
                document,
                {
                    assert: "nonexistentVariable.foo",
                    message: "should have nonexistent",
                },
                scope,
            ),
        ).rejects.toThrow(/^AssertionError: should have nonexistent — .* threw/);
    });

    it("treats truthy non-boolean values as passing", async () => {
        // JS truthy semantics — strings, numbers, objects all count.
        // (`{}` alone parses as a block statement and returns undefined
        // — JS quirk, not the assertion's fault. Use `({})` for the
        // object-literal case if you ever need it.)
        const scope = { eval: (expr) => eval(expr) };
        for (const expr of [
            "'non-empty'",
            "42",
            "[]",
            "({})",
            "new Date()",
        ]) {
            const result = await dispatchAction(
                document,
                { assert: expr },
                scope,
            );
            expect(result).toBeNull();
        }
    });

    it("throws on every falsy value", async () => {
        const scope = { eval: (expr) => eval(expr) };
        for (const expr of ["false", "0", "''", "null", "undefined", "NaN"]) {
            await expect(
                dispatchAction(document, { assert: expr }, scope),
            ).rejects.toThrow(/^AssertionError:/);
        }
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

describe("waitForFrame", () => {
    it("resolves after a double rAF and clears the fallback timer", async () => {
        const order = [];
        const win = {
            // Each rAF call invokes its callback on a microtask — two
            // nested calls = two "frames".
            requestAnimationFrame: (cb) => {
                Promise.resolve().then(cb);
                return 1;
            },
            setTimeout: () => {
                order.push("timeout-set");
                return 99;
            },
            clearTimeout: (id) => order.push(`cleared-${id}`),
        };
        await waitForFrame(win, 100);
        // Fallback timer was armed then cleared once the frame fired —
        // i.e. we resolved via rAF, not the timeout.
        expect(order).toEqual(["timeout-set", "cleared-99"]);
    });

    it("resolves via the timeout when rAF never fires (backgrounded tab)", async () => {
        let rafCallbackRan = false;
        const win = {
            // Simulates a paused/throttled rAF: callback is stored but
            // never invoked, so the only path to resolution is the timeout.
            requestAnimationFrame: (cb) => {
                void cb;
                return 1;
            },
            setTimeout: (cb) => {
                Promise.resolve().then(cb);
                return 7;
            },
            clearTimeout: vi.fn(),
        };
        // Must not hang — resolves off the timeout path.
        await waitForFrame(win, 100);
        expect(rafCallbackRan).toBe(false);
    });

    it("resolves immediately when requestAnimationFrame is unavailable", async () => {
        await expect(waitForFrame({}, 100)).resolves.toBeUndefined();
        await expect(waitForFrame(null, 100)).resolves.toBeUndefined();
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
            __AGEX_PARENT_ORIGIN: "https://agex.studio",
            addEventListener: (_type, fn) => { handler = fn; },
        };
        installControlBridge(win);

        const source = { postMessage: vi.fn() };
        await handler({
            data: { type: "agex-control", id: "r1", action: { read: "#s" } },
            source,
            origin: "https://agex.studio",
        });

        expect(source.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                type: "agex-control-result",
                id: "r1",
                data: { type: "read", selector: "#s", value: "answer" },
                error: null,
            }),
            "https://agex.studio",
        );
    });

    it("obeys nothing while the parent's origin is unknown", async () => {
        document.body.innerHTML = '<span id="s">answer</span>';
        let handler = null;
        const win = {
            document,
            eval: vi.fn(),
            addEventListener: (_type, fn) => { handler = fn; },
        };
        installControlBridge(win);

        const source = { postMessage: vi.fn() };
        await handler({
            data: { type: "agex-control", id: "r1", action: { eval: "1 + 1" } },
            source,
            origin: "https://evil.example",
        });
        expect(win.eval).not.toHaveBeenCalled();
        expect(source.postMessage).not.toHaveBeenCalled();
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

    it("rejects messages from origins other than __AGEX_PARENT_ORIGIN", async () => {
        document.body.innerHTML = '<span id="s">answer</span>';
        let handler = null;
        const win = {
            document,
            __AGEX_PARENT_ORIGIN: "https://agex.studio",
            addEventListener: (_type, fn) => { handler = fn; },
        };
        installControlBridge(win);

        const source = { postMessage: vi.fn() };
        await handler({
            data: { type: "agex-control", id: "r1", action: { read: "#s" } },
            source,
            origin: "https://evil.example",
        });
        expect(source.postMessage).not.toHaveBeenCalled();
    });

    it("targets __AGEX_PARENT_ORIGIN on outgoing messages when set", async () => {
        document.body.innerHTML = '<span id="s">answer</span>';
        let handler = null;
        const win = {
            document,
            __AGEX_PARENT_ORIGIN: "https://agex.studio",
            addEventListener: (_type, fn) => { handler = fn; },
        };
        installControlBridge(win);

        const source = { postMessage: vi.fn() };
        await handler({
            data: { type: "agex-control", id: "r1", action: { read: "#s" } },
            source,
            origin: "https://agex.studio",
        });
        expect(source.postMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: "agex-control-result", id: "r1" }),
            "https://agex.studio",
        );
    });
});
