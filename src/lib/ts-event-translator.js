/**
 * Translate agex-ts events / token chunks into the studio shell's
 * canonical (agex-py-shaped) renderer format.
 *
 * Why translation: the chat shell's `EventDetail` and `MessageList`
 * components were built against the agex-py shape — `kind: 'python' |
 * 'terminal' | 'file_write' | 'file_edit' | 'text' | 'thinking'`,
 * snake-cased fields like `match_all`, and a `'turn_complete'` marker
 * for live streaming. agex-ts uses a typed `Emission` union with
 * camelCase fields and a `'emission'`-with-`done: true` boundary for
 * streaming. Translating at the adapter boundary keeps the shell
 * unchanged and keeps the agex-ts shape strictly typed at its own
 * boundary.
 *
 * Caveat: the py "canonical" shape isn't a typed contract — it's
 * whatever `_post_token` happened to send from ad-hoc Python in
 * agent.js heredocs. We're picking minimum-churn here, not
 * conceptually-cleanest. A future unification pass might invert
 * this and make the agex-ts `TokenChunk` / `Emission` types the
 * canonical shape; this translator is the one place that would
 * change shape direction.
 *
 * One small extension to the canonical shape: `kind: 'ts'` joins
 * `kind: 'python'` so TS code emissions render with TS syntax
 * highlighting. The renderer's existing 'python' branch is reused
 * for layout; only the highlighter dispatch differs.
 */

const _NL = "\n";
const _NL2 = "\n\n";

/**
 * Translate one agex-ts `Emission` into a per-emission dict the shell
 * renderer consumes (`EventDetail.svelte` iterates over
 * `evt.emissions` and switches on `kind`). Mirrors the py-side
 * `_serialize_emission` field-for-field, except `kind: 'ts'` for
 * TypeScript code emissions (where py would emit `kind: 'python'`).
 *
 * @param {object} em - agex-ts Emission union member
 * @param {number} idx - position within the parent ActionEvent's
 *   `emissions` list. Used as a stable key in the renderer.
 * @returns {object | null} per-emission dict, or null for unrecognized
 *   types (shouldn't happen with current Emission union, but defensive
 *   so a future emission variant doesn't crash the renderer).
 */
export function serializeEmission(em, idx) {
    if (!em || typeof em !== "object") return null;
    switch (em.type) {
        case "ts":
            return {
                kind: "ts",
                idx,
                code: em.code || "",
                title: em.title || "",
                thinking: em.thinking || "",
            };
        case "terminal":
            return {
                kind: "terminal",
                idx,
                commands: em.commands || "",
                title: em.title || "",
                thinking: em.thinking || "",
            };
        case "fileWrite":
            return {
                kind: "file_write",
                idx,
                path: em.path,
                content: em.content,
                mode: em.mode,
            };
        case "fileEdit":
            return {
                kind: "file_edit",
                idx,
                path: em.path,
                search: em.search,
                content: em.content,
                match_all: !!em.matchAll,
            };
        case "text":
            return { kind: "text", idx, text: em.text || "" };
        case "thinking":
            return {
                kind: "thinking",
                idx,
                text: em.text || "",
                redacted: !!em.redacted,
            };
        default:
            return null;
    }
}

/**
 * Translate an agex-ts `ActionEvent` into the shell's `'action'`
 * event dict. Mirrors the py-side `_synthesize_action` field-for-field.
 *
 * `title` is taken from the first ts/terminal emission with a title —
 * matches the py behavior. `report` joins TextEmission text bodies
 * with blank lines (the chat shell surfaces this as an inline agent
 * message above the event card).
 *
 * @param {object} actionEvent - agex-ts ActionEvent
 * @returns {object} `{ type: 'action', title, report, emissions, ... }`
 */
export function synthesizeAction(actionEvent) {
    const emissions = actionEvent?.emissions || [];
    const titles = [];
    const reportBits = [];
    const emissionDicts = [];
    for (let idx = 0; idx < emissions.length; idx++) {
        const em = emissions[idx];
        const ed = serializeEmission(em, idx);
        if (ed !== null) emissionDicts.push(ed);
        if (em && (em.type === "ts" || em.type === "terminal")) {
            if (em.title) titles.push(em.title);
        } else if (em && em.type === "text") {
            if (em.text) reportBits.push(em.text);
        }
    }
    return {
        type: "action",
        title: titles[0] || "",
        report: reportBits.join(_NL2),
        emissions: emissionDicts,
        input_tokens: actionEvent?.inputTokens,
        output_tokens: actionEvent?.outputTokens,
    };
}

/**
 * Translate an agex-ts `OutputEvent`'s parts into the shell's
 * `{ type, content }` part shape. Three input variants:
 *
 *   - `{ type: 'text', text }` — flat text (e.g. stdout from a
 *     terminal command, console.log output from a ts emission).
 *   - `{ type: 'image', format, data, altText? }` — image bytes
 *     base64-encoded; shell's `<img>` template adds the `data:` prefix.
 *   - `{ type: 'error', errorName, errorMessage }` — runtime error
 *     raised by the agent's emitted code. The agent loop attaches
 *     this part on the failing emission's OutputEvent and continues
 *     with the next iteration so the agent can self-correct (per
 *     agex-ts e9e110a — "Agent-code errors are recoverable now").
 *     We render the same `<errorName>: <errorMessage>` text the LLM
 *     sees in its context, so the activity log mirrors the agent's
 *     view of the failure.
 *
 * @param {object} outputEvent - agex-ts OutputEvent
 * @returns {Array<object>} list of `{ type: 'text' | 'image' | 'error', ... }`
 *   parts ready for `splitOutputEvents` to wrap.
 */
export function serializeOutputParts(outputEvent) {
    const parts = [];
    for (const p of outputEvent?.parts || []) {
        if (!p) continue;
        if (p.type === "text") {
            parts.push({ type: "text", content: p.text ?? "" });
        } else if (p.type === "image") {
            parts.push({
                type: "image",
                data: p.data ?? "",
                ...(p.format ? { format: p.format } : {}),
                ...(p.altText ? { altText: p.altText } : {}),
            });
        } else if (p.type === "error") {
            const name = p.errorName || "";
            const msg = p.errorMessage || "";
            const content = name ? `${name}: ${msg}` : msg;
            parts.push({ type: "error", content });
        }
    }
    return parts;
}

/**
 * Wrap serialized parts into the shell's `'output'` / `'error'`
 * event dicts. Mirrors the py-side `_split_output_events` —
 * non-error parts land in a single `'output'` event, error parts
 * land in a separate `'error'` event so the renderer can style
 * them distinctly (`error-card` border in EventDetail).
 *
 * Both events fire when an OutputEvent contains a mix (e.g. some
 * stdout was printed before the throw); the `'output'` event renders
 * first, then the `'error'` event below it. Always returns at least
 * one event so empty OutputEvents still produce a stable list shape.
 *
 * @param {Array<object>} parts - output of `serializeOutputParts`
 * @returns {Array<object>} list of one or more event dicts
 */
export function splitOutputEvents(parts) {
    const outParts = parts.filter((p) => p.type !== "error");
    const errParts = parts.filter((p) => p.type === "error");
    const result = [];
    if (outParts.length > 0) {
        result.push({
            type: "output",
            message: outParts.map((p) => p.content || "").join(_NL),
            parts: outParts,
        });
    }
    if (errParts.length > 0) {
        result.push({
            type: "error",
            message: errParts.map((p) => p.content || "").join(_NL),
            parts: errParts,
        });
    }
    if (result.length === 0) {
        result.push({ type: "output", message: "", parts });
    }
    return result;
}

// ---------------------------------------------------------------------------
// Live token translation
// ---------------------------------------------------------------------------

/**
 * Translate a single agex-ts `TokenChunk` into zero or more shell-shape
 * tokens. Stateful at one specific point: the shell's `'report'` token
 * carries a `start: true` flag on the *first* chunk per emission index;
 * agex-ts has no equivalent flag (the first chunk is just the first
 * chunk), so we track which emission indexes have already started a
 * report and synthesize the flag accordingly. The state is held in the
 * caller-provided `state` object (a small `Set`).
 *
 * Token-type mapping:
 *   - `title` → `title` (camelCase → snake_case is a no-op here)
 *   - `thinking` → `thinking`
 *   - `text` → `report` (with the synthetic `start` flag)
 *   - `ts` → `ts` (a small extension to the shell's token-type vocabulary;
 *     parallels the `kind: 'ts'` extension in the per-emission shape so
 *     code emissions render with TypeScript syntax highlighting)
 *   - `terminal` → `terminal`
 *   - `filePath` → `file_path`
 *   - `fileSearch` → `file_search`
 *   - `fileContent` → `file_content`
 *   - `emission` → dropped (per-emission boundary; the shell doesn't use
 *     these — turn boundaries fire from `onEvent` ActionEvent observation
 *     instead, see `makeLiveTokenTranslator.turnComplete`)
 *   - `signature`, `toolStart` → dropped (no shell-side analog)
 *
 * @param {object} chunk - agex-ts TokenChunk
 * @param {{ reportStartedFor: Set<number> }} state - caller-owned state
 * @returns {Array<object>} zero or more shell-shape tokens
 */
function _translateChunk(chunk, state) {
    if (!chunk || typeof chunk !== "object") return [];
    const eidx = chunk.emissionIndex ?? 0;
    const content = chunk.content ?? "";
    const done = !!chunk.done;
    switch (chunk.type) {
        case "title":
            return [{ type: "title", content, emission_index: eidx, done }];
        case "thinking":
            return [{ type: "thinking", content, emission_index: eidx, done }];
        case "text": {
            const isFirst = !state.reportStartedFor.has(eidx);
            if (isFirst) state.reportStartedFor.add(eidx);
            return [
                {
                    type: "report",
                    content,
                    emission_index: eidx,
                    start: isFirst,
                    done,
                },
            ];
        }
        case "ts":
            return [{ type: "ts", content, emission_index: eidx, done }];
        case "terminal":
            return [{ type: "terminal", content, emission_index: eidx, done }];
        case "filePath":
            return [{ type: "file_path", content, emission_index: eidx, done }];
        case "fileSearch":
            return [
                { type: "file_search", content, emission_index: eidx, done },
            ];
        case "fileContent":
            return [
                { type: "file_content", content, emission_index: eidx, done },
            ];
        // Per-emission `'emission'` boundary, opaque `'signature'` blob,
        // and the `'toolStart'` provider-internal marker have no shell
        // analog — the shell uses turn-level (`turn_complete`) boundaries
        // and renders strictly off the typed token stream.
        default:
            return [];
    }
}

/**
 * Build a stateful live-token translator for one in-flight chat turn.
 * The translator instance owns the per-emission `start`-flag tracking
 * state; create a fresh one per `sendMessage` call so state from a
 * prior message doesn't leak.
 *
 * Two methods:
 *   - `translate(chunk)` — translate one agex-ts TokenChunk into
 *     zero or more shell-shape tokens.
 *   - `turnComplete()` — emit a synthetic `'turn_complete'` token,
 *     resetting per-emission state. Call this after each ActionEvent
 *     fires through `onEvent`, since agex-ts's TokenChunk stream has
 *     no per-turn boundary marker (it carries per-emission `'emission'`
 *     done-chunks, but the shell's snapshot/flush loop is per-turn).
 *
 * @returns {{
 *   translate: (chunk: object) => Array<object>,
 *   turnComplete: () => Array<object>,
 * }}
 */
export function makeLiveTokenTranslator() {
    const state = { reportStartedFor: new Set() };
    return {
        translate(chunk) {
            return _translateChunk(chunk, state);
        },
        turnComplete() {
            state.reportStartedFor.clear();
            return [{ type: "turn_complete" }];
        },
    };
}
