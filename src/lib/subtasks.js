/**
 * Sub-tasks for the TS kernel — `defineTask` / `invokeTask`.
 *
 * A sub-task is a named, primed agex-ts task that runs in its OWN
 * sub-Agent on its OWN `workerRuntime`, sharing only the parent's
 * `llm` instance. `defineTask` registers a spec (returning a string
 * handle — the name); `invokeTask` spawns a fresh sub-Agent for that
 * spec, runs it once, records the invocation, and disposes the
 * sub-Agent. Separate runtimes ⇒ genuine parallelism (the per-runtime
 * `activeExecute` guard only serializes within a single worker), so
 * `Promise.all([invokeTask(a), invokeTask(b)])` runs on separate
 * worker threads.
 *
 * This module is the kernel-agnostic core, dependency-injected via
 * `createSubtaskManager(deps)` so the orchestration is unit-testable
 * with a stubbed `createAgent` / LLM. `ts-agent.js` wires it to the
 * real agex-ts surface; the iframe bridge reuses the same manager.
 *
 * Design: ../../roadmap/subagents.md (v1). Two corrections from the
 * 2026-05-30 audit are load-bearing here:
 *   - sub-Agent `state` is `{ type: 'live' }` (NOT `'memory'`, which
 *     isn't a valid StateConfig). `live` is the ephemeral in-process
 *     map — no persistence, isolated per invocation.
 *   - invocation records live in studio state (`__subtask_invocations__`),
 *     NOT as a foreign event type in the agex-ts EventLog. They're
 *     decoupled from agex-ts's closed AgentEvent union, invisible to
 *     the LLM conversation, and undo-for-free via kvgit `resetTo`.
 */

/** kvgit state key holding the per-branch sub-task registry blob. */
export const STATE_KEY_SPECS = "__subtasks__";
/** kvgit state key holding the per-branch invocation-record list. */
export const STATE_KEY_INVOCATIONS = "__subtask_invocations__";

/** agex-ts framework default; sub-tasks fan out and don't build apps,
 *  so they don't inherit the chat agent's bumped 40. */
const DEFAULT_SUB_MAX_ITERATIONS = 10;

/** Per-emission wall-clock budget for a sub-agent's worker. Generous
 *  enough for a multi-step reasoning turn + a `search`, tight enough
 *  to bound a runaway. */
const SUB_TIMEOUT_MS = 30_000;

/** Keep the invocation list (chips) bounded. A user driving a game-
 *  style app from the iframe doesn't record (record:false), but a
 *  long chat session with many parent-initiated delegations shouldn't
 *  grow this unboundedly either. Oldest records drop first. */
const MAX_INVOCATION_RECORDS = 200;

/** Per-page-session cap on IFRAME-initiated invocations. Trust/cost
 *  guard (audit issue #2): an embedded app — possibly imported, not
 *  authored by the person running it — can drive real LLM spend. This
 *  is the concrete guard v1 ships; the cap is per page load, not
 *  persisted. Parent-initiated (worker-side) calls are uncapped — the
 *  user drives those directly via chat. */
const IFRAME_INVOCATION_CAP = 200;

import { standardSchemaFromJsonSchema } from "./json-schema.js";

/** Cap a value's chip summary so a big args/result payload can't blow
 *  out the activity panel. Returns a short single-line string. */
export function summarizeValue(value, max = 80) {
    let s;
    try {
        s = typeof value === "string" ? value : JSON.stringify(value);
    } catch {
        s = String(value);
    }
    if (s === undefined) s = "undefined";
    s = s.replace(/\s+/g, " ");
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/**
 * Map invocation records whose timestamp falls within `[startMs, endMs]`
 * to `subtask` event dicts (chip shape), sorted chronologically. Pure
 * — used by `loadHistory` to interleave chips into a turn's event card,
 * and unit-tested directly.
 *
 * @param {ReadonlyArray<Object>} invocations
 * @param {number} startMs - lower bound (inclusive); -Infinity for open
 * @param {number} endMs   - upper bound (inclusive); +Infinity for open
 * @returns {Array<Object>}
 */
export function subtaskEventsInWindow(invocations, startMs, endMs) {
    const out = [];
    for (const r of invocations) {
        const t = _ms(r && r.timestamp);
        if (t >= startMs && t <= endMs) out.push(r);
    }
    out.sort((a, b) => _ms(a.timestamp) - _ms(b.timestamp));
    return out.map((r) => ({ type: "subtask", ...r }));
}

function _ms(ts) {
    if (typeof ts === "number") return ts;
    if (typeof ts === "string") {
        const n = Date.parse(ts);
        return Number.isNaN(n) ? 0 : n;
    }
    return 0;
}

/**
 * Construct a sub-task manager.
 *
 * @param {Object} deps
 * @param {Function} deps.createAgent - agex-ts `createAgent`.
 * @param {Function} deps.workerRuntime - `@agex-ts/runtime-worker` factory.
 * @param {string|URL} deps.workerUrl - the same bundled worker URL the
 *   chat agent uses (reusable across runtimes).
 * @param {() => any} deps.getLlm - returns the parent's live LLMClient.
 * @param {(subAgent: any) => void} [deps.registerSubAgentFns] - registers
 *   the curated host-fn set (e.g. `search`) on a fresh sub-Agent.
 * @param {(key: string) => Promise<unknown>} deps.readState - read a
 *   persisted state blob for the current branch.
 * @param {(key: string, value: unknown) => void|Promise<void>} deps.writeState
 *   - buffer a state write for the current branch (committed by the
 *   host at turn end).
 * @param {() => number} [deps.getParentMaxIterations] - the parent
 *   agent's current maxIterations, resolved when a sub-task opts into
 *   `maxIterations: 'inherit'`.
 * @param {(info: {id: string, name: string, argsSummary: string}) => void} [deps.onInvocationStart]
 *   - fired when a recorded (parent-initiated) invocation begins, before
 *   the sub-agent spawns. Lets the host render a live "running" chip.
 * @param {(info: {id: string, record: Object}) => void} [deps.onInvocationComplete]
 *   - fired when a recorded invocation finishes (success/fail/cancel),
 *   carrying the same record that was persisted. Resolves the live chip.
 * @param {() => number} [deps.now] - clock (ms). Injectable for tests.
 */
export function createSubtaskManager(deps) {
    const {
        createAgent,
        workerRuntime,
        workerUrl,
        getLlm,
        registerSubAgentFns,
        readState,
        writeState,
        getParentMaxIterations,
        onInvocationStart,
        onInvocationComplete,
        now = () => Date.now(),
    } = deps;

    /** @type {Map<string, Object>} in-host registry — runtime source of truth. */
    const specs = new Map();
    /** @type {Array<Object>} invocation records (chips). */
    let invocations = [];
    /** Monotonic counter for auto-generated names. */
    let autoCounter = 0;
    /** IFRAME-initiated invocation count for this page session. */
    let iframeInvocations = 0;
    /** Monotonic id for matching a live invocation's start → complete. */
    let invSeq = 0;

    function _persistSpecs() {
        /** @type {Record<string, Object>} */
        const blob = {};
        for (const [k, v] of specs) blob[k] = v;
        return writeState(STATE_KEY_SPECS, blob);
    }

    function _recordInvocation(rec) {
        invocations.push(rec);
        if (invocations.length > MAX_INVOCATION_RECORDS) {
            invocations = invocations.slice(-MAX_INVOCATION_RECORDS);
        }
        return writeState(STATE_KEY_INVOCATIONS, invocations);
    }

    /**
     * Register (or update) a sub-task spec. Returns the name handle.
     * Validates required fields; auto-generates a name when omitted.
     *
     * @param {Object} spec
     * @returns {Promise<string>}
     */
    async function defineTask(spec) {
        if (!spec || typeof spec !== "object") {
            throw new Error("defineTask: a spec object is required.");
        }
        if (typeof spec.primer !== "string" || spec.primer.trim() === "") {
            throw new Error(
                "defineTask: `primer` (non-empty string) is required — it's the sub-agent's system prompt + task framing.",
            );
        }
        if (typeof spec.description !== "string" || spec.description.trim() === "") {
            throw new Error("defineTask: `description` (non-empty string) is required.");
        }
        if (spec.name !== undefined && typeof spec.name !== "string") {
            throw new Error("defineTask: `name`, when given, must be a string.");
        }
        let name = spec.name;
        if (!name) {
            do {
                name = `subtask:${++autoCounter}`;
            } while (specs.has(name));
        }
        // `maxIterations` accepts a positive integer, the string
        // 'inherit' (use the parent agent's value at invoke time), or
        // is omitted (default 10). Anything else is dropped.
        let maxIterations;
        if (spec.maxIterations === "inherit") {
            maxIterations = "inherit";
        } else if (Number.isInteger(spec.maxIterations) && spec.maxIterations > 0) {
            maxIterations = spec.maxIterations;
        } else {
            maxIterations = undefined;
        }
        // `output` is either a prose description (string) or a JSON
        // Schema (plain object) — both are plain data, so they survive
        // the worker→host structured-clone. A JSON Schema is validated
        // at runtime (the sub-agent retries on mismatch); prose is
        // shown to the sub-agent but not enforced.
        let output;
        if (spec.output !== undefined) {
            if (typeof spec.output === "string") {
                output = spec.output;
            } else if (
                spec.output &&
                typeof spec.output === "object" &&
                !Array.isArray(spec.output)
            ) {
                output = spec.output;
            } else {
                throw new Error(
                    "defineTask: `output` must be a prose string or a JSON Schema object.",
                );
            }
        }
        /** @type {Object} */
        const stored = {
            primer: spec.primer,
            description: spec.description,
        };
        if (typeof spec.inputs === "string") stored.inputs = spec.inputs;
        if (output !== undefined) stored.output = output;
        if (maxIterations !== undefined) stored.maxIterations = maxIterations;
        specs.set(name, stored);
        await _persistSpecs();
        return name;
    }

    /**
     * Spawn a fresh sub-Agent for `name`, run it once with `args`, and
     * return its result. Records the invocation (chip) unless
     * `opts.record === false` (the iframe-initiated path, which is app
     * runtime — not chat narrative).
     *
     * @param {string} name
     * @param {unknown} args
     * @param {Object} [opts]
     * @param {AbortSignal} [opts.signal]
     * @param {boolean} [opts.record=true]
     * @param {'worker'|'iframe'} [opts.source='worker']
     * @returns {Promise<unknown>}
     */
    async function invokeTask(name, args, opts = {}) {
        const spec = specs.get(name);
        if (!spec) {
            throw new Error(
                `invokeTask: no sub-task named "${name}". Define it first with defineTask({ name: "${name}", primer, description }).`,
            );
        }
        const record = opts.record !== false;
        const source = opts.source === "iframe" ? "iframe" : "worker";
        const signal = opts.signal;

        if (source === "iframe") {
            iframeInvocations += 1;
            if (iframeInvocations > IFRAME_INVOCATION_CAP) {
                throw new Error(
                    `invokeTask: this app has reached the per-session limit of ${IFRAME_INVOCATION_CAP} AI calls. Reload to reset.`,
                );
            }
        }

        let argsJson;
        try {
            argsJson = JSON.stringify(args ?? null);
        } catch (e) {
            throw new Error(
                `invokeTask: args for "${name}" are not JSON-serializable (${e.message}). Trim or restructure before passing.`,
            );
        }

        // Live "running" chip — fire before the (slow) sub-agent spawn
        // so the user sees the delegation immediately. Recorded
        // (parent-initiated) calls only; iframe calls aren't chat
        // narrative. `liveId` matches this start to its completion.
        const liveId = `${name}#${++invSeq}`;
        if (record && onInvocationStart) {
            onInvocationStart({ id: liveId, name, argsSummary: summarizeValue(args) });
        }

        // Resolve the iteration budget: an explicit number wins;
        // 'inherit' pulls the parent agent's current value; otherwise
        // the sub-task default (10 — fan-out workers don't need the
        // chat agent's bumped budget unless they opt in).
        let maxIterations;
        if (spec.maxIterations === "inherit") {
            maxIterations =
                (getParentMaxIterations && getParentMaxIterations()) ||
                DEFAULT_SUB_MAX_ITERATIONS;
        } else {
            maxIterations = spec.maxIterations ?? DEFAULT_SUB_MAX_ITERATIONS;
        }

        const llm = getLlm();
        const subRuntime = workerRuntime({ workerUrl, timeoutMs: SUB_TIMEOUT_MS });
        const subAgent = await createAgent({
            name,
            // Agent-level primer (sub-agent's combined system prompt +
            // task framing). The BUILTIN_PRIMER still applies — it
            // teaches eval semantics / taskSuccess shape; don't override.
            primer: spec.primer,
            llm,
            runtime: subRuntime,
            // Ephemeral, not persisted. `live` is the in-process map;
            // `memory` is NOT a valid StateConfig (audit fix).
            state: { type: "live" },
            // Private, isolated fs — cannot see or touch the parent's VFS.
            fs: { type: "memory" },
            maxIterations,
        });
        try {
            if (registerSubAgentFns) registerSubAgentFns(subAgent);
            // Output contract. A JSON-Schema `output` becomes a validating
            // Standard Schema (sub-agent retries on a bad shape) and is also
            // passed as `outputJsonSchema` so the sub-agent sees the shape
            // in its prompt. A prose `output` is descriptive only.
            /** @type {Object} */
            const taskDef = { description: spec.description };
            if (typeof spec.output === "string") {
                taskDef.outputDescription = spec.output;
            } else if (spec.output && typeof spec.output === "object") {
                taskDef.output = standardSchemaFromJsonSchema(spec.output);
                taskDef.outputJsonSchema = spec.output;
            }
            const subTask = subAgent.task(taskDef);

            let iterations = 0;
            const onEvent = (e) => {
                if (e && e.type === "action") iterations += 1;
            };

            const startedAt = now();
            let status = "success";
            let error;
            let result;
            try {
                result = await subTask(argsJson, { signal, onEvent });
                return result;
            } catch (e) {
                status = _classifyFailure(e, signal);
                error = e && e.message ? e.message : String(e);
                throw e;
            } finally {
                if (record) {
                    const rec = {
                        name,
                        args: _safeClone(args),
                        argsSummary: summarizeValue(args),
                        resultSummary:
                            status === "success" ? summarizeValue(result) : undefined,
                        status,
                        error,
                        iterations,
                        durationMs: Math.max(0, Math.round(now() - startedAt)),
                        timestamp: new Date(now()).toISOString(),
                        agentName: "chat",
                    };
                    await _recordInvocation(rec);
                    // Resolve the live chip with the same record we persisted,
                    // so the live view and the post-reload view match exactly.
                    if (onInvocationComplete) onInvocationComplete({ id: liveId, record: rec });
                }
            }
        } finally {
            // Guarantee teardown even if setup (registerSubAgentFns /
            // subAgent.task) throws before the run begins — otherwise the
            // worker spawned by createAgent would leak.
            try {
                await subAgent.dispose();
            } catch {
                // Best-effort teardown — a failed dispose shouldn't mask
                // the task result/error the caller actually cares about.
            }
        }
    }

    /**
     * Repopulate the in-host registry + invocation list from persisted
     * state for the current branch. Called by `loadHistory` on load /
     * branch switch. Resets first so a branch switch doesn't leak the
     * previous branch's specs.
     */
    async function rehydrate() {
        // Read first, THEN swap in synchronously. Clearing before the
        // awaited reads would leave `specs` empty across the await — an
        // iframe-initiated invokeTask landing in that gap would miss a
        // defined sub-task. Reading first also means a failed read keeps
        // the prior registry intact rather than wiping it.
        const blob = await readState(STATE_KEY_SPECS);
        const inv = await readState(STATE_KEY_INVOCATIONS);
        specs.clear();
        invocations = [];
        // autoCounter resets per branch — the auto-name loop in
        // defineTask skips any rehydrated names, so collisions can't
        // happen even from 0. `iframeInvocations` is deliberately NOT
        // reset here: it's a per-page-session cost guard, and rehydrate
        // fires on every load / session-switch / undo / chaptering — so
        // resetting it would let ordinary chat navigation clear the cap.
        autoCounter = 0;
        if (blob && typeof blob === "object") {
            for (const [k, v] of Object.entries(blob)) {
                if (v && typeof v === "object") specs.set(k, v);
            }
        }
        if (Array.isArray(inv)) invocations = inv;
    }

    /** Snapshot of the current invocation records (for chip interleaving). */
    function getInvocations() {
        return invocations.slice();
    }

    /** Whether a sub-task name is defined (iframe-side preflight). */
    function has(name) {
        return specs.has(name);
    }

    return {
        defineTask,
        invokeTask,
        rehydrate,
        getInvocations,
        has,
        /** Test/debug seam. */
        _specs: specs,
    };
}

/** Map a thrown error to a chip status. agex-ts throws `TaskFailError`
 *  on maxIterations exhaustion / explicit fail; an aborted signal (or a
 *  cancellation-shaped error) reads as `cancelled`. */
function _classifyFailure(e, signal) {
    if (signal && signal.aborted) return "cancelled";
    const name = e && e.name ? e.name : "";
    const msg = e && e.message ? e.message : "";
    if (name === "TaskCancelledError" || /cancel|abort/i.test(msg)) {
        return "cancelled";
    }
    return "fail";
}

/** Best-effort structured-clone of args for the chip record. Falls
 *  back to the summary string if the value isn't cloneable. */
function _safeClone(value) {
    try {
        return JSON.parse(JSON.stringify(value ?? null));
    } catch {
        return summarizeValue(value);
    }
}
