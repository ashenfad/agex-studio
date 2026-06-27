/**
 * Round-trip checks for the TS chat-response normalizer.
 *
 * Each test pairs an agent-side value with the renderer-shape it
 * should produce. The shape contract is fixed by the renderer
 * (`MessageList.svelte` + `event-utils.js` `segmentParts`); these
 * tests guard the boundary so a future tweak to either side has to
 * acknowledge the other.
 */

import { describe, it, expect } from "vitest";
import {
    normalizePart,
    normalizeChatResponse,
    chatResponseSchema,
} from "./ts-chat-response.js";

/** Run the chat-response Standard Schema and return its result. */
const validate = (v) => chatResponseSchema["~standard"].validate(v);

describe("normalizePart", () => {
    it("translates a bare string to a text part with the value as content", () => {
        expect(normalizePart("hello")).toEqual({
            type: "text",
            content: "hello",
        });
    });

    it("preserves empty strings as empty text", () => {
        expect(normalizePart("")).toEqual({ type: "text", content: "" });
    });

    it("detects a Plotly figure by data-array + layout-object", () => {
        const fig = {
            data: [{ x: [1, 2], y: [3, 4], type: "scatter" }],
            layout: { title: "demo" },
        };
        expect(normalizePart(fig)).toEqual({ type: "plotly", figure: fig });
    });

    it("preserves optional Plotly fields like config", () => {
        const fig = {
            data: [{ x: [], y: [] }],
            layout: {},
            config: { displayModeBar: false },
        };
        const out = normalizePart(fig);
        expect(out.type).toBe("plotly");
        expect(out.figure.config).toEqual({ displayModeBar: false });
    });

    it("detects a table by columns + rows arrays", () => {
        const t = { columns: ["a", "b"], rows: [[1, 2], [3, 4]] };
        expect(normalizePart(t)).toEqual({
            type: "dataframe",
            columns: ["a", "b"],
            rows: [[1, 2], [3, 4]],
        });
    });

    it("ignores extra fields on the table shape", () => {
        const t = { columns: ["x"], rows: [[1]], extra: "ignored" };
        const out = normalizePart(t);
        expect(out).toEqual({
            type: "dataframe",
            columns: ["x"],
            rows: [[1]],
        });
        expect(out).not.toHaveProperty("extra");
    });

    it("treats Plotly precedence over tabular when both shapes match", () => {
        // Contrived collision: an object with data+layout AND columns+rows.
        // Plotly check fires first in normalizePart's sniff order.
        const ambiguous = {
            data: [{}],
            layout: {},
            columns: ["a"],
            rows: [[1]],
        };
        expect(normalizePart(ambiguous).type).toBe("plotly");
    });

    it("renders a flat unrecognized object as a key/value table (not [object Object])", () => {
        const out = normalizePart({ foo: "bar", count: 3 });
        expect(out).toEqual({
            type: "dataframe",
            columns: ["field", "value"],
            rows: [
                ["foo", "bar"],
                ["count", "3"],
            ],
        });
    });

    it("renders a nested/deep unrecognized object as a fenced JSON block", () => {
        const out = normalizePart({ a: { b: 1 }, list: [1, 2] });
        expect(out.type).toBe("text");
        expect(out.content).toContain("```json");
        expect(out.content).toContain('"b": 1');
    });

    it("falls back to text for null and undefined (empty bubble)", () => {
        expect(normalizePart(null)).toEqual({ type: "text", content: "" });
        expect(normalizePart(undefined)).toEqual({
            type: "text",
            content: "",
        });
    });

    it("falls back to text for numbers and booleans", () => {
        expect(normalizePart(42)).toEqual({ type: "text", content: "42" });
        expect(normalizePart(true)).toEqual({
            type: "text",
            content: "true",
        });
    });

    it("rejects 'data + layout' when data isn't an array (not a Plotly fig)", () => {
        const not = { data: "string", layout: {} };
        expect(normalizePart(not).type).toBe("text");
    });

    it("rejects 'columns + rows' when either isn't an array (not a table)", () => {
        const not = { columns: "abc", rows: [[1]] };
        expect(normalizePart(not).type).toBe("text");
    });
});

describe("normalizeChatResponse", () => {
    it("wraps a bare string as a text content object", () => {
        expect(normalizeChatResponse("just text")).toEqual({
            type: "text",
            content: "just text",
        });
    });

    it("wraps an array as a multi-part response", () => {
        const out = normalizeChatResponse([
            "Header",
            { columns: ["x"], rows: [[1]] },
        ]);
        expect(out.type).toBe("response");
        expect(out.parts).toHaveLength(2);
        expect(out.parts[0]).toEqual({ type: "text", content: "Header" });
        expect(out.parts[1].type).toBe("dataframe");
    });

    it("wraps a single non-string value as a single-part response", () => {
        // Justification: `taskSuccess(myFigure)` should work without
        // forcing the agent to wrap in an array.
        const fig = { data: [{}], layout: {} };
        const out = normalizeChatResponse(fig);
        expect(out.type).toBe("response");
        expect(out.parts).toHaveLength(1);
        expect(out.parts[0].type).toBe("plotly");
    });

    it("handles an empty array as an empty response (renderer shows nothing)", () => {
        expect(normalizeChatResponse([])).toEqual({
            type: "response",
            parts: [],
        });
    });

    it("handles null / undefined as empty text (preserves prior behavior)", () => {
        expect(normalizeChatResponse(null)).toEqual({
            type: "response",
            parts: [{ type: "text", content: "" }],
        });
        expect(normalizeChatResponse(undefined)).toEqual({
            type: "response",
            parts: [{ type: "text", content: "" }],
        });
    });

    it("handles mixed parts in the order the agent provided them", () => {
        const out = normalizeChatResponse([
            "Intro",
            { data: [{}], layout: {} },
            "Middle text",
            { columns: ["c"], rows: [[1]] },
            "Conclusion",
        ]);
        expect(out.parts.map((p) => p.type)).toEqual([
            "text",
            "plotly",
            "text",
            "dataframe",
            "text",
        ]);
    });
});

describe("normalizePart — dashboard primitives", () => {
    it("translates a stat shape into a stat part", () => {
        expect(
            normalizePart({
                type: "stat",
                label: "Work meetings / week",
                value: "~3.5 hrs",
            }),
        ).toEqual({
            type: "stat",
            label: "Work meetings / week",
            value: "~3.5 hrs",
        });
    });

    it("preserves stat sublabel when present", () => {
        expect(
            normalizePart({
                type: "stat",
                label: "Foo",
                value: 42,
                sublabel: "since Monday",
            }),
        ).toEqual({
            type: "stat",
            label: "Foo",
            value: "42",  // numeric values stringify
            sublabel: "since Monday",
        });
    });

    it("renders a malformed stat (missing label or value) as a key/value table, not [object Object]", () => {
        const r1 = normalizePart({ type: "stat", value: "v" });
        expect(r1.type).toBe("dataframe");
        const r2 = normalizePart({ type: "stat", label: "L" });
        expect(r2.type).toBe("dataframe");
    });

    it("translates a callout with default info tone", () => {
        expect(
            normalizePart({
                type: "callout",
                title: "Heads up",
                body: "Some observation.",
            }),
        ).toEqual({
            type: "callout",
            title: "Heads up",
            body: "Some observation.",
            tone: "info",
        });
    });

    it("preserves valid tones (success / warning); rejects unknown", () => {
        expect(
            normalizePart({
                type: "callout",
                title: "x",
                body: "y",
                tone: "success",
            }).tone,
        ).toBe("success");
        expect(
            normalizePart({
                type: "callout",
                title: "x",
                body: "y",
                tone: "warning",
            }).tone,
        ).toBe("warning");
        // unknown tone clamps to default 'info' rather than passing
        // through — keeps the rendered icon set bounded.
        expect(
            normalizePart({
                type: "callout",
                title: "x",
                body: "y",
                tone: "danger",
            }).tone,
        ).toBe("info");
    });

    it("translates a cards row, normalizing each item", () => {
        const r = normalizePart({
            type: "cards",
            items: [
                { type: "stat", label: "A", value: "1" },
                { type: "callout", title: "T", body: "B", tone: "warning" },
            ],
        });
        expect(r.type).toBe("cards");
        expect(r.items).toHaveLength(2);
        expect(r.items[0].type).toBe("stat");
        expect(r.items[1].type).toBe("callout");
        expect(r.items[1].tone).toBe("warning");
    });

    it("filters non-card items out of a cards row", () => {
        // A `cards` row should only contain stat/callout. Strings,
        // tables, charts, etc. don't make visual sense in a card grid;
        // silently drop instead of forcing a confused render.
        const r = normalizePart({
            type: "cards",
            items: [
                { type: "stat", label: "ok", value: "1" },
                "ignored text",
                { columns: ["c"], rows: [[1]] },
            ],
        });
        expect(r.items).toHaveLength(1);
        expect(r.items[0].type).toBe("stat");
    });

    it("dashboard parts compose with text + chart in a single response", () => {
        const out = normalizeChatResponse([
            "Summary:",
            {
                type: "cards",
                items: [{ type: "stat", label: "L", value: "V" }],
            },
            { data: [{}], layout: {} },
            {
                type: "callout",
                title: "Note",
                body: "Worth knowing.",
            },
        ]);
        expect(out.parts.map((p) => p.type)).toEqual([
            "text",
            "cards",
            "plotly",
            "callout",
        ]);
    });
});

describe("chatResponseSchema (output validation)", () => {
    it("accepts a bare string", () => {
        expect(validate("hello")).toEqual({ value: "hello" });
    });

    it("accepts primitives and null/undefined", () => {
        for (const v of [42, true, null, undefined]) {
            expect(validate(v).issues).toBeUndefined();
        }
    });

    it("accepts each renderable part shape", () => {
        const parts = [
            { data: [{}], layout: {} }, // plotly
            { columns: ["a"], rows: [[1]] }, // dataframe
            { type: "stat", label: "L", value: 1 },
            { type: "callout", title: "T", body: "B" },
            { type: "cards", items: [] },
        ];
        for (const p of parts) {
            expect(validate(p).issues, JSON.stringify(p)).toBeUndefined();
        }
    });

    it("accepts an array mixing strings and parts", () => {
        const r = validate(["Header", { columns: ["x"], rows: [[1]] }, "footer"]);
        expect(r.issues).toBeUndefined();
        expect(r.value).toBeDefined();
    });

    it("rejects a bare domain object with an actionable message", () => {
        // The reported bug: agent returned this and we showed [object Object].
        const r = validate({
            prime: "3478234824359",
            isLarger: true,
            isPrime: true,
            verificationMethod: "Trial division up to sqrt(N)",
        });
        expect(r.issues).toBeDefined();
        expect(r.issues).toHaveLength(1);
        const msg = r.issues[0].message;
        expect(msg).toContain("no renderable shape");
        // Names the offending keys and points at the table escape hatch.
        expect(msg).toContain("prime");
        expect(msg).toContain("{ columns, rows }");
    });

    it("rejects a bad object inside an array, with the array index in the path", () => {
        const r = validate(["ok text", { mystery: 1 }]);
        expect(r.issues).toHaveLength(1);
        expect(r.issues[0].path).toEqual([1]);
    });

    it("rejects nested arrays as parts", () => {
        const r = validate([["a", "b"]]);
        expect(r.issues).toHaveLength(1);
        expect(r.issues[0].message).toContain("Nested arrays");
    });
});

describe("image parts", () => {
    // Minimal valid PNG header bytes (magic + a little body).
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

    it("normalizes a tagged image part from raw bytes to a data: URL", () => {
        const out = normalizePart({ type: "image", data: png, alt: "map" });
        expect(out.type).toBe("image");
        expect(out.alt).toBe("map");
        expect(out.data).toMatch(/^data:image\/png;base64,/);
    });

    it("detects jpeg vs png from magic bytes", () => {
        expect(normalizePart({ type: "image", data: jpeg }).data).toMatch(
            /^data:image\/jpeg;base64,/,
        );
    });

    it("passes through an already-encoded data: URL untouched", () => {
        const url = "data:image/webp;base64,AAAA";
        expect(normalizePart({ type: "image", data: url })).toEqual({
            type: "image",
            data: url,
        });
    });

    it("wraps a bare base64 string as a png data: URL", () => {
        expect(normalizePart({ type: "image", data: "AAAA" }).data).toBe(
            "data:image/png;base64,AAAA",
        );
    });

    it("treats bare image bytes as an image (taskSuccess(['cap', page]))", () => {
        const out = normalizePart(png);
        expect(out.type).toBe("image");
        expect(out.data).toMatch(/^data:image\/png;base64,/);
    });

    it("renders non-image bytes as a short note, not a byte table", () => {
        const out = normalizePart(new Uint8Array([1, 2, 3, 4]));
        expect(out.type).toBe("text");
        expect(out.content).toMatch(/bytes/);
    });

    it("validates image parts and bare image bytes (no retry bounce)", () => {
        expect(validate({ type: "image", data: png }).issues).toBeUndefined();
        expect(validate([png, "caption"]).issues).toBeUndefined();
        expect(validate(png).issues).toBeUndefined();
    });

    it("round-trips an image inside a mixed parts array", () => {
        const r = normalizeChatResponse(["see the map", { type: "image", data: png }]);
        expect(r.type).toBe("response");
        expect(r.parts.map((p) => p.type)).toEqual(["text", "image"]);
    });
});

describe("audio parts", () => {
    // ID3-tagged mp3 bytes, and a RIFF/WAVE header.
    const mp3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 1]);
    const wav = new Uint8Array([
        0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45,
    ]);

    it("normalizes raw bytes to a data: URL, sniffing mp3 vs wav", () => {
        const a = normalizePart({ type: "audio", data: mp3, title: "bg loop" });
        expect(a.type).toBe("audio");
        expect(a.title).toBe("bg loop");
        expect(a.data).toMatch(/^data:audio\/mpeg;base64,/);
        expect(normalizePart({ type: "audio", data: wav }).data).toMatch(
            /^data:audio\/wav;base64,/,
        );
    });

    it("defaults a bare base64 string to mp3 and passes a data: URL through", () => {
        expect(normalizePart({ type: "audio", data: "AAAA" }).data).toBe(
            "data:audio/mpeg;base64,AAAA",
        );
        const url = "data:audio/wav;base64,AAAA";
        expect(normalizePart({ type: "audio", data: url }).data).toBe(url);
    });

    it("validates an audio part (no retry bounce)", () => {
        expect(validate({ type: "audio", data: mp3 }).issues).toBeUndefined();
        expect(validate(["here's a track", { type: "audio", data: mp3 }]).issues).toBeUndefined();
    });

    it("round-trips audio inside a mixed parts array", () => {
        const r = normalizeChatResponse(["here's a track:", { type: "audio", data: mp3 }]);
        expect(r.parts.map((p) => p.type)).toEqual(["text", "audio"]);
    });
});
