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
        if (em && em.type === "text") {
            // Narration/report bodies surface as their own chat bubble
            // (the `report` field below), NOT as an activity-card
            // section. Deliberately excluded from `emissions` so
            // `EventDetail` doesn't re-render the report a second time —
            // once in the bubble, once inside the action card. `idx`
            // keys stay stable (gaps are fine; the renderer keys on
            // `em.idx`, contiguity isn't required).
            if (em.text) reportBits.push(em.text);
            continue;
        }
        if (em && (em.type === "ts" || em.type === "terminal")) {
            if (em.title) titles.push(em.title);
        }
        const ed = serializeEmission(em, idx);
        if (ed !== null) emissionDicts.push(ed);
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
// Spawn-clone serialization
// ---------------------------------------------------------------------------

/** Compact single-line summary of a spawn chip's inputs/result. Keeps a
 *  big payload from blowing out the chip. */
export function summarizeSpawnValue(value, max = 60) {
    let s;
    try {
        s = typeof value === "string" ? value : JSON.stringify(value);
    } catch {
        s = String(value);
    }
    if (s === undefined) s = "";
    s = s.replace(/\s+/g, " ");
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** Full-fidelity text of a spawn input/result value for the chip's
 *  drill-down view — pretty-printed JSON for structured values, the
 *  string itself otherwise. No truncation (the detail view scrolls). */
export function spawnValueText(value) {
    if (typeof value === "string") return value;
    if (value === undefined) return "";
    try {
        return JSON.stringify(value, null, 2) ?? "";
    } catch {
        return String(value);
    }
}

/**
 * Translate a clone's `ActionEvent` into the shell's `'action'` shape
 * for the spawn drill-down. Unlike `synthesizeAction` (parent chat
 * turns), text emissions stay inline in the emissions list — a clone
 * has no chat bubble to surface narration in, so the drill-down's
 * action card renders it as a Report section instead of dropping it.
 *
 * @param {object} actionEvent - agex-ts ActionEvent (clone-tagged)
 * @returns {object} `{ type: 'action', title, emissions }`
 */
export function serializeSpawnActionEvent(actionEvent) {
    const emissions = actionEvent?.emissions || [];
    const titles = [];
    const emissionDicts = [];
    for (let idx = 0; idx < emissions.length; idx++) {
        const em = emissions[idx];
        if (em && (em.type === "ts" || em.type === "terminal") && em.title) {
            titles.push(em.title);
        }
        const ed = serializeEmission(em, idx);
        if (ed !== null) emissionDicts.push(ed);
    }
    return { type: "action", title: titles[0] || "", emissions: emissionDicts };
}

/** Epoch millis from an agex-ts event timestamp (Date or ISO string),
 *  or null when absent/unparseable. */
function _eventMs(value) {
    if (value == null) return null;
    const d = value instanceof Date ? value : new Date(value);
    const t = d.getTime();
    return Number.isNaN(t) ? null : t;
}

/**
 * Reconstruct spawn chips (the shell's `'spawn'` event dicts, including
 * the drill-down `events` timeline) from a terminal event's captured
 * `spawnEvents` field (agex-ts >= 0.4.0 with `captureSpawnEvents` on).
 *
 * Mirrors what the live demux path in `ts-kernel-adapter.js` builds
 * incrementally from streamed clone events, so a reloaded session shows
 * the same chips the live turn did. A clone bucket with no terminal
 * event (parent cancelled mid-spawn) reconstructs as `cancelled` —
 * nothing is still running on reload.
 *
 * @param {ReadonlyArray<{spawnIndex: number, events: ReadonlyArray<object>}>} spawnEvents
 * @returns {Array<object>} shell-shape `'spawn'` chip dicts
 */
export function serializeSpawnChips(spawnEvents) {
    const chips = [];
    for (const entry of spawnEvents || []) {
        if (!entry || typeof entry !== "object") continue;
        let inputsSummary = "";
        let inputs;
        let status = "cancelled";
        let steps = 0;
        let resultSummary;
        let result;
        let error;
        let startMs = null;
        let endMs = null;
        /** @type {Array<object>} */
        const detail = [];
        for (const e of entry.events || []) {
            const t = e && typeof e === "object" ? e.type : null;
            const ev = /** @type {any} */ (e);
            if (t === "taskStart") {
                inputsSummary = summarizeSpawnValue(ev.inputs);
                inputs = spawnValueText(ev.inputs);
                startMs = _eventMs(ev.timestamp);
            } else if (t === "action") {
                steps += 1;
                const action = serializeSpawnActionEvent(ev);
                if (action.emissions.length) detail.push(action);
            } else if (t === "output") {
                const parts = serializeOutputParts(ev);
                detail.push(...splitOutputEvents(parts));
            } else if (t === "success") {
                status = "success";
                resultSummary = summarizeSpawnValue(ev.result);
                result = spawnValueText(ev.result);
                endMs = _eventMs(ev.timestamp);
            } else if (t === "fail") {
                status = "fail";
                error = ev.message;
                endMs = _eventMs(ev.timestamp);
            } else if (t === "cancelled") {
                status = "cancelled";
                endMs = _eventMs(ev.timestamp);
            }
        }
        chips.push({
            type: "spawn",
            id: String(entry.spawnIndex),
            inputsSummary,
            inputs,
            status,
            steps,
            durationMs:
                startMs !== null && endMs !== null
                    ? Math.max(0, endMs - startMs)
                    : undefined,
            resultSummary,
            result,
            error,
            events: detail,
        });
    }
    return chips;
}

// ---------------------------------------------------------------------------
// Chapter-event serialization
// ---------------------------------------------------------------------------

/**
 * Recursively serialize the raw events nested inside a `ChapterEvent`
 * into the synthetic-event-dict shape `ChapterModal` consumes via
 * `groupEventsForChat`. Mirrors py-side `_serialize_chapter_events`
 * (`public/python/event_serialization.py:233`) field-for-field.
 *
 * The TS `EventLog` doesn't hand raw resolved events for free — the
 * `iter()` walk substitutes ChapterEvents in place. So we resolve
 * `chapterEvent.eventRefs` via the caller-provided `resolveByKey`
 * callback (agex-ts >= 611bb4b exposes `EventLog.byKey(stateKey)`),
 * then recursively serialize the resolved list.
 *
 * Why a callback rather than a direct `EventLog` arg: keeps this
 * helper boundary-free (no agex-ts import in the translator) and
 * makes the recursion unit-testable with a Map-backed stub.
 *
 * @param {ReadonlyArray<string>} eventRefs - state keys to resolve
 *   (typically a `ChapterEvent`'s `eventRefs` array)
 * @param {(stateKey: string) => Promise<object | null>} resolveByKey
 * @param {(value: any) => {type: 'text'|'response', content?: string, parts?: any[]}} normalizeResult
 *   - normalizer for non-chapter task success results, matching the
 *     shape `MessageList` agent bubbles use. Pass `normalizeChatResponse`
 *     from `ts-chat-response.js`.
 * @returns {Promise<Array<object>>}
 */
export async function serializeChapterEvents(
    eventRefs,
    resolveByKey,
    normalizeResult,
) {
    const events = [];
    for (const key of eventRefs) {
        const e = await resolveByKey(key);
        if (e) events.push(e);
    }
    return _walkChapterEvents(events, resolveByKey, normalizeResult);
}

async function _walkChapterEvents(eventsList, resolveByKey, normalizeResult) {
    /** @type {Array<object>} */
    const result = [];
    /** `unassigned` mirrors py's same-named queue: ChapterEvents we've
     *  pushed as standalone `{type:'chapter'}` entries that the next
     *  `__chapter__` SuccessEvent will pull into the most-recent open
     *  `{type:'chaptering'}` band. Order-preserving FIFO. */
    /** @type {Array<object>} */
    const unassigned = [];
    let curTask = null;
    for (const evt of eventsList) {
        const t = evt && typeof evt === "object" ? evt.type : null;
        if (t === "action") {
            result.push(synthesizeAction(evt));
        } else if (t === "output") {
            const parts = serializeOutputParts(evt);
            for (const out of splitOutputEvents(parts)) result.push(out);
        } else if (t === "chapter") {
            const ce = /** @type {any} */ (evt);
            // Recurse into this nested chapter's own eventRefs to
            // serialize its inner events. Without this the drill-down
            // bottoms out at the first nested fold (modal would render
            // an empty `events: []` for any inner chapter).
            const innerEvents = await serializeChapterEvents(
                ce.eventRefs || [],
                resolveByKey,
                normalizeResult,
            );
            const item = {
                type: "chapter",
                name: ce.name,
                message: ce.message,
                events: innerEvents,
            };
            result.push(item);
            unassigned.push(item);
        } else if (t === "taskStart") {
            const ts = /** @type {any} */ (evt);
            curTask = ts.taskName ?? null;
            if (curTask === "__chapter__") {
                result.push({ type: "chaptering", chapters: [] });
            } else {
                const inputs = ts.inputs;
                const msg =
                    typeof inputs === "string"
                        ? inputs
                        : inputs && typeof inputs === "object" && "message" in inputs
                          ? String(inputs.message ?? "")
                          : String(inputs ?? "");
                result.push({ type: "task_start", message: msg });
            }
        } else if (t === "success") {
            const se = /** @type {any} */ (evt);
            if (curTask === "__chapter__") {
                const r = se.result;
                let n = 0;
                if (Array.isArray(r)) {
                    for (const ch of r) {
                        if (ch && typeof ch === "object" && "name" in ch) n++;
                    }
                }
                const take = Math.min(n, unassigned.length);
                if (take > 0) {
                    // Walk backward to find the most-recent open
                    // `chaptering` entry — same shape as py's
                    // `for _bm in reversed(_messages)` loop.
                    for (let i = result.length - 1; i >= 0; i--) {
                        const bm = result[i];
                        if (bm && bm.type === "chaptering") {
                            bm.chapters = unassigned.slice(0, take).map((uc) => ({
                                name: uc.name,
                                message: uc.message,
                                events: uc.events || [],
                            }));
                            break;
                        }
                    }
                    unassigned.splice(0, take);
                }
                curTask = null;
            } else {
                // Spawn chips ride the terminal event's captured
                // `spawnEvents` — push them BEFORE the success entry so
                // they group into the same activity block as the task's
                // actions (groupEventsForChat flushes on success).
                if (Array.isArray(se.spawnEvents) && se.spawnEvents.length) {
                    result.push(...serializeSpawnChips(se.spawnEvents));
                }
                result.push({
                    type: "success",
                    result: normalizeResult(se.result),
                });
                curTask = null;
            }
        }
        // Other event types (fail, cancelled, file) intentionally
        // omitted to match py's `_serialize_chapter_events` shape.
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
