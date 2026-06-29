/**
 * Unit tests for `ts-result-helpers.js`.
 *
 * Both functions mutate the input array in place. The tests assert
 * on the returned reference (which is the same array), so an
 * accidental "returned a copy" regression would still be caught
 * via the missing mutation.
 */

import { describe, expect, it, vi } from "vitest";

import {
    emitObservations,
    normalizeEvalValues,
} from "./ts-result-helpers.js";

// --------------------------------------------------------------------------
// normalizeEvalValues
// --------------------------------------------------------------------------

describe("normalizeEvalValues", () => {
    it("parses JSON string values on eval entries to native types", () => {
        const results = [
            { type: "eval", expr: "({x: 1})", value: '{"x":1}' },
            { type: "eval", expr: "42", value: "42" },
            { type: "eval", expr: "'hi'", value: '"hi"' },
            { type: "eval", expr: "[1,2,3]", value: "[1,2,3]" },
            { type: "eval", expr: "true", value: "true" },
        ];
        normalizeEvalValues(results);
        expect(results[0].value).toEqual({ x: 1 });
        expect(results[1].value).toBe(42);
        expect(results[2].value).toBe("hi");
        expect(results[3].value).toEqual([1, 2, 3]);
        expect(results[4].value).toBe(true);
    });

    it("undoes the double-encoding hazard the agent reported", () => {
        // Agent writes `eval: 'JSON.stringify({foo: 1})'`. The
        // iframe-side eval returns the string `'{"foo":1}'`, which
        // _jsonifyEvalResult JSON-stringifies *again* into
        // '"{\\"foo\\":1}"'. After our post-process, the value
        // should land as the *string* the agent's eval actually
        // returned — not the doubly-decoded object (we shouldn't be
        // peeling layers the agent owns).
        const results = [
            {
                type: "eval",
                expr: "JSON.stringify({foo: 1})",
                value: '"{\\"foo\\":1}"',
            },
        ];
        normalizeEvalValues(results);
        expect(results[0].value).toBe('{"foo":1}');
    });

    it("leaves null values untouched (bridge passes null through unstringified)", () => {
        const results = [{ type: "eval", expr: "undefined", value: null }];
        normalizeEvalValues(results);
        expect(results[0].value).toBeNull();
    });

    it("preserves eval entries that carry an `error` field", () => {
        const results = [
            {
                type: "eval",
                expr: "throwsThing()",
                value: null,
                error: "ReferenceError: throwsThing is not defined",
            },
        ];
        normalizeEvalValues(results);
        expect(results[0]).toMatchObject({
            value: null,
            error: "ReferenceError: throwsThing is not defined",
        });
    });

    it("leaves non-eval entries alone", () => {
        const results = [
            { type: "read", selector: "#x", value: "hello" },
            {
                type: "log",
                level: "error",
                message: "Screenshot failed: nope",
            },
            { type: "screenshot", data: "iVBOR..." },
            { type: "logs", logs: [] },
        ];
        const snapshot = JSON.parse(JSON.stringify(results));
        normalizeEvalValues(results);
        expect(results).toEqual(snapshot);
    });

    it("tolerates malformed JSON by leaving the string in place", () => {
        // _jsonifyEvalResult always produces valid JSON, so this is
        // a defensive case — the helper should not crash if the
        // bridge ever regresses.
        const results = [{ type: "eval", expr: "x", value: "{not: 'json'}" }];
        normalizeEvalValues(results);
        expect(results[0].value).toBe("{not: 'json'}");
    });

    it("returns the same array reference (chainable)", () => {
        const results = [];
        expect(normalizeEvalValues(results)).toBe(results);
    });

    it("ignores entries that aren't objects (defensive)", () => {
        const results = [null, undefined, "x", 42, { type: "eval", value: "1" }];
        normalizeEvalValues(results);
        expect(results[0]).toBeNull();
        expect(results[1]).toBeUndefined();
        expect(results[2]).toBe("x");
        expect(results[3]).toBe(42);
        expect(results[4].value).toBe(1);
    });
});

// --------------------------------------------------------------------------
// emitObservations
// --------------------------------------------------------------------------

describe("emitObservations", () => {
    /** Build a minimal ctx with a recording stub for `console.log`. */
    function makeCtx() {
        const calls = [];
        return {
            ctx: { console: { log: (...args) => calls.push(args) } },
            calls,
        };
    }

    it("emits screenshot entries as image envelopes via console.log", () => {
        const { ctx, calls } = makeCtx();
        const results = [
            { type: "screenshot", data: "BASE64_BYTES" },
        ];
        emitObservations(ctx, results);
        expect(calls).toEqual([
            [{ format: "png", data: "BASE64_BYTES" }],
        ]);
    });

    it("replaces emitted screenshot data with a sentinel", () => {
        const { ctx } = makeCtx();
        const results = [{ type: "screenshot", data: "BASE64_BYTES" }];
        emitObservations(ctx, results);
        // Result array still carries the entry, but with the giant
        // base64 blob replaced — avoids bloating event-log
        // persistence on taskSuccess.
        expect(results[0].data).toBe("<emitted via console.log>");
    });

    it("preserves the real base64 on a `dataBase64` side field", () => {
        const { ctx } = makeCtx();
        const results = [{ type: "screenshot", data: "BASE64_BYTES" }];
        emitObservations(ctx, results);
        // The escape hatch: agents that want to embed the shot in
        // taskSuccess read `dataBase64`, which still carries the real
        // base64 even though `data` is stubbed.
        expect(results[0].dataBase64).toBe("BASE64_BYTES");
    });

    it("emits screenshot capture failures as text via console.log", () => {
        const { ctx, calls } = makeCtx();
        const results = [
            {
                type: "log",
                level: "error",
                message: "Screenshot failed: tainted canvas",
            },
        ];
        emitObservations(ctx, results);
        expect(calls).toEqual([["[testApp] Screenshot failed: tainted canvas"]]);
    });

    it("ignores screenshot entries with no data (defensive)", () => {
        const { ctx, calls } = makeCtx();
        const results = [{ type: "screenshot", data: null }];
        emitObservations(ctx, results);
        expect(calls).toEqual([]);
    });

    it("ignores non-screenshot error logs (unrelated failures)", () => {
        const { ctx, calls } = makeCtx();
        const results = [
            {
                type: "log",
                level: "error",
                message: "Some other action failed: foo",
            },
        ];
        emitObservations(ctx, results);
        expect(calls).toEqual([]);
    });

    it("emits multiple entries from the same call", () => {
        const { ctx, calls } = makeCtx();
        const results = [
            { type: "screenshot", data: "AAA" },
            {
                type: "log",
                level: "error",
                message: "Screenshot failed: opaque origin",
            },
            { type: "screenshot", data: "BBB" },
        ];
        emitObservations(ctx, results);
        expect(calls).toHaveLength(3);
        expect(calls[0]).toEqual([{ format: "png", data: "AAA" }]);
        expect(calls[1]).toEqual([
            "[testApp] Screenshot failed: opaque origin",
        ]);
        expect(calls[2]).toEqual([{ format: "png", data: "BBB" }]);
    });

    it("returns the same array reference (chainable)", () => {
        const { ctx } = makeCtx();
        const results = [];
        expect(emitObservations(ctx, results)).toBe(results);
    });

    it("composes with normalizeEvalValues", () => {
        // Verify the chained-call pattern used by testApp/liveApp:
        // both functions mutate the same array, return order is
        // arbitrary, and the agent sees fully-processed results.
        const { ctx, calls } = makeCtx();
        const results = [
            { type: "eval", expr: "({a: 1})", value: '{"a":1}' },
            { type: "screenshot", data: "PNG" },
        ];
        const out = emitObservations(ctx, normalizeEvalValues(results));
        expect(out).toBe(results);
        expect(results[0].value).toEqual({ a: 1 });
        expect(results[1].data).toBe("<emitted via console.log>");
        expect(calls).toEqual([[{ format: "png", data: "PNG" }]]);
    });
});
