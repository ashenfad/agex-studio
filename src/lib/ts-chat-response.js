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
export function normalizePart(p) {
    if (typeof p === "string") {
        return { type: "text", content: p };
    }
    if (p && typeof p === "object") {
        const o = /** @type {Record<string, unknown>} */ (p);
        // Plotly figure: { data: [...], layout: {...} }
        if (Array.isArray(o.data) && o.layout && typeof o.layout === "object") {
            return { type: "plotly", figure: o };
        }
        // Tabular: { columns: [...], rows: [...] }
        if (Array.isArray(o.columns) && Array.isArray(o.rows)) {
            return {
                type: "dataframe",
                columns: o.columns,
                rows: o.rows,
            };
        }
    }
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
