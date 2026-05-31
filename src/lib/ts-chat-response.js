/**
 * Normalize whatever the TS chat task returned into the studio
 * shell's renderer-expected shape.
 *
 * Why a normalizer: agex preserves whatever value the agent passed to
 * `taskSuccess(...)` end-to-end, but the studio's renderer
 * (`MessageList.svelte` + `event-utils.js`'s `segmentParts`) dispatches
 * on a specific tagged shape:
 *
 *   - `string`                                          → simple text bubble
 *   - `{ type: 'text', content: '<markdown>' }`         → text bubble
 *   - `{ type: 'response', parts: [...] }` where each part is one of:
 *       - `{ type: 'text', content: '<markdown>' }`
 *       - `{ type: 'dataframe', columns: [...], rows: [[...]] }`
 *       - `{ type: 'plotly', figure: { data, layout, config? } }`
 *
 * Agents on the TS side construct values naturally — `taskSuccess(["text",
 * plot])` rather than the verbose tagged shape — and this module sniffs
 * the shape of each part. Plotly figures (`{ data: any[], layout: object }`)
 * and tables (`{ columns: any[], rows: any[] }`) are detected by their
 * canonical fields; everything else falls back to text. Mirrors how
 * agex-py's `Response.normalize()` does the same job via `isinstance`
 * dispatch — JS doesn't have classes for "DataFrame" or "Figure," so
 * we sniff JSON shape instead.
 *
 * The agent never has to know this module exists; the renderer never has
 * to know about agex-ts's freeform return values. This file is the
 * single chokepoint where the two sides meet.
 */

/**
 * Translate one agent-returned value into the renderer's per-part shape.
 *
 * Sniff order (first match wins):
 *   1. `string` → text part. Renderer treats text content as markdown.
 *   2. Plotly figure: object with `data: any[]` AND `layout: object`.
 *      The whole object becomes `figure`; the renderer's PlotlyChart
 *      component consumes the standard Plotly figure shape.
 *   3. Table: object with `columns: any[]` AND `rows: any[]`. Pass
 *      through to the dataframe renderer.
 *   4. Anything else → text part with `String(p)`. Mirrors py's
 *      `str(p)` fallback.
 *
 * False positives are theoretically possible — an unrelated object
 * with both `data` and `layout` fields would be misread as a chart —
 * but those collisions are contrived in practice. A user who hits
 * one can switch to the explicit tagged shape if needed.
 *
 * @param {unknown} p - one element from the agent's response
 * @returns {object} a `{ type, ... }` part dict the renderer consumes
 */
// Shape predicates — the single source of truth for "what is a
// renderable part." Shared by `normalizePart` (which maps a match to
// the renderer dict) and `chatResponseSchema` (which validates that a
// part matches one of them). Keep these in lock-step: anything the
// schema accepts, the normalizer must render, and vice versa.
const isStat = (o) =>
    o.type === "stat" && typeof o.label === "string" && o.value !== undefined;
const isCallout = (o) =>
    o.type === "callout" &&
    (typeof o.title === "string" || typeof o.body === "string");
const isCards = (o) => o.type === "cards" && Array.isArray(o.items);
const isPlotly = (o) =>
    Array.isArray(o.data) && o.layout != null && typeof o.layout === "object";
const isDataframe = (o) => Array.isArray(o.columns) && Array.isArray(o.rows);

/** Render an unrecognized object as readable data rather than the
 *  `String(obj)` → "[object Object]" trap. A flat object of primitives
 *  becomes a key/value table; anything deeper becomes a fenced JSON
 *  block. This is defense-in-depth — the chat task's output schema
 *  rejects such objects up front, but historical events, the Py path,
 *  and viewer mode all flow through here too. */
function objectFallbackPart(o) {
    const entries = Object.entries(o);
    const allFlat =
        entries.length > 0 &&
        entries.every(
            ([, v]) =>
                v === null || ["string", "number", "boolean"].includes(typeof v),
        );
    if (allFlat) {
        return {
            type: "dataframe",
            columns: ["field", "value"],
            rows: entries.map(([k, v]) => [k, v === null ? "null" : String(v)]),
        };
    }
    try {
        return {
            type: "text",
            content: "```json\n" + JSON.stringify(o, null, 2) + "\n```",
        };
    } catch {
        return { type: "text", content: String(o) };
    }
}

export function normalizePart(p) {
    if (typeof p === "string") {
        return { type: "text", content: p };
    }
    if (p && typeof p === "object" && !Array.isArray(p)) {
        const o = /** @type {Record<string, unknown>} */ (p);
        // Tagged dashboard primitives — stat / callout / cards row.
        if (isStat(o)) {
            return {
                type: "stat",
                label: o.label,
                value: String(o.value),
                ...(o.sublabel !== undefined
                    ? { sublabel: String(o.sublabel) }
                    : {}),
            };
        }
        if (isCallout(o)) {
            const tone =
                o.tone === "success" || o.tone === "warning" ? o.tone : "info";
            return {
                type: "callout",
                title: typeof o.title === "string" ? o.title : "",
                body: typeof o.body === "string" ? o.body : "",
                tone,
            };
        }
        if (isCards(o)) {
            // Recursively normalize items, but only keep stat/callout
            // entries — a row of cards holding text/charts/tables
            // would be visually weird and isn't the intended use.
            const items = o.items
                .map((it) => normalizePart(it))
                .filter((it) => it.type === "stat" || it.type === "callout");
            return { type: "cards", items };
        }
        // Plotly figure: { data: [...], layout: {...} }
        if (isPlotly(o)) {
            return { type: "plotly", figure: o };
        }
        // Tabular: { columns: [...], rows: [...] }
        if (isDataframe(o)) {
            return {
                type: "dataframe",
                columns: o.columns,
                rows: o.rows,
            };
        }
        // Unrecognized object — render its data, never "[object Object]".
        return objectFallbackPart(o);
    }
    // Primitives (number / boolean) and null/undefined → text.
    return { type: "text", content: String(p ?? "") };
}

/**
 * Translate the agent's full response value into the renderer's
 * top-level message-content shape.
 *
 *   - `string`                          → `{ type: 'text', content: <string> }`
 *                                          (renderer handles bare strings via the
 *                                          same path; we wrap so downstream code
 *                                          sees a uniform object shape)
 *   - `Array`                           → `{ type: 'response', parts: [...] }`
 *   - any single non-string value       → `{ type: 'response', parts: [<part>] }`
 *                                          (lets `taskSuccess(myFigure)` work
 *                                          without explicit array wrap)
 *
 * Returns an object even for the bare-string case so callers don't
 * have to branch — `result.type === 'text' | 'response'` unambiguously.
 *
 * @param {unknown} value - the raw `taskSuccess` value from the agent
 * @returns {{ type: 'text', content: string } | { type: 'response', parts: Array<object> }}
 */
export function normalizeChatResponse(value) {
    if (typeof value === "string") {
        return { type: "text", content: value };
    }
    if (Array.isArray(value)) {
        return {
            type: "response",
            parts: value.map((p) => normalizePart(p)),
        };
    }
    return {
        type: "response",
        parts: [normalizePart(value)],
    };
}

/**
 * Validate one element of a chat response. Pushes an actionable issue
 * (not a bare "invalid") when an object matches no renderable shape —
 * agex-ts surfaces these to the agent, which then retries with a
 * proper shape instead of us silently rendering garbage.
 */
function validateChatPart(p, path, issues) {
    if (p === null || p === undefined) return; // empty → empty text
    const t = typeof p;
    if (t === "string" || t === "number" || t === "boolean") return; // → text
    if (Array.isArray(p)) {
        issues.push({
            path,
            message:
                "Nested arrays aren't valid response parts — flatten parts into the top-level array.",
        });
        return;
    }
    if (t === "object") {
        const o = /** @type {Record<string, unknown>} */ (p);
        if (isStat(o) || isCallout(o) || isCards(o) || isPlotly(o) || isDataframe(o)) {
            return;
        }
        const keys = Object.keys(o).slice(0, 8).join(", ");
        issues.push({
            path,
            message:
                `Response part is an object with no renderable shape (keys: ${keys}). ` +
                "Return a string (markdown), a { columns, rows } table, a { data, layout } " +
                "Plotly figure, or a tagged { type: 'stat' | 'callout' | 'cards' } card. " +
                "To present structured data like this, format it as markdown prose or a " +
                "{ columns, rows } table.",
        });
        return;
    }
    issues.push({ path, message: `Unsupported response part of type "${t}".` });
}

/**
 * Standard Schema for the chat task's `output`. The agent's
 * `taskSuccess(...)` value must be a string, a primitive, a renderable
 * part, or an array of those — anything else (e.g. a bare domain
 * object) fails validation and the agent retries with feedback rather
 * than the studio rendering "[object Object]".
 *
 * Hand-rolled (no schema-lib dependency): the part union is shallow
 * and shape-sniffed, and a custom validator lets us return guidance
 * the agent can act on. Defined entirely host-side, so no worker
 * boundary concerns.
 */
export const chatResponseSchema = {
    "~standard": {
        version: 1,
        vendor: "agex-studio",
        /** @param {unknown} value */
        validate(value) {
            /** @type {Array<{ message: string, path?: ReadonlyArray<PropertyKey> }>} */
            const issues = [];
            if (Array.isArray(value)) {
                value.forEach((p, i) => validateChatPart(p, [i], issues));
            } else {
                validateChatPart(value, [], issues);
            }
            return issues.length > 0 ? { issues } : { value };
        },
    },
};
