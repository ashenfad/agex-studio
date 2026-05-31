/**
 * Minimal JSON-Schema → Standard Schema adapter.
 *
 * agex-ts validates a task's `output` only when it's a
 * [Standard Schema](https://standardschema.dev/) (it calls
 * `schema['~standard'].validate`); a plain JSON Schema is prompt-only.
 * Sub-tasks (`defineTask`) are defined from the agent's *worker* code,
 * so their output contract has to cross the worker→host boundary as
 * plain data — a real schema object (zod/valibot) can't, because its
 * `validate` is a function and functions don't structured-clone. The
 * agent therefore ships a JSON Schema (plain data) and the *host* turns
 * it into a validating Standard Schema with this module.
 *
 * Intentionally a small subset — enough for the shapes sub-tasks
 * actually return (`{x: number, y: number}`, `{isPrime: boolean,
 * reason: string}`, arrays of those). Supported keywords:
 *
 *   - `type` (string or array): string | number | integer | boolean |
 *     null | object | array
 *   - `properties` + `required` (objects)
 *   - `items` (arrays — single sub-schema applied to every element)
 *   - `enum`
 *
 * Unknown keywords are ignored (permissive) rather than rejected, so a
 * loosely-specified schema never over-constrains. Not supported:
 * `oneOf`/`anyOf`/`allOf`, `additionalProperties`, tuple `items`,
 * `$ref`, numeric/string bounds. Add them here if a real sub-task
 * needs them.
 */

function typeOf(v) {
    if (v === null) return "null";
    if (Array.isArray(v)) return "array";
    return typeof v; // "string" | "number" | "boolean" | "object" | ...
}

function matchesType(t, v) {
    switch (t) {
        case "string":
            return typeof v === "string";
        case "number":
            return typeof v === "number" && Number.isFinite(v);
        case "integer":
            return typeof v === "number" && Number.isInteger(v);
        case "boolean":
            return typeof v === "boolean";
        case "null":
            return v === null;
        case "object":
            return v !== null && typeof v === "object" && !Array.isArray(v);
        case "array":
            return Array.isArray(v);
        default:
            return true; // unknown type keyword → don't constrain
    }
}

function deepEqual(a, b) {
    if (a === b) return true;
    if (a && b && typeof a === "object" && typeof b === "object") {
        if (Array.isArray(a) !== Array.isArray(b)) return false;
        if (Array.isArray(a)) {
            return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
        }
        // Order-independent object compare — `enum` values with the same
        // keys in a different order must still match (JSON.stringify
        // would treat them as unequal).
        const keysA = Object.keys(a);
        const keysB = Object.keys(b);
        if (keysA.length !== keysB.length) return false;
        return keysA.every(
            (k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]),
        );
    }
    return false;
}

/**
 * Collect validation issues for `value` against `schema`. Returns an
 * array of `{ path, message }` (empty when valid). `path` is an array
 * of property keys / array indices, matching the Standard Schema issue
 * shape.
 *
 * @param {any} schema
 * @param {unknown} value
 * @param {Array<PropertyKey>} [path]
 * @returns {Array<{ path: Array<PropertyKey>, message: string }>}
 */
export function validateAgainstJsonSchema(schema, value, path = []) {
    const issues = [];
    check(schema, value, path, issues);
    return issues;
}

function check(schema, value, path, issues) {
    if (!schema || typeof schema !== "object") return;

    if (schema.type !== undefined) {
        const types = Array.isArray(schema.type) ? schema.type : [schema.type];
        if (!types.some((t) => matchesType(t, value))) {
            issues.push({
                path,
                message: `expected type ${types.join(" | ")}, got ${typeOf(value)}`,
            });
            return; // type is wrong — descending would just add noise
        }
    }

    if (Array.isArray(schema.enum) && !schema.enum.some((e) => deepEqual(e, value))) {
        issues.push({
            path,
            message: `expected one of ${JSON.stringify(schema.enum)}`,
        });
    }

    // Object constraints.
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        if (Array.isArray(schema.required)) {
            for (const key of schema.required) {
                if (!Object.prototype.hasOwnProperty.call(value, key)) {
                    issues.push({
                        path: [...path, key],
                        message: `missing required property "${key}"`,
                    });
                }
            }
        }
        if (schema.properties && typeof schema.properties === "object") {
            for (const [key, sub] of Object.entries(schema.properties)) {
                if (Object.prototype.hasOwnProperty.call(value, key)) {
                    check(sub, value[key], [...path, key], issues);
                }
            }
        }
    }

    // Array items (single sub-schema applied to each element).
    if (Array.isArray(value) && schema.items && typeof schema.items === "object") {
        value.forEach((item, i) => check(schema.items, item, [...path, i], issues));
    }
}

/**
 * Wrap a JSON Schema in a Standard Schema so agex-ts can validate a
 * task's `output` against it (and retry the agent on mismatch).
 *
 * @param {object} jsonSchema
 * @returns {{ '~standard': { version: 1, vendor: string, validate: (value: unknown) => ({ value: unknown } | { issues: Array<{ message: string, path: Array<PropertyKey> }> }) } }}
 */
export function standardSchemaFromJsonSchema(jsonSchema) {
    return {
        "~standard": {
            version: 1,
            vendor: "agex-studio",
            validate(value) {
                const issues = validateAgainstJsonSchema(jsonSchema, value);
                if (issues.length === 0) return { value };
                return {
                    issues: issues.map((i) => ({ message: i.message, path: i.path })),
                };
            },
        },
    };
}
