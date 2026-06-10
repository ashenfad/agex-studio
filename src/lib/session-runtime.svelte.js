/**
 * Per-session chat runtime — the conversation + streaming state and the
 * agent run loop, lifted out of `ChatShell.svelte` so a session's state
 * survives the foreground view switching away from it.
 *
 * Concurrent-sessions work (see `roadmap/concurrent-sessions.md`). One
 * `SessionRuntime` per branch holds what used to be `ChatShell`'s
 * component-local `$state` (messages, busy, the streaming accumulators,
 * …) and the methods that mutate it (`send`, `handleToken`,
 * `snapshotTurn`, …). `ChatShell` is a projection of the foreground
 * session's runtime.
 *
 * With Phase 2 landed, each session is its own agex-ts agent + worker
 * over a shared kvgit store (a branch per session), so turns on
 * different sessions run concurrently — fire one, switch away, it keeps
 * streaming. `send` captures `{ adapter, branch }` once at the top (the
 * runtime is foreground when you hit send) and uses that captured branch
 * for every call in the turn — including the post-turn
 * `persistSessionMeta(title, branch)` — so a turn that finishes after a
 * foreground switch still lands on the session it ran on. The other
 * methods (undo / chapter / upload …) are synchronous foreground
 * actions, so `getActiveAdapter()` correctly resolves to this runtime.
 */

import { get } from "svelte/store";
import { getActiveAdapter } from "./active-adapter.js";
import { interleaveSpawnChips } from "./event-utils.js";
import { loadHistoryChunked, persistSessionMeta, sessionStore } from "./sessions.js";
import { cancelTask } from "./pyodide.js";
import { notifyTurnComplete } from "./notify.js";
import { isOnScreen } from "./presence.js";

/** Live registry of per-branch runtimes. A runtime is created lazily on
 *  first access for a branch and kept for the page's lifetime so its
 *  conversation + in-flight state persist across foreground switches.
 *
 *  A plain `Map` on purpose: `getSessionRuntime` runs inside ChatShell's
 *  `$derived(getSessionRuntime(currentBranch))`, and a reactive map's
 *  `.set` there trips Svelte's `state_unsafe_mutation`. The drawer's
 *  status indicators don't need membership reactivity — a session can
 *  only be working/unseen if it was foreground when its turn started, so
 *  its runtime already exists when the drawer reads it; the live updates
 *  come from each runtime's `busy` / `unseen` $state, which are reactive
 *  on the (stable) instance regardless of the map. */
const _registry = new Map();

/** Get (or lazily create) the runtime for `branch`. */
export function getSessionRuntime(branch) {
    let rt = _registry.get(branch);
    if (!rt) {
        rt = new SessionRuntime(branch);
        _registry.set(branch, rt);
    }
    return rt;
}

/** The runtime for `branch` if one exists — WITHOUT creating it. The
 *  session drawer uses this to show per-session status (working dot /
 *  unseen badge) without spinning up runtimes for unvisited sessions. */
export function peekSessionRuntime(branch) {
    return _registry.get(branch);
}

/** Count of in-flight agent turns across all sessions. Reactive: read it
 *  in a reactive context (e.g. the wake-lock effect) to track it. */
let _activeTurns = $state(0);

/** Number of agent turns currently running across all sessions. */
export function activeTurnCount() {
    return _activeTurns;
}

// Phase 2 landed per-session working trees (each session is its own
// agent + worker over a shared store), so turns on different sessions run
// concurrently — the Phase 1 global single-flight guard is gone. Each
// runtime's own `busy` flag still guards re-entrancy on the *same*
// session.

export class SessionRuntime {
    /** @param {string} branch */
    constructor(branch) {
        this.branch = branch;
    }

    // --- Conversation state (was ChatShell component $state) ----------

    /** @type {Array<{role: string, content: any, timestamp: Date, events?: Array, commit_hash?: string}>} */
    messages = $state([]);
    busy = $state(false);
    cancelling = $state(false);
    /** True when a turn finished while this session was NOT in the
     *  foreground — drives the "unseen result" badge in the session
     *  drawer. Cleared when the session is brought to foreground (see
     *  ChatShell). */
    unseen = $state(false);
    /** AbortController for the in-flight task. The TS adapter forwards
     *  `signal` into agex-ts's task call; the py adapter ignores it and
     *  uses its own worker-side `cancelTask`. `cancel()` fires both.
     *  @type {AbortController | null} */
    activeAbort = $state(null);
    historyChunks = $state(null);
    /** Set once this runtime has been hydrated from the store. The
     *  foreground-switch effect re-hydrates only when this is false, so
     *  switching back to a running (or just-visited) session preserves
     *  its in-memory state instead of clobbering the live streaming tail
     *  with committed-only history. */
    loaded = $state(false);
    /** @type {string[]} */
    files = $state([]);
    chaptering = $state(false);
    /** @type {number[] | null} */
    tokenHistory = $state(null);
    tokenOverride = $state(null);
    inputPrefill = $state("");
    /** Undo toast: `{ preCommit, timer }` or null. */
    undoToast = $state(null);
    /** Bumped whenever a turn / undo / redo changes this session's
     *  `app/` files. The foreground view folds this into the AppPreview
     *  refresh key (a backgrounded session has no preview to refresh). */
    previewTick = $state(0);

    // --- Streaming accumulators ---------------------------------------
    //
    // Every token carries an `emission_index` (one per emission in the
    // turn: python / terminal / file_write / file_edit / text /
    // thinking). Tokens for different emissions can arrive interleaved
    // on some providers (esp. OpenAI Chat Completions), so we group
    // strictly by emission_index rather than by the older
    // "title-start means new action" heuristic which scrambled
    // multi-emission turns.
    //
    // `currentTurn`: Map of emission_index → partial block built from
    //   streaming tokens. Finalized into a single action event (with an
    //   `emissions` list preserving order) on the `turn_complete` marker.
    // `streamingEvents`: committed turns, shown in the live chat feed
    //   while subsequent turns stream.
    streamingEvents = $state([]);
    currentTurn = $state(null);
    /** Live spawn chips for the in-flight turn — one per concurrent
     *  clone, keyed by its `spawnIndex`. Each chip accumulates the
     *  clone's translated events (`events`) for the drill-down view.
     *  The live chips themselves are in-memory only — after a reload
     *  they reconstruct from the terminal event's captured
     *  `spawnEvents` (see loadHistory → serializeSpawnChips). */
    liveSpawnChips = $state([]);
    /** Report streaming accumulator — null when no TextEmission is
     *  currently building. Lifted out of `currentTurn` so the
     *  committed-chat-message flow (insert on done) stays simple. */
    activeReportText = $state(null);
    activeReportIdx = $state(null);

    // --- Streaming accumulation helpers -------------------------------

    ensureBlock = (eidx, kindHint = null) => {
        if (!this.currentTurn) {
            this.currentTurn = { blocks: {}, order: [] };
        }
        if (this.currentTurn.blocks[eidx] === undefined) {
            this.currentTurn.blocks[eidx] = {
                idx: eidx,
                kind: kindHint,
                title: "",
                thinking: "",
                code: "",
                commands: "",
                text: "",
                path: "",
                search: "",
                content: "",
                mode: "write",
                match_all: false,
                streaming: true,
            };
            this.currentTurn.order = [...this.currentTurn.order, eidx];
        } else if (kindHint && !this.currentTurn.blocks[eidx].kind) {
            this.currentTurn.blocks[eidx].kind = kindHint;
        }
        return this.currentTurn.blocks[eidx];
    };

    updateBlock = (eidx, patch) => {
        const b = this.ensureBlock(eidx);
        this.currentTurn.blocks[eidx] = { ...b, ...patch };
        // Trigger Svelte reactivity on the outer map.
        this.currentTurn = {
            ...this.currentTurn,
            blocks: { ...this.currentTurn.blocks },
        };
    };

    snapshotTurn = () => {
        if (!this.currentTurn) return null;
        const ordered = this.currentTurn.order.map(
            (i) => this.currentTurn.blocks[i],
        );
        const titles = [];
        const thinkingBits = [];
        const reportBits = [];
        const codeBits = [];
        const terminalBits = [];
        const fileActions = [];
        const emissions = [];
        for (const b of ordered) {
            // Build the emissions-list shape EventDetail prefers (so
            // per-emission rendering ordered by emission_index takes
            // over from the flat-fields fallback).
            if (b.kind === "python" || b.kind === "ts") {
                emissions.push({
                    kind: b.kind,
                    idx: b.idx,
                    code: b.code,
                    title: b.title,
                    thinking: b.thinking,
                });
                if (b.title) titles.push(b.title);
                if (b.thinking) thinkingBits.push(b.thinking);
                if (b.code) codeBits.push(b.code);
            } else if (b.kind === "terminal") {
                emissions.push({
                    kind: "terminal",
                    idx: b.idx,
                    commands: b.commands,
                    title: b.title,
                    thinking: b.thinking,
                });
                if (b.title) titles.push(b.title);
                if (b.thinking) thinkingBits.push(b.thinking);
                if (b.commands) terminalBits.push(b.commands);
            } else if (b.kind === "file_write") {
                emissions.push({
                    kind: "file_write",
                    idx: b.idx,
                    path: b.path,
                    content: b.content,
                    mode: b.mode,
                });
                fileActions.push({
                    kind: "file",
                    path: b.path || "…",
                    content: b.content,
                    mode: b.mode || "write",
                    streaming: b.streaming,
                });
            } else if (b.kind === "file_edit") {
                emissions.push({
                    kind: "file_edit",
                    idx: b.idx,
                    path: b.path,
                    search: b.search,
                    content: b.content,
                    match_all: b.match_all,
                });
                fileActions.push({
                    kind: "edit",
                    path: b.path || "…",
                    search: b.search,
                    content: b.content,
                    operation: "replace",
                    streaming: b.streaming,
                });
            } else if (b.kind === "text") {
                // Report/narration renders as its own chat bubble (live
                // via `commitActiveReport`), not inside the activity
                // card — keep it out of `emissions` so EventDetail
                // doesn't render the report twice. Mirrors
                // `synthesizeAction` on the committed/reload path.
                if (b.text) reportBits.push(b.text);
            } else if (b.kind === "thinking") {
                emissions.push({
                    kind: "thinking",
                    idx: b.idx,
                    text: b.text,
                    redacted: b.redacted,
                });
                if (b.text && !b.redacted) thinkingBits.push(b.text);
            }
        }
        const NL2 = "\n\n";
        return {
            type: "action",
            title: titles[0] || "",
            thinking: thinkingBits.join(NL2),
            report: reportBits.join(NL2),
            code: codeBits.length ? codeBits.join(NL2) : null,
            terminal: terminalBits.length ? terminalBits.join(NL2) : null,
            file_actions: fileActions,
            emissions,
        };
    };

    /** Capture an error's stack-like context for inline rendering in the
     *  error bubble's <details>. Prefers `e.stack`; falls back to
     *  `name + message` for thrown values that aren't proper Errors. */
    _captureStack = (e) => {
        if (!e) return null;
        if (
            typeof e === "object" &&
            typeof e.stack === "string" &&
            e.stack.length > 0
        ) {
            return e.stack;
        }
        if (typeof e === "object" && (e.name || e.message)) {
            return `${e.name || "Error"}: ${e.message || String(e)}`;
        }
        return String(e);
    };

    /** Commit the in-flight report text as a permanent chat bubble
     *  before any clear-state path that would discard it. Called from
     *  both the explicit `report.done` token AND the `turn_complete`
     *  fallback — agex-ts's token stream doesn't always set `done: true`
     *  on the last text chunk for a TextEmission, so relying solely on
     *  `report.done` would leave the streaming bubble accumulated but
     *  never committed. Idempotent — no-op if there's no in-flight text
     *  or it was already committed. */
    commitActiveReport = () => {
        const finalText = this.activeReportText;
        if (!finalText) return;
        const eidx = this.activeReportIdx;
        if (eidx != null) {
            this.updateBlock(eidx, { kind: "text", text: finalText });
        }
        const committedMsg = {
            role: "agent",
            content: finalText,
            isReport: true,
            timestamp: new Date(),
        };
        const insertIdx = this.messages.findIndex((m) => m.streaming);
        if (insertIdx === -1) {
            this.messages = [...this.messages, committedMsg];
        } else {
            this.messages = [
                ...this.messages.slice(0, insertIdx),
                committedMsg,
                ...this.messages.slice(insertIdx),
            ];
        }
        this.activeReportText = null;
        this.activeReportIdx = null;
    };

    handleToken = (token) => {
        // `turn_complete` is the explicit end-of-turn signal — fires
        // after each ActionEvent lands. Flushes any lingering
        // `currentTurn` into `streamingEvents` AND commits any
        // un-flushed report text into a permanent bubble.
        if (token.type === "turn_complete") {
            const snapshot = this.snapshotTurn();
            if (snapshot && snapshot.emissions.length) {
                this.streamingEvents = [...this.streamingEvents, snapshot];
            }
            this.currentTurn = null;
            this.commitActiveReport();
            this.rebuildStreamingMessages();
            return;
        }

        if (token.type === "spawn") {
            // Live delegation chip for a spawned clone. `start` appends a
            // running chip (keyed by clone index); `progress` bumps its
            // step count and/or appends drill-down detail events;
            // `end` resolves it to success/fail/cancelled.
            if (token.phase === "start") {
                this.liveSpawnChips = [
                    ...this.liveSpawnChips,
                    {
                        type: "spawn",
                        id: token.id,
                        inputsSummary: token.inputsSummary,
                        inputs: token.inputs,
                        status: "running",
                        steps: 0,
                        events: [],
                        // Live anchor: number of committed snapshots when
                        // the clone started — the chip renders right after
                        // snapshot[anchor - 1], the action that spawned it.
                        anchor: this.streamingEvents.length,
                        // Event-log clock; anchors the chip among the
                        // final message's `ts`-stamped actions.
                        startedAt: token.startedAt,
                    },
                ];
            } else {
                const mergeEvents = (c) =>
                    token.events?.length
                        ? [...(c.events || []), ...token.events]
                        : c.events || [];
                this.liveSpawnChips = this.liveSpawnChips.map((c) =>
                    c.id === token.id
                        ? token.phase === "progress"
                            ? {
                                  ...c,
                                  steps: token.steps ?? c.steps,
                                  events: mergeEvents(c),
                              }
                            : {
                                  ...c,
                                  status: token.status,
                                  steps: token.steps ?? c.steps,
                                  durationMs: token.durationMs,
                                  resultSummary: token.resultSummary,
                                  result: token.result,
                                  error: token.error,
                                  events: mergeEvents(c),
                              }
                        : c,
                );
            }
            this.rebuildStreamingMessages();
            return;
        }

        // Drop final-usage bookkeeping tokens (done=true, no content, no
        // emission_index).
        if (
            token.done &&
            !token.content &&
            token.emission_index === undefined
        ) {
            return;
        }

        const eidx = token.emission_index ?? 0;

        if (token.type === "title") {
            // Title rides on a PythonEmission or TerminalEmission — kind
            // will be confirmed when the content field streams.
            const b = this.ensureBlock(eidx);
            this.updateBlock(eidx, {
                title: (b.title || "") + (token.content || ""),
            });
        } else if (token.type === "thinking") {
            // Narration-in-schema thinking rides on python/terminal;
            // native-thinking providers emit it as its own emission (our
            // Python-side synthetic burst). Same slot either way — only
            // the kind differs.
            const b = this.ensureBlock(eidx);
            const kind = b.kind || "thinking";
            this.updateBlock(eidx, {
                kind: kind === "thinking" ? "thinking" : kind,
                thinking:
                    kind === "thinking"
                        ? b.thinking
                        : (b.thinking || "") + (token.content || ""),
                text:
                    kind === "thinking"
                        ? (b.text || "") + (token.content || "")
                        : b.text,
            });
        } else if (token.type === "report") {
            // TextEmission — streams as report tokens. Accumulates on the
            // text block and commits as a chat message on done.
            if (token.start) {
                this.activeReportText = "";
                this.activeReportIdx = eidx;
            }
            if (token.content) {
                this.activeReportText =
                    (this.activeReportText || "") + token.content;
                this.updateBlock(eidx, {
                    kind: "text",
                    text: this.activeReportText,
                });
            }
            if (token.done) {
                this.commitActiveReport();
            }
        } else if (token.type === "python") {
            // If thinking streamed first on this emission, the thinking
            // handler optimistically labeled the block as a standalone
            // 'thinking' emission and stashed the content in `b.text`.
            // Now that real code is arriving we know this is in-schema
            // thinking-on-a-python emission — migrate `text` → `thinking`
            // so the python snapshot branch surfaces it. Without this the
            // thinking content visibly streams in then vanishes the
            // moment code starts.
            const b = this.ensureBlock(eidx, "python");
            const migration =
                b.kind === "thinking" ? { thinking: b.text, text: "" } : {};
            this.updateBlock(eidx, {
                ...migration,
                kind: "python",
                code: (b.code || "") + (token.content || ""),
            });
        } else if (token.type === "ts") {
            // agex-ts code emission — same layout as 'python', different
            // syntax highlighter downstream. Same thinking → text →
            // thinking migration as the python branch above.
            const b = this.ensureBlock(eidx, "ts");
            const migration =
                b.kind === "thinking" ? { thinking: b.text, text: "" } : {};
            this.updateBlock(eidx, {
                ...migration,
                kind: "ts",
                code: (b.code || "") + (token.content || ""),
            });
        } else if (token.type === "terminal") {
            // Same thinking-migration as python/ts — terminal_action's
            // schema also carries a `thinking` parameter.
            const b = this.ensureBlock(eidx, "terminal");
            const migration =
                b.kind === "thinking" ? { thinking: b.text, text: "" } : {};
            this.updateBlock(eidx, {
                ...migration,
                kind: "terminal",
                commands: (b.commands || "") + (token.content || ""),
            });
        } else if (token.type === "file_path") {
            const b = this.ensureBlock(eidx, "file_write");
            this.updateBlock(eidx, {
                path: (b.path || "") + (token.content || ""),
            });
        } else if (token.type === "file_search") {
            const b = this.ensureBlock(eidx, "file_edit");
            this.updateBlock(eidx, {
                kind: "file_edit",
                search: (b.search || "") + (token.content || ""),
            });
        } else if (token.type === "file_content") {
            const b = this.ensureBlock(eidx);
            // Only bump kind to file_write if unclaimed — a prior
            // file_search would've already set file_edit.
            this.updateBlock(eidx, {
                kind: b.kind || "file_write",
                content: (b.content || "") + (token.content || ""),
            });
        } else if (token.type === "file_action") {
            // Final prebuilt file emission — authoritative values replace
            // whatever the streaming deltas accumulated.
            if (token.action) {
                const action = token.action;
                if (action.kind === "file") {
                    this.updateBlock(eidx, {
                        kind: "file_write",
                        path: action.path,
                        content: action.content,
                        mode: action.mode || "write",
                        streaming: false,
                    });
                } else if (action.kind === "edit") {
                    this.updateBlock(eidx, {
                        kind: "file_edit",
                        path: action.path,
                        search: action.search,
                        content: action.content,
                        streaming: false,
                    });
                }
            }
        }

        this.rebuildStreamingMessages();
    };

    /** Assemble the in-flight turn's event list: committed snapshots
     *  with spawn chips interleaved at their anchors (right after the
     *  action snapshot that spawned each clone), then the live
     *  streaming snapshot, then any chips anchored past the committed
     *  range (defensive — shouldn't occur, a spawn needs a completed
     *  parent action). Used by both the streaming rebuild and the
     *  error/cancel path so the partial feed keeps the same shape. */
    assembleLiveEvents = () => {
        const liveSnapshot = this.snapshotTurn();
        // A pure-narration turn snapshots to an emission-less action now
        // that text bodies live only in the report bubble — don't fold
        // it into the activity feed (it would render as an empty
        // "Activity" card with a streaming dot).
        const hasLive = liveSnapshot && liveSnapshot.emissions.length;
        const chips = this.liveSpawnChips;
        const chipsAt = (i) => chips.filter((c) => (c.anchor ?? 0) === i);
        const events = [...chipsAt(0)];
        this.streamingEvents.forEach((e, i) =>
            events.push(e, ...chipsAt(i + 1)),
        );
        if (hasLive) events.push(liveSnapshot);
        const placed = new Set(events);
        for (const c of chips) if (!placed.has(c)) events.push(c);
        return events;
    };

    rebuildStreamingMessages = () => {
        const allEvents = this.assembleLiveEvents();

        // Rebuild the tail of messages: strip all streaming messages,
        // then re-add current streaming state (optional report +
        // activity).
        const nonStreaming = this.messages.filter((m) => !m.streaming);
        const streamParts = [];
        if (this.activeReportText !== null) {
            streamParts.push({
                role: "agent",
                content: this.activeReportText,
                isReport: true,
                streaming: true,
                timestamp: new Date(),
            });
        }
        streamParts.push({
            role: "agent",
            content: "",
            events: allEvents,
            timestamp: new Date(),
            streaming: true,
        });
        this.messages = [...nonStreaming, ...streamParts];
    };

    // --- App-file fingerprint (preview-refresh decision) --------------

    /** Quick fingerprint of all app/* files: sorted `path:size` lines.
     *  Snapshot before/after a turn to decide whether to refresh the
     *  preview iframe. Catches every common way an agent modifies app
     *  files (file_write/file_edit emissions, terminal_action writes,
     *  ts_action `await fs.write`) uniformly — all flow through kvgit and
     *  show up in the post-turn file list with new sizes. */
    appFilesFingerprint = async (adapter, branch, allPaths = null) => {
        const all = allPaths ?? (await adapter.listFiles(branch));
        const appPaths = all.filter((p) => p === "app" || p.startsWith("app/"));
        if (appPaths.length === 0) return "";
        const sizes = await Promise.all(
            appPaths.map((p) => adapter.fileSize(branch, p).catch(() => -1)),
        );
        return appPaths
            .map((p, i) => `${p}:${sizes[i]}`)
            .sort()
            .join("\n");
    };

    // --- Misc session ops --------------------------------------------

    dismissUndoToast = () => {
        if (this.undoToast?.timer) clearTimeout(this.undoToast.timer);
        this.undoToast = null;
    };

    handleUpload = async (names, commitHash) => {
        const { adapter, branch } = await getActiveAdapter();
        this.files = await adapter.listFiles(branch);
        const label =
            names.length === 1
                ? `**Uploaded:** \`${names[0]}\``
                : `**Uploaded ${names.length} files:**\n${names
                      .map((n) => `- \`${n}\``)
                      .join("\n")}`;
        this.messages = [
            ...this.messages,
            {
                role: "user",
                content: label,
                timestamp: new Date(),
                isMarkdown: true,
                commit_hash: commitHash,
            },
        ];
    };

    handleDelete = async (names, commitHash) => {
        const { adapter, branch } = await getActiveAdapter();
        this.files = await adapter.listFiles(branch);
        const label =
            names.length === 1
                ? `**Deleted:** \`${names[0]}\``
                : `**Deleted ${names.length} files:**\n${names
                      .map((n) => `- \`${n}\``)
                      .join("\n")}`;
        this.messages = [
            ...this.messages,
            {
                role: "user",
                content: label,
                timestamp: new Date(),
                isMarkdown: true,
                commit_hash: commitHash,
            },
        ];
    };

    handleLoadMore = () => {
        // Prepend the just-revealed older range to `messages`. Don't
        // replace `messages` wholesale from the chunk manager — the
        // manager holds a snapshot of history captured at init time and
        // is unaware of live appends (chat turns, uploads). A full
        // replace would drop anything appended after the manager was
        // constructed.
        const older = this.historyChunks?.loadOlder?.() ?? [];
        if (older.length > 0) {
            this.messages = [...older, ...this.messages];
            // Reassign to trigger Svelte reactivity for hasMore getter.
            this.historyChunks = this.historyChunks;
        }
    };

    handleUndo = async (index, agentReady) => {
        if (this.busy || !agentReady) return;
        const msg = this.messages[index];
        if (!msg?.commit_hash) return;
        const undoneText = msg.content;
        this.dismissUndoToast();
        this.busy = true;
        try {
            const { adapter, branch } = await getActiveAdapter();
            const preCommit = await adapter.getCurrentCommit(branch);
            await adapter.undoToCommit(branch, msg.commit_hash);
            this.historyChunks = await loadHistoryChunked(branch);
            this.messages = this.historyChunks.messages;
            this.files = await adapter.listFiles(branch);
            this.previewTick++;
            if (!msg.isMarkdown) this.inputPrefill = undoneText;
            this.tokenOverride = await adapter.estimateLogTokens(branch);
            // Show toast with option to redo.
            const timer = setTimeout(this.dismissUndoToast, 5000);
            this.undoToast = { preCommit, timer };
        } catch (e) {
            console.error("Undo failed:", e);
        } finally {
            this.busy = false;
        }
    };

    handleRedoFromToast = async (agentReady) => {
        if (!this.undoToast || this.busy || !agentReady) return;
        const { preCommit } = this.undoToast;
        this.dismissUndoToast();
        this.busy = true;
        try {
            const { adapter, branch } = await getActiveAdapter();
            await adapter.undoToCommit(branch, preCommit);
            this.historyChunks = await loadHistoryChunked(branch);
            this.messages = this.historyChunks.messages;
            this.files = await adapter.listFiles(branch);
            this.previewTick++;
            this.inputPrefill = "";
            this.tokenOverride = await adapter.estimateLogTokens(branch);
        } catch (e) {
            console.error("Redo failed:", e);
        } finally {
            this.busy = false;
        }
    };

    loadTokenHistory = async () => {
        try {
            const { adapter, branch } = await getActiveAdapter();
            this.tokenHistory = await adapter.getTokenHistory(branch);
        } catch (e) {
            console.error("Failed to load token history:", e);
        }
    };

    handleChapter = async (agentReady) => {
        if (this.busy || !agentReady || this.chaptering) return;
        this.chaptering = true;
        try {
            const { adapter, branch } = await getActiveAdapter();
            await adapter.runChaptering(branch);
            this.historyChunks = await loadHistoryChunked(branch);
            this.messages = this.historyChunks.messages;
            this.tokenOverride = await adapter.estimateLogTokens(branch);
            this.tokenHistory = await adapter.getTokenHistory(branch);
        } catch (e) {
            console.error("Chaptering failed:", e);
        } finally {
            this.chaptering = false;
        }
    };

    cancel = () => {
        this.cancelling = true;
        // Two cancel paths, both safe to fire:
        //   - cancelTask: py-only worker-side mechanism. No-op for ts
        //     sessions or when no py task is running.
        //   - activeAbort.abort: AbortSignal the TS adapter forwards to
        //     agex-ts's task call (honored natively).
        cancelTask();
        this.activeAbort?.abort();
    };

    // --- The agent run loop (was ChatShell.handleSend) ----------------

    /**
     * Run one chat turn for this session.
     *
     * @param {string} prompt
     * @param {Array<{name: string, bytes: Uint8Array}>} attachments
     * @param {boolean} agentReady
     */
    send = async (prompt, attachments = [], agentReady = true) => {
        // Per-session re-entrancy guard only — turns on *other* sessions
        // run concurrently (each has its own agent + worker over the
        // shared store; Phase 2).
        if (this.busy || !agentReady) return;
        const trimmed = (prompt || "").trim();
        if (!trimmed && attachments.length === 0) return;

        // Claim `busy` BEFORE any await so a double-click on Send
        // re-enters the busy-guard above instead of slipping through
        // while we're partway through an upload. Every early-return path
        // below must reset `busy`.
        this.busy = true;
        this.inputPrefill = "";

        const { adapter, branch } = await getActiveAdapter();

        // 1. Push attachments first (if any). Writes them to the VFS,
        //    fires `handleUpload` (creates the upload bubble), and the
        //    FileEvent we log makes the agent aware on their next turn.
        //    Doing this BEFORE the prompt means the upload bubble appears
        //    above the user's message — natural reading order.
        if (attachments.length > 0) {
            const uploadCommit = await adapter.getCurrentCommit(branch);
            const fileMap = {};
            for (const att of attachments) fileMap[att.name] = att.bytes;
            try {
                await adapter.writeFiles(branch, fileMap);
                await this.handleUpload(Object.keys(fileMap), uploadCommit);
            } catch (e) {
                console.error("Attachment upload failed:", e);
                this.messages = [
                    ...this.messages,
                    {
                        role: "agent",
                        content: `Error uploading files: ${e.message || String(e)}`,
                        errorStack: this._captureStack(e),
                        timestamp: new Date(),
                    },
                ];
                this.busy = false;
                return;
            }
        }

        // 2. If there's no text, we're done — files-only "send" just
        //    creates the upload bubble. The agent sees the file event
        //    next time they get a turn.
        if (!trimmed) {
            this.busy = false;
            return;
        }

        const commitHash = await adapter.getCurrentCommit(branch);
        this.messages = [
            ...this.messages,
            {
                role: "user",
                content: trimmed,
                timestamp: new Date(),
                commit_hash: commitHash,
            },
        ];

        this.streamingEvents = [];
        this.liveSpawnChips = [];
        this.currentTurn = null;
        this.activeReportText = null;
        this.activeReportIdx = null;

        // Snapshot app file state for the post-turn refresh decision.
        const preAppFp = await this.appFilesFingerprint(adapter, branch);

        this.activeAbort = new AbortController();
        _activeTurns++;
        try {
            this.tokenOverride = null;
            const response = await adapter.sendMessage(branch, trimmed, {
                onToken: this.handleToken,
                signal: this.activeAbort.signal,
            });
            const cancelled = response.events.some(
                (e) => e.type === "cancelled",
            );

            // Replace streaming message with final message. Spawn chips
            // (never in response.events) merge in from the live state,
            // anchored after the action that spawned each (chip
            // `startedAt` vs action `ts`, both event-log clock); after
            // a reload, loadHistory rebuilds equivalent chips from the
            // terminal event's captured `spawnEvents`.
            const finalMessages = this.messages.filter((m) => !m.streaming);
            const finalEvents = interleaveSpawnChips(
                response.events,
                this.liveSpawnChips,
            );
            if (cancelled) {
                this.messages = [
                    ...finalMessages,
                    {
                        role: "agent",
                        content: { type: "text", content: "" },
                        events: finalEvents,
                        timestamp: new Date(),
                        cancelled: true,
                    },
                ];
            } else {
                this.messages = [
                    ...finalMessages,
                    {
                        role: "agent",
                        content: response.result,
                        events: finalEvents,
                        timestamp: new Date(),
                    },
                ];
            }

            // Refresh file list, preview, and persist session meta.
            this.files = await adapter.listFiles(branch);
            if (!cancelled) {
                // Re-fingerprint app files and refresh the preview if
                // anything under app/ changed during the turn — by any
                // mechanism (file_write / file_edit emissions, esbuild
                // via terminal_action, `await fs.write` via ts_action).
                const postAppFp = await this.appFilesFingerprint(
                    adapter,
                    branch,
                    this.files,
                );
                if (postAppFp !== preAppFp) this.previewTick++;
                const lastAction = [...response.events]
                    .reverse()
                    .find((e) => e.type === "action" && e.title);
                await persistSessionMeta(lastAction?.title || "", branch);
            }
        } catch (e) {
            // Preserve the agent's in-flight emissions when the task
            // errors mid-stream. Without this, the streaming activity
            // card vanishes (filter strips `streaming: true` entries)
            // and the chat just shows a bare "Error: ..." — the user
            // loses all context about what the agent was doing right up
            // to the failure. Snapshot the active turn (if any) and pair
            // the partial events with the error message so the activity
            // card stays visible alongside the error.
            // Same assembly as the live feed — committed snapshots with
            // spawn chips interleaved at their anchors plus the partial
            // live snapshot — so chips (e.g. clones still running when
            // the turn errored/cancelled) stay visible in place.
            const finalMessages = this.messages.filter((m) => !m.streaming);
            const eventsBeforeError = this.assembleLiveEvents();
            // User-initiated cancel (cancel() set `cancelling` true
            // before the abort fired) lands here when the adapter throws
            // on signal abort instead of returning a response with a
            // cancelled event. Render as cancelled, not as a crash.
            const userCancelled = this.cancelling || e?.name === "AbortError";
            if (userCancelled) {
                this.messages = [
                    ...finalMessages,
                    {
                        role: "agent",
                        content: { type: "text", content: "" },
                        events: eventsBeforeError,
                        timestamp: new Date(),
                        cancelled: true,
                    },
                ];
            } else {
                console.error("Agent turn failed:", e);
                this.messages = [
                    ...finalMessages,
                    {
                        role: "agent",
                        content: `Error: ${e.message}`,
                        errorStack: this._captureStack(e),
                        events: eventsBeforeError,
                        timestamp: new Date(),
                    },
                ];
            }
        } finally {
            // Flush any in-flight report text into a permanent bubble
            // before tearing down. Symmetric with eventsBeforeError —
            // when a cancel / error fires mid-text-emission (before
            // `turn_complete` arrives), the streaming bubble's content
            // would otherwise vanish along with `activeReportText`.
            // No-op for the success path. Idempotent in any case.
            this.commitActiveReport();
            this.busy = false;
            this.cancelling = false;
            this.activeAbort = null;
            this.streamingEvents = [];
            this.liveSpawnChips = [];
            this.currentTurn = null;
            _activeTurns = Math.max(0, _activeTurns - 1);
            // Flag the result as unseen unless the user is actively
            // viewing it — i.e. this is the foreground session AND the tab
            // is on screen (visible + focused). A turn that finishes while
            // they're on another session OR tabbed/app'd away counts as
            // unseen (drives the drawer dot + favicon badge). Matches the
            // notification's on-screen gate. Cleared in ChatShell when the
            // session is brought forward or the tab regains focus.
            const store = get(sessionStore);
            const foreground = store.currentBranch === this.branch;
            this.unseen = !(foreground && isOnScreen());
            // Off-screen completion → optional desktop notification (the
            // notify module also checks tab visibility, the opt-in flag,
            // and permission). Title falls back through name → title.
            const meta = store.sessions.find((s) => s.branch === this.branch);
            notifyTurnComplete({
                branch: this.branch,
                title: meta?.name || meta?.title,
                foreground,
            });
        }
    };
}
