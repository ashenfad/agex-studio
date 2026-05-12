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
} from "./ts-chat-response.js";

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

    it("falls back to text for unrecognized objects", () => {
        const out = normalizePart({ foo: "bar", count: 3 });
        expect(out.type).toBe("text");
        // Native String() of an object — the renderer at least gets a
        // visible bubble rather than nothing.
        expect(typeof out.content).toBe("string");
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

    it("rejects malformed stat (missing label or value) — falls back to text", () => {
        const r1 = normalizePart({ type: "stat", value: "v" });
        expect(r1.type).toBe("text");
        const r2 = normalizePart({ type: "stat", label: "L" });
        expect(r2.type).toBe("text");
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
