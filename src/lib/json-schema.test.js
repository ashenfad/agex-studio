/**
 * Unit tests for the minimal JSON-Schema → Standard Schema adapter
 * used to validate sub-task (`defineTask`) outputs.
 */

import { describe, it, expect } from "vitest";

import {
    validateAgainstJsonSchema,
    standardSchemaFromJsonSchema,
} from "./json-schema.js";

const ok = (schema, v) => validateAgainstJsonSchema(schema, v).length === 0;

describe("validateAgainstJsonSchema — types", () => {
    it("checks primitive types", () => {
        expect(ok({ type: "string" }, "hi")).toBe(true);
        expect(ok({ type: "string" }, 1)).toBe(false);
        expect(ok({ type: "number" }, 1.5)).toBe(true);
        expect(ok({ type: "integer" }, 3)).toBe(true);
        expect(ok({ type: "integer" }, 3.5)).toBe(false);
        expect(ok({ type: "boolean" }, true)).toBe(true);
        expect(ok({ type: "null" }, null)).toBe(true);
    });

    it("distinguishes object / array / null", () => {
        expect(ok({ type: "object" }, {})).toBe(true);
        expect(ok({ type: "object" }, [])).toBe(false);
        expect(ok({ type: "object" }, null)).toBe(false);
        expect(ok({ type: "array" }, [])).toBe(true);
        expect(ok({ type: "array" }, {})).toBe(false);
    });

    it("accepts a union type array", () => {
        const s = { type: ["string", "null"] };
        expect(ok(s, "x")).toBe(true);
        expect(ok(s, null)).toBe(true);
        expect(ok(s, 5)).toBe(false);
    });

    it("reports got-type in the message", () => {
        const issues = validateAgainstJsonSchema({ type: "number" }, "x");
        expect(issues[0].message).toMatch(/expected type number, got string/);
    });
});

describe("validateAgainstJsonSchema — objects", () => {
    const schema = {
        type: "object",
        properties: {
            x: { type: "integer" },
            y: { type: "integer" },
            label: { type: "string" },
        },
        required: ["x", "y"],
    };

    it("passes a conforming object", () => {
        expect(ok(schema, { x: 1, y: 2, label: "p" })).toBe(true);
        expect(ok(schema, { x: 1, y: 2 })).toBe(true); // optional omitted
    });

    it("flags a missing required property with its path", () => {
        const issues = validateAgainstJsonSchema(schema, { x: 1 });
        expect(issues).toHaveLength(1);
        expect(issues[0].path).toEqual(["y"]);
        expect(issues[0].message).toMatch(/missing required property "y"/);
    });

    it("flags a wrong-typed property with its path", () => {
        const issues = validateAgainstJsonSchema(schema, { x: 1, y: "two" });
        expect(issues).toHaveLength(1);
        expect(issues[0].path).toEqual(["y"]);
    });

    it("validates nested objects", () => {
        const nested = {
            type: "object",
            properties: { pt: schema },
            required: ["pt"],
        };
        const issues = validateAgainstJsonSchema(nested, { pt: { x: 1 } });
        expect(issues[0].path).toEqual(["pt", "y"]);
    });
});

describe("validateAgainstJsonSchema — arrays + enum", () => {
    it("applies items to every element with indexed paths", () => {
        const s = { type: "array", items: { type: "integer" } };
        expect(ok(s, [1, 2, 3])).toBe(true);
        const issues = validateAgainstJsonSchema(s, [1, "x", 3]);
        expect(issues).toHaveLength(1);
        expect(issues[0].path).toEqual([1]);
    });

    it("enforces enum membership", () => {
        const s = { enum: ["a", "b", "c"] };
        expect(ok(s, "b")).toBe(true);
        expect(ok(s, "z")).toBe(false);
    });

    it("compares object enum values order-independently", () => {
        const s = { enum: [{ x: 1, y: 2 }] };
        expect(ok(s, { y: 2, x: 1 })).toBe(true); // reordered keys still match
        expect(ok(s, { x: 1 })).toBe(false);
    });

    it("ignores unknown keywords (permissive)", () => {
        // No `type`, unsupported `minLength` — nothing to enforce → valid.
        expect(ok({ minLength: 3, description: "x" }, "ab")).toBe(true);
    });
});

describe("standardSchemaFromJsonSchema", () => {
    const std = standardSchemaFromJsonSchema({
        type: "object",
        properties: { x: { type: "integer" } },
        required: ["x"],
    });

    it("exposes the Standard Schema envelope", () => {
        expect(std["~standard"].version).toBe(1);
        expect(typeof std["~standard"].validate).toBe("function");
    });

    it("returns { value } on success", () => {
        expect(std["~standard"].validate({ x: 3 })).toEqual({ value: { x: 3 } });
    });

    it("returns { issues } with message + path on failure", () => {
        const r = std["~standard"].validate({ x: "nope" });
        expect(r.issues).toBeDefined();
        expect(r.issues[0]).toMatchObject({ path: ["x"] });
        expect(typeof r.issues[0].message).toBe("string");
    });
});
