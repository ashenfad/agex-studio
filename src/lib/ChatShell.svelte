<script>
    import Header from './Header.svelte'
    import MessageList from './MessageList.svelte'
    import ChatInput from './ChatInput.svelte'
    import SplitPane from './SplitPane.svelte'
    import AppPreview from './AppPreview.svelte'
    import ActionModal from './ActionModal.svelte'
    import ChapterModal from './ChapterModal.svelte'
    import SettingsDrawer from './SettingsDrawer.svelte'
    import SessionDrawer from './SessionDrawer.svelte'
    import FileDrawer from './FileDrawer.svelte'
    import { settingsStore } from './settings.js'
    import TokenModal from './TokenModal.svelte'
    import { cancelTask, pyodideStore } from './pyodide.js'
    import { initSessionsFromUrl, loadHistoryChunked, persistSessionMeta, sessionStore, CURRENT_BRANCH_KEY } from './sessions.js'
    import { importFromDrive, isDriveImportAvailable } from './drive-import.js'
    import { queueFiles } from './pending-attachments.js'
    import { loadCache as loadSessionCache } from './session-index.js'
    import { kernelRegistry } from './kernel-registry.js'
    import { getActiveAdapter } from './active-adapter.js'

    /** Resolve the active session's kernel synchronously from
     *  localStorage (no kernel boot required). The session-index cache
     *  records each session's kernel, and `CURRENT_BRANCH_KEY` points at
     *  the active branch — the join is enough to pick the right kernel
     *  before either runtime is touched.
     *
     *  Falls back to `'ts'` when the cache is empty (cold-start) — the
     *  ts kernel boots in well under a second versus py's ~30s Pyodide
     *  install. If the current pointer matches a cached py record, that
     *  takes precedence. Matches the cold-start session creation default
     *  in sessions.js's initSessions. */
    function _resolveActiveKernel() {
        const branch = localStorage.getItem(CURRENT_BRANCH_KEY)
        if (!branch) return 'ts'
        const record = loadSessionCache().find((r) => r.branch === branch)
        if (!record) return 'ts'
        return record.kernel === 'py' ? 'py' : 'ts'
    }

    /** @type {Array<{role: 'user'|'agent', content: string, timestamp: Date}>} */
    let messages = $state([])
    let busy = $state(false)
    let cancelling = $state(false)
    /** AbortController for the in-flight task. The TS adapter forwards
     *  `signal` into agex-ts's task call (which honors AbortSignal
     *  natively); the py adapter ignores it and uses its own
     *  worker-side `cancelTask` mechanism. handleCancel calls both
     *  so cancellation works regardless of kernel.
     *  @type {AbortController | null} */
    let activeAbort = $state(null)
    let historyChunks = $state(null)
    let settingsOpen = $state(false)
    let sessionsOpen = $state(false)
    let filesOpen = $state(false)
    let agentReady = $state(false)
    let initStatus = $state('')
    let initError = $state('')
    /** @type {'py' | 'ts'} */
    let activeKernel = $state(_resolveActiveKernel())
    /** @type {string[]} */
    let files = $state([])
    let inputPrefill = $state('')
    let previewRefreshKey = $state(0)
    /** @type {'chat' | 'app'} */
    let mobileView = $state('chat')
    /** Single source of truth for which panes are visible. `'split'`
     *  is the normal studio experience; `'app-only'` hides the chat
     *  entirely and surfaces a branded pill as the way back. Set to
     *  `'app-only'` for first-load of play-mode artifact URLs (see
     *  `isPlayMode` below); the user can flip out via the pill, and
     *  we don't snap them back on subsequent reloads. */
    /** @type {'split' | 'app-only'} */
    let viewMode = $state('split')
    let scrollKey = $state(0)
    let chaptering = $state(false)
    let tokenModalOpen = $state(false)
    /** @type {number[] | null} */
    let tokenHistory = $state(null)
    let chapterModalData = $state(null)
    let actionModalIndex = $state(-1)
    let actionModalEvents = $derived(
        actionModalIndex >= 0 && actionModalIndex < messages.length
            ? messages[actionModalIndex].events
            : null
    )
    let actionModalStreaming = $derived(
        actionModalIndex >= 0 && actionModalIndex < messages.length
            ? messages[actionModalIndex].streaming ?? false
            : false
    )
    let configured = $derived($settingsStore.apiKey.length > 0)

    // Captured once at mount, before ``initSessionsFromUrl`` replaces
    // the URL with ``/`` post-import.  When true, this load was kicked
    // off by a published-artifact share URL — we let startup proceed
    // without an API key (the visitor wants to view the artifact, not
    // chat with their own provider) and skip the "open Settings on
    // first load" auto-prompt.  The artifact still loads end-to-end;
    // sending new messages stays gated on ``configured`` separately.
    const isExternalEntry = (() => {
        if (typeof window === 'undefined') return false
        const path = window.location.pathname
        if (path !== '/run/' && path !== '/run') return false
        const params = new URLSearchParams(window.location.search)
        return !!(params.get('gist') || params.get('src'))
    })()
    // `?play=1` on a `/run/?gist=...` URL signals the publisher
    // wants this share to read as an end-user app, not as a studio
    // showcase. We capture once at mount (mirrors `isExternalEntry`)
    // because `initSessionsFromUrl` strips the query later. The
    // value is transient — clicking the pill out of app-only mode
    // sets `viewMode` to `'split'` and that sticks for the session;
    // we don't restore play mode on subsequent reloads.
    const isPlayMode = (() => {
        if (!isExternalEntry) return false
        const params = new URLSearchParams(window.location.search)
        return params.get('play') === '1'
    })()
    if (isPlayMode) {
        viewMode = 'app-only'
        // Also flip `mobileView` to 'app'. Without this, mobile loads
        // get `class="split-pane mobile-chat view-app-only"` — both
        // `.view-app-only .pane.left { display: none }` and
        // `.mobile-chat .pane.right { display: none }` fire, hiding
        // both panes (black screen). Desktop avoids it because the
        // `@media (max-width: 768px)` mobile-* rules don't apply.
        mobileView = 'app'
    }
    let hasAppFiles = $derived(files.some(f => f === 'app' || f.startsWith('app/')))

    let tokenOverride = $state(null)

    // Undo toast state
    let undoToast = $state(null) // { preCommit, timer }

    function dismissUndoToast() {
        if (undoToast?.timer) clearTimeout(undoToast.timer)
        undoToast = null
    }

    /** Quick fingerprint of all app/* files: sorted `path:size` lines.
     *  Snapshot before/after a turn to decide whether to refresh the
     *  preview iframe. Catches every common way an agent modifies app
     *  files — direct file_write / file_edit emissions, terminal_action
     *  writes (esbuild output), and ts_action writes (await fs.write) —
     *  uniformly, because all of them flow through kvgit and end up in
     *  the post-turn file list with new sizes. One extra fileSize call
     *  per app file, parallelized, sub-ms in practice.
     *
     *  `allPaths` is an optional pre-fetched listFiles result — the
     *  post-turn call site has just done that listFiles for its own
     *  reasons, so we let it pass the result in to skip a redundant
     *  IDB walk. */
    async function appFilesFingerprint(adapter, branch, allPaths = null) {
        const all = allPaths ?? await adapter.listFiles(branch)
        const appPaths = all.filter(p => p === 'app' || p.startsWith('app/'))
        if (appPaths.length === 0) return ''
        const sizes = await Promise.all(
            appPaths.map(p => adapter.fileSize(branch, p).catch(() => -1))
        )
        return appPaths
            .map((p, i) => `${p}:${sizes[i]}`)
            .sort()
            .join('\n')
    }

    let lastInputTokens = $derived.by(() => {
        if (tokenOverride != null) return tokenOverride
        for (let i = messages.length - 1; i >= 0; i--) {
            const events = messages[i].events
            if (!events) continue
            for (let j = events.length - 1; j >= 0; j--) {
                if (events[j].type === 'action' && events[j].input_tokens != null) {
                    return events[j].input_tokens
                }
            }
        }
        return null
    })

    // Settings drawer is no longer auto-opened on first load. The
    // redesigned empty state (see further down) has its own
    // documentation-style explanation of the BYOK model and an
    // explicit "Open Settings" action — popping the drawer
    // automatically would fade out that first impression with a
    // modal overlay on top of it. External-artifact visitors still
    // see their own banner inside the loaded artifact telling them
    // they need a key to continue the conversation.

    // Warn before leaving / reloading while a turn is in flight.
    // Catches accidental closes / back-button presses while the
    // agent is mid-stream. The chat task COMMITS state on cancel
    // (see ts-kernel-adapter.js's sendMessage finally), so the
    // user wouldn't actually lose data — but they'd lose the
    // *outcome* of whatever the agent was about to produce, which
    // is more annoying than a dropped tab. Modern browsers ignore
    // the custom message and show their own "Leave site?" dialog,
    // so we just need to set returnValue + return a string.
    $effect(() => {
        if (!busy) return
        const handler = (e) => {
            e.preventDefault()
            // Legacy form for older browsers — modern ones use
            // preventDefault() alone but the string assignment
            // is harmless and keeps the fallback working.
            e.returnValue = ''
            return ''
        }
        window.addEventListener('beforeunload', handler)
        return () => window.removeEventListener('beforeunload', handler)
    })

    // historyReady flips once Wave 2 init + history load have completed.
    // Lets us show real chat earlier than agentReady (which waits for
    // the full Wave 3 registration before Send becomes enabled).
    let historyReady = $state(false)

    // Re-init agent when settings change AND Pyodide has reached at
    // least the history-ready stage. Two-phase: Wave-2 init unlocks
    // history; Wave-3 init unlocks Send.
    //
    // Tracks the subset of settings that feed ``initAgentBasics``'s
    // Python preamble (LLM client construction args).  Skipping any
    // of these would silently leave the old client in place after a
    // save — e.g. a new ``baseUrl`` wouldn't route to the new host.
    let lastInitKey = ''
    const _initKey = (s) => JSON.stringify([
        s.apiKey, s.model, s.provider, s.baseUrl,
        s.toolUseWireFormat, s.reasoningEffort,
        // serviceTier flows into the LLM client's request-body
        // `extras` (see _buildLlmClient in ts-agent.js); chapteringTrigger
        // is passed through initAgent's reconfigure() path. Both are
        // silently dropped on settings save if not tracked here —
        // the effect's `if (initKey === lastInitKey) return` would
        // short-circuit when only one of these changed.
        s.serviceTier, s.chapteringTrigger,
    ])
    $effect(() => {
        const s = $settingsStore
        // Read pyodideStore so this effect re-runs when stage advances.
        void $pyodideStore.stage
        // External-artifact entry skips the API-key gate — visitors
        // need to load the artifact even when they don't have a key
        // configured.  Startup proceeds; sending new messages stays
        // gated on ``configured`` (see sendDisabled below).
        if (!s.apiKey && !isExternalEntry) return
        const initKey = _initKey(s)
        if (initKey === lastInitKey) return
        lastInitKey = initKey
        runStartup(s)
    })

    async function runStartup(s) {
        agentReady = false
        initError = ''
        // Resolve fresh per-startup — settings changes can re-fire this
        // effect after the user switched sessions.
        activeKernel = _resolveActiveKernel()
        try {
            initStatus = activeKernel === 'py'
                ? 'Loading core packages...'
                : 'Loading agent...'
            // Drive the kernel boot through the registry. The Py adapter's
            // init encapsulates the two-wave Pyodide install; the Ts
            // adapter resolves quickly (no Pyodide). We hook the
            // 'history-ready' milestone via onStage to do shell-side
            // session/history/files load — same pattern for both kernels.
            //
            // `historyReady` is only torn down inside the onStage callback,
            // i.e. only when we're actually about to reload history. A
            // settings-change re-fire on an already-booted kernel sees
            // `ensure` return immediately *without* firing onStage, so
            // we don't want to reset historyReady at the top — that would
            // hide the chat and leave it showing 'Loading…' until the
            // next page reload.
            await kernelRegistry.ensure(activeKernel, s, {
                onStage: async (stage) => {
                    if (stage === 'history-ready') {
                        historyReady = false
                        initStatus = isExternalEntry
                            ? 'Downloading bundle...'
                            : 'Loading sessions...'
                        await initSessionsFromUrl()
                        initStatus = 'Loading history...'
                        historyChunks = await loadHistoryChunked()
                        messages = historyChunks.messages
                        if (messages.length && messages[messages.length - 1].role === 'chaptering') {
                            const { adapter, branch } = await getActiveAdapter()
                            tokenOverride = await adapter.estimateLogTokens(branch)
                        }
                        initStatus = 'Loading files...'
                        const { adapter, branch } = await getActiveAdapter()
                        files = await adapter.listFiles(branch)
                        historyReady = true
                        initStatus = 'Loading capabilities...'
                    }
                    // 'send-ready' fires implicitly when ensure resolves
                },
            })
            agentReady = true
            initStatus = ''
        } catch (e) {
            console.error('Agent init failed:', e)
            initError = e.message || String(e)
            initStatus = ''
        }
    }

    // Combined warming message — surfaces whichever phase is active so
    // the user has some signal that things are happening behind the
    // scenes. Empty string once the agent is fully ready.
    let warmingMessage = $derived.by(() => {
        if (agentReady) return ''
        // TS path doesn't touch `pyodideStore`; the py store stays at
        // its idle default. Reading it here would just shadow
        // `initStatus` with an empty `py.message` — fall back to the
        // shell-side status directly for non-py kernels.
        if (activeKernel !== 'py') {
            return initStatus || 'Initializing agent...'
        }
        const py = $pyodideStore
        if (py.status === 'error') return ''  // shown as an error notice instead
        // During the 'history-ready' stage the worker is idle —
        // it has finished Wave 2 and is paused waiting for the host
        // to kick Wave 3.  Meanwhile the host is running
        // initSessionsFromUrl / loadHistoryChunked / listFiles, and
        // ``initStatus`` carries the current progress (download %,
        // ``Loading history...``, etc.).  ``py.message`` would be
        // frozen at the last worker-side progress string
        // (``Loading session...``) and shadow that signal.
        if (py.stage === 'history-ready' && py.status !== 'ready') {
            return initStatus || py.message || 'Loading...'
        }
        if (py.status !== 'ready') return py.message || 'Loading...'
        return initStatus || 'Initializing agent...'
    })

    let pyodideError = $derived(
        $pyodideStore.status === 'error' ? $pyodideStore.message : ''
    )

    // Reload history when session changes
    let lastBranch = ''
    $effect(() => {
        const branch = $sessionStore.currentBranch
        if (agentReady && branch && branch !== lastBranch) {
            lastBranch = branch
            loadHistoryChunked().then(async (chunks) => {
                historyChunks = chunks
                messages = chunks.messages
                scrollKey++
                const { adapter, branch: activeBranch } = await getActiveAdapter()
                if (messages.length && messages[messages.length - 1].role === 'chaptering') {
                    tokenOverride = await adapter.estimateLogTokens(activeBranch)
                } else {
                    tokenOverride = null
                }
                files = await adapter.listFiles(activeBranch)
                previewRefreshKey++
            })
        }
    })

    // Streaming state — accumulates tokens into events for live display.
    //
    // The retool gives every token an ``emission_index`` (one per
    // emission in the turn: python / terminal / file_write /
    // file_edit / text / thinking).  Tokens for different emissions
    // can arrive interleaved on some providers (esp. OpenAI Chat
    // Completions), so we group strictly by emission_index rather
    // than by the older "title-start means new action" heuristic
    // which silently scrambled multi-emission turns.
    //
    // ``currentTurn``: Map of emission_index → partial block built
    //   from streaming tokens.  Finalized into a single action event
    //   (with an ``emissions`` list preserving order) when Python
    //   emits the ``turn_complete`` marker via ``_on_event``.
    // ``streamingEvents``: committed turns, shown in the live chat
    //   feed while subsequent turns stream.
    let streamingEvents = $state([])
    let currentTurn = $state(null)
    // Live spawn chips for the in-flight turn — one per concurrent clone,
    // keyed by its `spawnIndex`. Appended
    // "running" on the clone's taskStart, updated on each step, resolved on
    // completion. Live-only: shown during the turn and injected into the
    // turn's in-memory final message, but NOT persisted — gone on reload.
    let liveSpawnChips = $state([])
    // Report streaming accumulator — null when no TextEmission is
    // currently building.  Lifted out of currentTurn so the
    // committed-chat-message flow (insert on done) stays simple.
    let activeReportText = $state(null)
    let activeReportIdx = $state(null)

    function ensureBlock(eidx, kindHint = null) {
        if (!currentTurn) {
            currentTurn = { blocks: {}, order: [] }
        }
        if (currentTurn.blocks[eidx] === undefined) {
            currentTurn.blocks[eidx] = {
                idx: eidx,
                kind: kindHint,
                title: '',
                thinking: '',
                code: '',
                commands: '',
                text: '',
                path: '',
                search: '',
                content: '',
                mode: 'write',
                match_all: false,
                streaming: true,
            }
            currentTurn.order = [...currentTurn.order, eidx]
        } else if (kindHint && !currentTurn.blocks[eidx].kind) {
            currentTurn.blocks[eidx].kind = kindHint
        }
        return currentTurn.blocks[eidx]
    }

    function updateBlock(eidx, patch) {
        const b = ensureBlock(eidx)
        currentTurn.blocks[eidx] = { ...b, ...patch }
        // Trigger Svelte reactivity on the outer map.
        currentTurn = { ...currentTurn, blocks: { ...currentTurn.blocks } }
    }

    function snapshotTurn() {
        if (!currentTurn) return null
        const ordered = currentTurn.order.map(i => currentTurn.blocks[i])
        const titles = []
        const thinkingBits = []
        const reportBits = []
        const codeBits = []
        const terminalBits = []
        const fileActions = []
        const emissions = []
        for (const b of ordered) {
            // Build the emissions-list shape EventDetail prefers (so
            // per-emission rendering ordered by emission_index takes
            // over from the flat-fields fallback).
            if (b.kind === 'python' || b.kind === 'ts') {
                emissions.push({
                    kind: b.kind,
                    idx: b.idx,
                    code: b.code,
                    title: b.title,
                    thinking: b.thinking,
                })
                if (b.title) titles.push(b.title)
                if (b.thinking) thinkingBits.push(b.thinking)
                if (b.code) codeBits.push(b.code)
            } else if (b.kind === 'terminal') {
                emissions.push({
                    kind: 'terminal',
                    idx: b.idx,
                    commands: b.commands,
                    title: b.title,
                    thinking: b.thinking,
                })
                if (b.title) titles.push(b.title)
                if (b.thinking) thinkingBits.push(b.thinking)
                if (b.commands) terminalBits.push(b.commands)
            } else if (b.kind === 'file_write') {
                emissions.push({
                    kind: 'file_write',
                    idx: b.idx,
                    path: b.path,
                    content: b.content,
                    mode: b.mode,
                })
                fileActions.push({
                    kind: 'file',
                    path: b.path || '…',
                    content: b.content,
                    mode: b.mode || 'write',
                    streaming: b.streaming,
                })
            } else if (b.kind === 'file_edit') {
                emissions.push({
                    kind: 'file_edit',
                    idx: b.idx,
                    path: b.path,
                    search: b.search,
                    content: b.content,
                    match_all: b.match_all,
                })
                fileActions.push({
                    kind: 'edit',
                    path: b.path || '…',
                    search: b.search,
                    content: b.content,
                    operation: 'replace',
                    streaming: b.streaming,
                })
            } else if (b.kind === 'text') {
                // Report/narration renders as its own chat bubble (live
                // via `commitActiveReport`), not inside the activity
                // card — keep it out of `emissions` so EventDetail
                // doesn't render the report twice. Mirrors
                // `synthesizeAction` on the committed/reload path.
                if (b.text) reportBits.push(b.text)
            } else if (b.kind === 'thinking') {
                emissions.push({
                    kind: 'thinking',
                    idx: b.idx,
                    text: b.text,
                    redacted: b.redacted,
                })
                if (b.text && !b.redacted) thinkingBits.push(b.text)
            }
        }
        const NL2 = '\n\n'
        return {
            type: 'action',
            title: titles[0] || '',
            thinking: thinkingBits.join(NL2),
            report: reportBits.join(NL2),
            code: codeBits.length ? codeBits.join(NL2) : null,
            terminal: terminalBits.length ? terminalBits.join(NL2) : null,
            file_actions: fileActions,
            emissions,
        }
    }

    /** Commit the in-flight report text as a permanent chat bubble
     *  before any clear-state path that would discard it. Called from
     *  both the explicit `report.done` token AND the `turn_complete`
     *  fallback — agex-ts's token stream doesn't always set
     *  `done: true` on the last text chunk for a TextEmission, so
     *  relying solely on `report.done` would leave the streaming
     *  bubble accumulated but never committed; `turn_complete` then
     *  cleared `activeReportText` and the bubble vanished after the
     *  turn finished. Idempotent — if there's no in-flight text or
     *  it was already committed, this is a no-op. */
    /** Capture an error's stack-like context for inline rendering
     *  in the error bubble's <details>. Prefers `e.stack` (already
     *  has `Name: msg\n   at ...` format in V8 / SpiderMonkey /
     *  WebKit); falls back to `name + message` for thrown values
     *  that aren't proper Error instances. Returns null when there's
     *  nothing useful to show. */
    function _captureStack(e) {
        if (!e) return null
        if (typeof e === 'object' && typeof e.stack === 'string' && e.stack.length > 0) {
            return e.stack
        }
        if (typeof e === 'object' && (e.name || e.message)) {
            return `${e.name || 'Error'}: ${e.message || String(e)}`
        }
        return String(e)
    }

    function commitActiveReport() {
        const finalText = activeReportText
        if (!finalText) return
        const eidx = activeReportIdx
        if (eidx != null) {
            updateBlock(eidx, { kind: 'text', text: finalText })
        }
        const committedMsg = {
            role: 'agent',
            content: finalText,
            isReport: true,
            timestamp: new Date(),
        }
        const insertIdx = messages.findIndex(m => m.streaming)
        if (insertIdx === -1) {
            messages = [...messages, committedMsg]
        } else {
            messages = [
                ...messages.slice(0, insertIdx),
                committedMsg,
                ...messages.slice(insertIdx),
            ]
        }
        activeReportText = null
        activeReportIdx = null
    }

    function handleToken(token) {
        // ``turn_complete`` is the explicit end-of-turn signal —
        // fires after each ActionEvent lands. Flushes any lingering
        // ``currentTurn`` into ``streamingEvents`` AND commits any
        // un-flushed report text into a permanent bubble (see
        // `commitActiveReport` for the rationale).
        if (token.type === 'turn_complete') {
            const snapshot = snapshotTurn()
            if (snapshot && snapshot.emissions.length) {
                streamingEvents = [...streamingEvents, snapshot]
            }
            currentTurn = null
            commitActiveReport()
            rebuildStreamingMessages()
            return
        }

        if (token.type === 'spawn') {
            // Live delegation chip for a spawned clone. `start` appends
            // a running chip (keyed by clone index); `progress` bumps its
            // step count; `end` resolves it to success/fail/cancelled.
            if (token.phase === 'start') {
                liveSpawnChips = [...liveSpawnChips, {
                    type: 'spawn',
                    id: token.id,
                    inputsSummary: token.inputsSummary,
                    status: 'running',
                    steps: 0,
                }]
            } else {
                liveSpawnChips = liveSpawnChips.map(c =>
                    c.id === token.id
                        ? token.phase === 'progress'
                            ? { ...c, steps: token.steps }
                            : {
                                ...c,
                                status: token.status,
                                steps: token.steps ?? c.steps,
                                durationMs: token.durationMs,
                                resultSummary: token.resultSummary,
                                error: token.error,
                              }
                        : c
                )
            }
            rebuildStreamingMessages()
            return
        }

        // Drop final-usage bookkeeping tokens (done=true, no
        // content, no emission_index).
        if (token.done && !token.content && token.emission_index === undefined) {
            return
        }

        const eidx = token.emission_index ?? 0

        if (token.type === 'title') {
            // Title rides on a PythonEmission or TerminalEmission —
            // kind will be confirmed when the content field streams.
            const b = ensureBlock(eidx)
            updateBlock(eidx, { title: (b.title || '') + (token.content || '') })
        } else if (token.type === 'thinking') {
            // Narration-in-schema thinking rides on python/terminal;
            // native-thinking providers emit it as its own emission
            // (our Python-side synthetic burst).  Same slot either
            // way — only the kind differs.
            const b = ensureBlock(eidx)
            const kind = b.kind || 'thinking'
            updateBlock(eidx, {
                kind: kind === 'thinking' ? 'thinking' : kind,
                thinking: kind === 'thinking' ? b.thinking : (b.thinking || '') + (token.content || ''),
                text: kind === 'thinking' ? (b.text || '') + (token.content || '') : b.text,
            })
        } else if (token.type === 'report') {
            // TextEmission — streams as report tokens from our Python
            // adapter.  Accumulates on the text block and commits as
            // a chat message on done.
            if (token.start) {
                activeReportText = ''
                activeReportIdx = eidx
            }
            if (token.content) {
                activeReportText = (activeReportText || '') + token.content
                updateBlock(eidx, { kind: 'text', text: activeReportText })
            }
            if (token.done) {
                commitActiveReport()
            }
        } else if (token.type === 'python') {
            // If thinking streamed first on this emission, the
            // thinking handler optimistically labeled the block as
            // a standalone 'thinking' emission and stashed the
            // content in `b.text` (kind:'thinking' uses `text`).
            // Now that real code is arriving we know this is in-
            // schema thinking-on-a-python emission — migrate
            // `text` → `thinking` so the python snapshot branch
            // (which reads `b.thinking`) surfaces it. Without this
            // the thinking content visibly streams in then vanishes
            // the moment code starts.
            const b = ensureBlock(eidx, 'python')
            const migration = b.kind === 'thinking' ? { thinking: b.text, text: '' } : {}
            updateBlock(eidx, {
                ...migration,
                kind: 'python',
                code: (b.code || '') + (token.content || ''),
            })
        } else if (token.type === 'ts') {
            // agex-ts code emission — same layout as 'python', different
            // syntax highlighter downstream (EventDetail switches on kind).
            // Same thinking → text → thinking migration as the python
            // branch above; see that comment for the in-schema-thinking
            // rationale.
            const b = ensureBlock(eidx, 'ts')
            const migration = b.kind === 'thinking' ? { thinking: b.text, text: '' } : {}
            updateBlock(eidx, {
                ...migration,
                kind: 'ts',
                code: (b.code || '') + (token.content || ''),
            })
        } else if (token.type === 'terminal') {
            // Same thinking-migration as the python/ts handlers —
            // terminal_action's schema also carries a `thinking`
            // parameter, so the in-schema case applies here too.
            const b = ensureBlock(eidx, 'terminal')
            const migration = b.kind === 'thinking' ? { thinking: b.text, text: '' } : {}
            updateBlock(eidx, {
                ...migration,
                kind: 'terminal',
                commands: (b.commands || '') + (token.content || ''),
            })
        } else if (token.type === 'file_path') {
            const b = ensureBlock(eidx, 'file_write')
            updateBlock(eidx, { path: (b.path || '') + (token.content || '') })
        } else if (token.type === 'file_search') {
            const b = ensureBlock(eidx, 'file_edit')
            updateBlock(eidx, {
                kind: 'file_edit',
                search: (b.search || '') + (token.content || ''),
            })
        } else if (token.type === 'file_content') {
            const b = ensureBlock(eidx)
            // Only bump kind to file_write if unclaimed — a prior
            // file_search would've already set file_edit.
            updateBlock(eidx, {
                kind: b.kind || 'file_write',
                content: (b.content || '') + (token.content || ''),
            })
        } else if (token.type === 'file_action') {
            // Final prebuilt file emission — authoritative values
            // replace whatever the streaming deltas accumulated.
            if (token.action) {
                const action = token.action
                if (action.kind === 'file') {
                    updateBlock(eidx, {
                        kind: 'file_write',
                        path: action.path,
                        content: action.content,
                        mode: action.mode || 'write',
                        streaming: false,
                    })
                } else if (action.kind === 'edit') {
                    updateBlock(eidx, {
                        kind: 'file_edit',
                        path: action.path,
                        search: action.search,
                        content: action.content,
                        streaming: false,
                    })
                }
            }
        }

        rebuildStreamingMessages()
    }

    function rebuildStreamingMessages() {
        const liveSnapshot = snapshotTurn()
        // A pure-narration turn snapshots to an emission-less action
        // now that text bodies live only in the report bubble — don't
        // fold it into the activity feed (it would render as an empty
        // "Activity" card with a streaming dot).
        const hasLive = liveSnapshot && liveSnapshot.emissions.length
        const allEvents = hasLive
            ? [...streamingEvents, liveSnapshot, ...liveSpawnChips]
            : [...streamingEvents, ...liveSpawnChips]

        // Rebuild the tail of messages: strip all streaming messages, then
        // re-add current streaming state (optional report + activity).
        const nonStreaming = messages.filter(m => !m.streaming)
        const streamParts = []
        if (activeReportText !== null) {
            streamParts.push({
                role: 'agent',
                content: activeReportText,
                isReport: true,
                streaming: true,
                timestamp: new Date(),
            })
        }
        streamParts.push({
            role: 'agent',
            content: '',
            events: allEvents,
            timestamp: new Date(),
            streaming: true,
        })
        messages = [...nonStreaming, ...streamParts]
    }

    async function handleUpload(names, commitHash) {
        const { adapter, branch } = await getActiveAdapter()
        files = await adapter.listFiles(branch)
        const label = names.length === 1
            ? `**Uploaded:** \`${names[0]}\``
            : `**Uploaded ${names.length} files:**\n${names.map(n => `- \`${n}\``).join('\n')}`
        messages = [...messages, {
            role: 'user',
            content: label,
            timestamp: new Date(),
            isMarkdown: true,
            commit_hash: commitHash,
        }]
    }

    async function handleDelete(names, commitHash) {
        const { adapter, branch } = await getActiveAdapter()
        files = await adapter.listFiles(branch)
        const label = names.length === 1
            ? `**Deleted:** \`${names[0]}\``
            : `**Deleted ${names.length} files:**\n${names.map(n => `- \`${n}\``).join('\n')}`
        messages = [...messages, {
            role: 'user',
            content: label,
            timestamp: new Date(),
            isMarkdown: true,
            commit_hash: commitHash,
        }]
    }

    function handleLoadMore() {
        // Prepend the just-revealed older range to `messages`. Don't
        // replace `messages` wholesale from the chunk manager — the
        // manager holds a snapshot of history captured at init time
        // and is unaware of live appends (chat turns, uploads). A
        // full replace would drop anything appended after the
        // manager was constructed (symptom: scroll up, scroll back
        // down, your latest reply is gone until reload).
        const older = historyChunks?.loadOlder?.() ?? []
        if (older.length > 0) {
            messages = [...older, ...messages]
            // Reassign to trigger Svelte reactivity for hasMore getter
            historyChunks = historyChunks
        }
    }

    async function handleUndo(index) {
        if (busy || !agentReady) return
        const msg = messages[index]
        if (!msg?.commit_hash) return
        const undoneText = msg.content
        dismissUndoToast()
        busy = true
        try {
            const { adapter, branch } = await getActiveAdapter()
            const preCommit = await adapter.getCurrentCommit(branch)
            await adapter.undoToCommit(branch, msg.commit_hash)
            historyChunks = await loadHistoryChunked()
            messages = historyChunks.messages
            files = await adapter.listFiles(branch)
            previewRefreshKey++
            if (!msg.isMarkdown) inputPrefill = undoneText
            tokenOverride = await adapter.estimateLogTokens(branch)
            // Show toast with option to redo
            const timer = setTimeout(dismissUndoToast, 5000)
            undoToast = { preCommit, timer }
        } catch (e) {
            console.error('Undo failed:', e)
        } finally {
            busy = false
        }
    }

    async function handleRedoFromToast() {
        if (!undoToast || busy || !agentReady) return
        const { preCommit } = undoToast
        dismissUndoToast()
        busy = true
        try {
            const { adapter, branch } = await getActiveAdapter()
            await adapter.undoToCommit(branch, preCommit)
            historyChunks = await loadHistoryChunked()
            messages = historyChunks.messages
            files = await adapter.listFiles(branch)
            previewRefreshKey++
            inputPrefill = ''
            tokenOverride = await adapter.estimateLogTokens(branch)
        } catch (e) {
            console.error('Redo failed:', e)
        } finally {
            busy = false
        }
    }

    async function handleTokenClick() {
        if (!agentReady) return
        tokenModalOpen = true
        try {
            const { adapter, branch } = await getActiveAdapter()
            tokenHistory = await adapter.getTokenHistory(branch)
        } catch (e) {
            console.error('Failed to load token history:', e)
        }
    }

    async function handleChapter() {
        if (busy || !agentReady || chaptering) return
        chaptering = true
        try {
            const { adapter, branch } = await getActiveAdapter()
            await adapter.runChaptering(branch)
            historyChunks = await loadHistoryChunked()
            messages = historyChunks.messages
            tokenOverride = await adapter.estimateLogTokens(branch)
            tokenHistory = await adapter.getTokenHistory(branch)
        } catch (e) {
            console.error('Chaptering failed:', e)
        } finally {
            chaptering = false
        }
    }

    async function handleSend(prompt, attachments = []) {
        if (busy || !agentReady) return
        const trimmed = (prompt || '').trim()
        if (!trimmed && attachments.length === 0) return

        // Claim `busy` BEFORE any await so a double-click on Send
        // re-enters the busy-guard above instead of slipping through
        // while we're partway through an upload. Every early-return
        // path below must reset `busy` (the eventual try/finally for
        // the agent send handles the long-running path); the
        // upload-only path is the one the previous version missed.
        busy = true
        inputPrefill = ''

        const { adapter, branch } = await getActiveAdapter()

        // 1. Push attachments first (if any). This writes them to the
        //    VFS, fires `handleUpload` (creates the upload bubble),
        //    and the FileEvent we now log makes the agent aware on
        //    their next turn. Doing this BEFORE the prompt means the
        //    upload bubble appears above the user's message — natural
        //    reading order ("here are the files I'm asking about").
        if (attachments.length > 0) {
            const uploadCommit = await adapter.getCurrentCommit(branch)
            const fileMap = {}
            for (const att of attachments) fileMap[att.name] = att.bytes
            try {
                await adapter.writeFiles(branch, fileMap)
                await handleUpload(Object.keys(fileMap), uploadCommit)
            } catch (e) {
                console.error('Attachment upload failed:', e)
                messages = [...messages, {
                    role: 'agent',
                    content: `Error uploading files: ${e.message || String(e)}`,
                    errorStack: _captureStack(e),
                    timestamp: new Date(),
                }]
                busy = false
                return
            }
        }

        // 2. If there's no text, we're done — files-only "send"
        //    just creates the upload bubble. The agent will see the
        //    file event next time they get a turn.
        if (!trimmed) {
            busy = false
            return
        }

        const commitHash = await adapter.getCurrentCommit(branch)
        messages = [...messages, {
            role: 'user',
            content: trimmed,
            timestamp: new Date(),
            commit_hash: commitHash,
        }]

        streamingEvents = []
        liveSpawnChips = []
        currentTurn = null
        activeReportText = null
        activeReportIdx = null

        // Snapshot app file state for the post-turn refresh decision —
        // see `appFilesFingerprint` for what this captures and why a
        // diff over this catches every way agents modify app files.
        const preAppFp = await appFilesFingerprint(adapter, branch)

        activeAbort = new AbortController()
        try {
            tokenOverride = null
            const response = await adapter.sendMessage(branch, trimmed, {
                onToken: handleToken,
                signal: activeAbort.signal,
            })
            const cancelled = response.events.some(e => e.type === 'cancelled')

            // Replace streaming message with final message. Spawn chips
            // (live-only, never in response.events) ride along in-memory so
            // the turn's fan-out stays visible until reload.
            const finalMessages = messages.filter(m => !m.streaming)
            const finalEvents = [...response.events, ...liveSpawnChips]
            if (cancelled) {
                messages = [...finalMessages, {
                    role: 'agent',
                    content: { type: 'text', content: '' },
                    events: finalEvents,
                    timestamp: new Date(),
                    cancelled: true,
                }]
            } else {
                messages = [...finalMessages, {
                    role: 'agent',
                    content: response.result,
                    events: finalEvents,
                    timestamp: new Date(),
                }]
            }

            // Refresh file list, preview, and persist session meta
            files = await adapter.listFiles(branch)
            if (!cancelled) {
                // Re-fingerprint app files and refresh the preview if
                // anything under app/ changed during the turn — by any
                // mechanism. file_write / file_edit emissions are only
                // produced when the LLM uses the write_file / edit_file
                // *action tools* directly; common paths like esbuild
                // (terminal_action) and `await fs.write` (ts_action)
                // don't produce those emissions even though they
                // modify app files, so the previous emission-walking
                // check missed them.
                const postAppFp = await appFilesFingerprint(adapter, branch, files)
                if (postAppFp !== preAppFp) previewRefreshKey++
                const lastAction = [...response.events].reverse().find(e => e.type === 'action' && e.title)
                await persistSessionMeta(lastAction?.title || '')
            }
        } catch (e) {
            // Preserve the agent's in-flight emissions when the task
            // errors mid-stream. Without this, the streaming activity
            // card vanishes (filter strips `streaming: true` entries)
            // and the chat just shows a bare "Error: ..." — the user
            // loses all context about what the agent was doing right
            // up to the failure. Snapshot the active turn (if any)
            // and pair the partial events with the error message so
            // the activity card stays visible alongside the error.
            const finalMessages = messages.filter(m => !m.streaming)
            const eventsBeforeError = [...streamingEvents]
            const liveSnapshot = snapshotTurn()
            if (liveSnapshot && liveSnapshot.emissions.length) {
                eventsBeforeError.push(liveSnapshot)
            }
            // Keep any spawn chips (e.g. clones still running when the turn
            // errored/cancelled) so the activity card shows the delegation.
            if (liveSpawnChips.length) {
                eventsBeforeError.push(...liveSpawnChips)
            }
            // User-initiated cancel (handleCancel set `cancelling` true
            // before the abort fired) lands here when the adapter
            // throws on signal abort instead of returning a response
            // with a cancelled event. Render as cancelled, not as a
            // crash — the partial events still show what the agent
            // was doing up to the cancel.
            const userCancelled = cancelling || e?.name === 'AbortError'
            if (userCancelled) {
                messages = [...finalMessages, {
                    role: 'agent',
                    content: { type: 'text', content: '' },
                    events: eventsBeforeError,
                    timestamp: new Date(),
                    cancelled: true,
                }]
            } else {
                console.error('Agent turn failed:', e)
                messages = [...finalMessages, {
                    role: 'agent',
                    content: `Error: ${e.message}`,
                    errorStack: _captureStack(e),
                    events: eventsBeforeError,
                    timestamp: new Date(),
                }]
            }
        } finally {
            // Flush any in-flight report text into a permanent bubble
            // before tearing down. Symmetric with eventsBeforeError —
            // when a cancel / error fires mid-text-emission (before
            // `turn_complete` arrives), the streaming bubble's content
            // would otherwise vanish along with `activeReportText`.
            // No-op for the success path (turn_complete already
            // committed). Idempotent in any case.
            commitActiveReport()
            busy = false
            cancelling = false
            activeAbort = null
            streamingEvents = []
            liveSpawnChips = []
            currentTurn = null
        }
    }

    /** Drive import — opens Google Drive picker, downloads selected
     *  files, writes them to the VFS, and renders the upload bubble.
     *
     *  Different shape from local-file attachments: Drive imports
     *  persist immediately (the existing `importFromDrive` writes
     *  directly to VFS rather than returning byte buffers we'd queue).
     *  So Drive bypasses the pending-attachments queue and goes
     *  straight to "uploaded" state. UX-wise that matches the user's
     *  mental model — "I'm importing from Drive" reads as a complete
     *  action, not as queueing for a later send. */
    async function handleDriveImport() {
        try {
            const written = await importFromDrive()
            if (written.length === 0) return
            const { adapter, branch } = await getActiveAdapter()
            const commitHash = await adapter.getCurrentCommit(branch)
            await handleUpload(written, commitHash)
        } catch (e) {
            console.error('Drive import failed:', e)
        }
    }

    /** Drive availability is gated on (a) the Drive import script
     *  being loaded + auth available and (b) the session not being
     *  external (visitors viewing someone else's published artifact
     *  shouldn't be able to pull from their own Drive). */
    const driveAvailable = $derived(
        isDriveImportAvailable() && !$sessionStore.currentSessionExternal,
    )

    /** Chat-area drag-drop handler. Files dropped anywhere on the
     *  chat surface queue into the pending-attachments store, which
     *  ChatInput renders as chips. Same end-state as `+ Local files`
     *  in the input bar's menu. */
    function handleChatDragOver(e) {
        // Only react to file drags; ignore text-selection drags etc.
        if (!e.dataTransfer?.types?.includes('Files')) return
        e.preventDefault()
        chatDragOver = true
    }

    function handleChatDragLeave(e) {
        if (e.currentTarget === e.target) chatDragOver = false
    }

    async function handleChatDrop(e) {
        if (!e.dataTransfer?.files?.length) return
        e.preventDefault()
        chatDragOver = false
        await queueFiles(e.dataTransfer.files)
    }

    let chatDragOver = $state(false)

    function handleCancel() {
        cancelling = true
        // Two cancel paths, both safe to fire:
        //   - cancelTask: py-only worker-side mechanism (sets a flag in
        //     pyodide's globals; agent loop checks at iteration boundary).
        //     No-op for ts sessions or when no py task is running.
        //   - activeAbort.abort: AbortSignal that the TS adapter forwards
        //     to agex-ts's task call. agex-ts honors AbortSignal natively.
        // Calling both means cancellation works regardless of which
        // kernel the active session is on.
        cancelTask()
        activeAbort?.abort()
    }
</script>

{#snippet chatContent()}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
        class="chat-shell"
        class:drag-over={chatDragOver}
        ondragover={handleChatDragOver}
        ondragleave={handleChatDragLeave}
        ondrop={handleChatDrop}
    >
        {#if chatDragOver}
            <div class="chat-drop-overlay">Drop files to attach</div>
        {/if}
        <Header
            onSettingsClick={() => settingsOpen = true}
            onSessionsClick={() => sessionsOpen = true}
            onFilesClick={() => filesOpen = true}
            onAppReloadClick={() => previewRefreshKey++}
            onChapterClick={handleTokenClick}
            {configured}
            fileCount={files?.length ?? 0}
            showAppReload={hasAppFiles}
            inputTokens={lastInputTokens}
            chapteringTrigger={$settingsStore.chapteringTrigger}
            {activeKernel}
        />

        {#if historyReady}
            <MessageList {messages} {busy} {scrollKey} onUndo={handleUndo} hasMore={historyChunks?.hasMore ?? false} onLoadMore={handleLoadMore} onActionOpen={(i) => actionModalIndex = i} onChapterOpen={(msg) => chapterModalData = msg} />
            {#if !agentReady && warmingMessage}
                <div class="status-row">
                    <span class="spinner"></span>
                    <p>{warmingMessage}</p>
                </div>
            {/if}
            {#if $sessionStore.currentSessionExternal && !configured}
                <div class="external-banner">
                    <p>
                        You're viewing a published artifact.  To continue the conversation with the agent, add an API key in Settings.
                    </p>
                    <button class="banner-btn" onclick={() => settingsOpen = true}>Open Settings</button>
                </div>
            {/if}
            <ChatInput
                onSend={handleSend}
                onCancel={handleCancel}
                onDriveImport={handleDriveImport}
                {driveAvailable}
                {busy}
                {cancelling}
                sendDisabled={busy || !agentReady || !configured}
                prefill={inputPrefill}
                placeholder={configured ? 'Ask the agent...' : 'Add an API key in Settings to chat.'}
            />
        {:else if pyodideError}
            <div class="warming-area error">
                <p>Pyodide failed to load: {pyodideError}</p>
            </div>
        {:else if initError}
            <div class="warming-area error">
                <p>Agent setup failed: {initError}</p>
            </div>
        {:else if configured || isExternalEntry}
            <!-- Startup is actively running (the user has a key, or
                 they came in via a published-artifact URL).  Show
                 the warming spinner with whichever phase is active —
                 ``Downloading bundle... 45%'' during a gist fetch,
                 ``Loading core packages...'' during install, etc. -->
            <div class="warming-area">
                <span class="spinner"></span>
                <p>{warmingMessage || 'Loading...'}</p>
            </div>
        {:else}
            <!-- First-run empty state. The user hasn't configured a key
                 and isn't an external-artifact visitor, so this is
                 likely their first encounter with agex.studio.
                 Documentation-style layout (vs. SaaS landing page):
                 the brand mark sits at the top of a body of prose
                 that describes what this is, a hairline rule, and
                 three actions presented as text-with-explanation
                 rather than buttons. Reads as the first page of a
                 README, not as marketing. -->
            <div class="empty-state">
                <h1 class="empty-brand">
                    <span class="brand-name">agex</span><span class="brand-suffix">.studio</span>
                </h1>
                <div class="empty-body">
                    <p>
                        A browser-based agent workspace. Runs locally as a
                        static page. No backend, no accounts, no subscription.
                    </p>
                    <p>
                        To start, you'll need an API key. OpenRouter is the
                        easiest path (one account, hundreds of models), but
                        the studio also works with direct OpenAI / Anthropic
                        keys or any OpenAI-compatible endpoint, including
                        local models.
                    </p>
                </div>
                <hr class="empty-rule" />
                <ul class="empty-actions">
                    <li>
                        <a class="action-link" href="/gallery/">See examples →</a>
                        <span class="action-detail">browse published sessions — no key needed</span>
                    </li>
                    <li>
                        <a
                            class="action-link"
                            href="https://openrouter.ai/settings/keys"
                            target="_blank"
                            rel="noopener"
                        >Get an OpenRouter key →</a>
                        <span class="action-detail">opens openrouter.ai in a new tab</span>
                    </li>
                    <li>
                        <button class="action-link" onclick={() => settingsOpen = true}>Open Settings</button>
                        <span class="action-detail">paste a key or point at a custom endpoint</span>
                    </li>
                    <li>
                        <a class="action-link" href="/docs/#getting-started">Read the docs →</a>
                        <span class="action-detail">how the studio works, what it can do</span>
                    </li>
                </ul>
            </div>
        {/if}

        <!--
            Py-kernel boot modal.

            Gated on Pyodide's own `status === 'loading'` rather than
            on `activeKernel === 'py'`. Reason: when the user creates
            a py session from a TS session, `createSession` awaits
            `resolveAdapter('py')` (which boots Pyodide, ~30s) BEFORE
            updating the session store / localStorage pointer. So
            during the entire boot, `activeKernel` is still `'ts'` —
            gating on it would never fire the modal for the case we
            care about most.

            `pyodideStore.status` transitions: `idle → loading →
            ready` (or `error`). The `loading` state begins the
            moment `kernelRegistry.ensure('py', ...)` calls
            `startWorker`, covers all three Pyodide waves, and flips
            to `ready` only after rich init completes — exactly the
            window where the user sees nothing happening.

            No flash for already-booted py-session switches: status
            stays at `ready` from the previous session, modal stays
            hidden. TS-only flows never touch pyodideStore.
        -->
        {#if $pyodideStore.status === 'loading' && !initError}
            <div class="boot-modal-overlay" role="dialog" aria-modal="true" aria-live="polite">
                <div class="boot-modal">
                    <h3 class="boot-modal-title">Starting Python kernel</h3>
                    <div class="boot-spinner"></div>
                    <p class="boot-modal-message">{warmingMessage || 'Loading...'}</p>
                    {#if $pyodideStore.progress > 0 && $pyodideStore.progress < 1}
                        <div class="boot-progress-bar" aria-hidden="true">
                            <div class="boot-progress-fill" style="width: {Math.round($pyodideStore.progress * 100)}%"></div>
                        </div>
                    {/if}
                    <p class="boot-modal-hint">
                        First boot downloads Pyodide and the scientific Python
                        stack (~30 seconds, meaningful browser memory).
                        Subsequent boots are cached by a Service Worker.
                    </p>
                </div>
            </div>
        {/if}
    </div>
{/snippet}

<!--
  Keep the preview pane collapsed until the agent is fully ready (Wave
  3 + rich init). `hasAppFiles` flips at Wave 2, so without this guard
  the iframe would mount and start making query() calls that hit the
  sandtrap policy *before* initAgentRich has registered modules like
  `random`, `pandas`, `plotly`. The agent catalog being empty there
  means every `import X` call from the app fails with
  "Import of 'X' is not allowed".
-->
<SplitPane
    collapsed={!hasAppFiles || !agentReady}
    {mobileView}
    {viewMode}
    initialRatio={isExternalEntry ? 0.3 : 0.5}
    onToggleMobileView={() => {
        // Mobile toggle: when bringing chat back into view, bump
        // scrollKey so MessageList re-applies scroll-to-bottom. The
        // chat container had scrollHeight = 0 while hidden, so any
        // prior auto-scroll was a no-op — without this, the user
        // would land mid-history on flip.
        mobileView = mobileView === 'chat' ? 'app' : 'chat'
        if (mobileView === 'chat') scrollKey++
    }}
    onExitAppOnly={() => {
        // Same rationale as above. exitAppOnly always reveals the
        // chat (on desktop via split, on mobile via mobileView='chat').
        viewMode = 'split'
        mobileView = 'chat'
        scrollKey++
    }}
>
    {#snippet children()}
        {@render chatContent()}
    {/snippet}
    {#snippet preview()}
        <AppPreview refreshKey={previewRefreshKey} />
    {/snippet}
</SplitPane>

<SessionDrawer
    open={sessionsOpen}
    onClose={() => sessionsOpen = false}
/>

<FileDrawer
    open={filesOpen}
    onClose={() => filesOpen = false}
    {files}
    onDelete={handleDelete}
    onFilesChanged={(f) => files = f}
/>

<SettingsDrawer
    open={settingsOpen}
    onClose={() => settingsOpen = false}
/>

<ActionModal
    events={actionModalEvents}
    streaming={actionModalStreaming}
    onClose={() => actionModalIndex = -1}
/>

<ChapterModal
    chapter={chapterModalData}
    onClose={() => chapterModalData = null}
/>

{#if undoToast}
    <div class="undo-toast">
        <span>Undone</span>
        <button class="undo-toast-btn" onclick={handleRedoFromToast}>Redo</button>
        <button class="undo-toast-dismiss" onclick={dismissUndoToast}>&times;</button>
    </div>
{/if}

{#if tokenModalOpen}
    <TokenModal
        tokens={tokenHistory}
        current={lastInputTokens}
        trigger={$settingsStore.chapteringTrigger}
        {chaptering}
        onChapter={handleChapter}
        onClose={() => tokenModalOpen = false}
    />
{/if}

<style>
    .chat-shell {
        position: relative;
        height: 100%;
        display: flex;
        flex-direction: column;
        max-width: 900px;
        margin: 0 auto;
        /* Block horizontal swipe-back gestures *inside the editor*
           only — wide content in the chat (markdown tables, long
           code blocks, the activity-card detail) scrolls
           horizontally past the viewport edge, and the browser's
           default "rubber band → navigate back" would yank the
           user away from an in-flight turn. The docs and gallery
           routes don't have this concern and get default
           behavior (so two-finger swipe back works there). */
        overscroll-behavior-x: none;
    }

    /* Drop overlay covers the whole chat-shell during a drag-over.
       Files dropped anywhere on the chat surface queue into the
       pending-attachments store (rendered as chips in ChatInput).
       Same end-state as the `+ Local files` menu action. */
    .chat-drop-overlay {
        position: absolute;
        inset: 0.5rem;
        z-index: 50;
        display: flex;
        align-items: center;
        justify-content: center;
        background: color-mix(in srgb, var(--accent) 18%, transparent);
        border: 2px dashed var(--accent);
        border-radius: 8px;
        font-size: 1rem;
        font-weight: 600;
        color: var(--accent);
        pointer-events: none;
    }

    .warming-area {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 0.6rem;
        color: var(--text-muted);
        font-size: 0.9rem;
        padding: 1rem;
        text-align: center;
    }

    .warming-area p {
        margin: 0;
    }

    .warming-area.error {
        color: #e74c3c;
    }

    /* First-run empty state — when no API key is set yet and this
       isn't an external-artifact visit. Documentation-style
       layout: brand mark at top, prose body, hairline rule, then
       a list of actions presented as text-with-context (not
       buttons). Left-aligned, capped width, optical-vertical
       centering with a slight upward bias so it doesn't feel
       weighted to the floor. */
    .empty-state {
        flex: 1;
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: 1.25rem;
        padding: 3rem 2rem 4rem;
        max-width: 38rem;
        width: 100%;
        margin: 0 auto;
        /* Pull the block up slightly so the gravitational center
           sits above midline — feels more like a deliberately
           positioned piece of content, less like "fallback when
           there's nothing to render." */
        padding-bottom: 6rem;
    }

    /* Brand mark — same shape as the editor header's mark but at
       hero scale. Soft-chunky Fraunces, weight differential
       between `agex` and `.studio`. Reads as a colophon-style
       title rather than an h1 headline. */
    .empty-brand {
        margin: 0;
        font-size: 3.25rem;
        font-weight: 750;
        line-height: 1;
        font-variation-settings: 'opsz' 144, 'SOFT' 100;
        letter-spacing: -0.035em;
        color: var(--text);
    }

    .empty-brand .brand-suffix {
        font-weight: 400;
        color: var(--text-muted);
        font-size: 2.5rem;
    }

    .empty-body {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
    }

    .empty-body p {
        margin: 0;
        color: var(--text-muted);
        line-height: 1.6;
        font-size: 1rem;
        /* Fills the empty-state column. The container's own
           max-width (38rem) keeps lines from running past comfortable
           reading length; an extra ch-based constraint here was
           making the prose hug the left at roughly half the
           container width while the brand mark and action list
           filled it — inconsistent visual rhythm. */
    }

    .empty-rule {
        border: none;
        border-top: 1px solid var(--border);
        margin: 0.25rem 0;
        max-width: 4rem;
    }

    .empty-actions {
        list-style: none;
        padding: 0;
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: 0.65rem;
    }

    .empty-actions li {
        display: flex;
        align-items: baseline;
        gap: 0.75rem;
        flex-wrap: wrap;
    }

    /* Actions are text links + buttons styled as text. Not flashy
       CTAs; this is documentation-aesthetic. The visual weight
       comes from typography (font-family inheritance), not from
       color-filled buttons. */
    .action-link {
        background: none;
        border: none;
        padding: 0;
        font: inherit;
        color: var(--accent);
        cursor: pointer;
        text-decoration: none;
        font-weight: 500;
        white-space: nowrap;
    }

    .action-link:hover {
        text-decoration: underline;
    }

    .action-detail {
        color: var(--text-muted);
        font-size: 0.85rem;
        line-height: 1.4;
    }

    @media (max-width: 600px) {
        .empty-state {
            padding: 2rem 1.25rem 4rem;
        }
        .empty-brand {
            font-size: 2.5rem;
        }
        .empty-brand .brand-suffix {
            font-size: 1.9rem;
        }
    }

    .status-row {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
        padding: 0.35rem 1rem;
        font-size: 0.78rem;
        color: var(--text-muted);
        border-top: 1px solid var(--border);
        flex-shrink: 0;
    }

    .external-banner {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.55rem 0.9rem;
        background: rgba(255, 200, 100, 0.10);
        border-top: 1px solid rgba(255, 165, 0, 0.4);
        border-bottom: 1px solid rgba(255, 165, 0, 0.4);
        flex-shrink: 0;
    }

    .external-banner p {
        margin: 0;
        flex: 1;
        font-size: 0.78rem;
        line-height: 1.35;
        color: var(--text);
    }

    .banner-btn {
        background: var(--accent);
        color: white;
        border: none;
        border-radius: 4px;
        padding: 0.4rem 0.75rem;
        font-size: 0.75rem;
        font-weight: 600;
        cursor: pointer;
        white-space: nowrap;
        flex-shrink: 0;
    }

    .banner-btn:hover {
        filter: brightness(1.1);
    }

    .status-row p {
        margin: 0;
    }

    .spinner {
        width: 14px;
        height: 14px;
        border: 2px solid var(--border);
        border-top-color: var(--text-muted);
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
        to { transform: rotate(360deg); }
    }

    /* Py-kernel cold-boot modal. Full-viewport backdrop with a
       centered panel; covers the gap between "user switched to a
       py session" and "Pyodide reports ready" so the stale chat
       from the previous session isn't the only thing on screen.

       Z-index puts this above SplitPane content but below the
       existing global modals (settings drawer, session drawer,
       etc., which open at 1000+) so the user can still bail out
       via the drawer if needed. */
    .boot-modal-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.65);
        z-index: 500;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 1rem;
    }

    .boot-modal {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 1.5rem 1.75rem;
        max-width: 420px;
        width: 100%;
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
        gap: 0.85rem;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
    }

    .boot-modal-title {
        margin: 0;
        font-size: 1rem;
        font-weight: 600;
        color: var(--text);
    }

    .boot-spinner {
        width: 36px;
        height: 36px;
        border: 3px solid color-mix(in srgb, var(--accent) 25%, transparent);
        border-top-color: var(--accent);
        border-radius: 50%;
        animation: spin 0.9s linear infinite;
        margin: 0.25rem 0;
    }

    .boot-modal-message {
        margin: 0;
        font-size: 0.88rem;
        color: var(--text);
        min-height: 1.2em;
    }

    .boot-progress-bar {
        width: 100%;
        height: 4px;
        background: color-mix(in srgb, var(--text) 10%, transparent);
        border-radius: 2px;
        overflow: hidden;
    }

    .boot-progress-fill {
        height: 100%;
        background: var(--accent);
        transition: width 0.2s ease-out;
    }

    .boot-modal-hint {
        margin: 0;
        font-size: 0.75rem;
        line-height: 1.45;
        color: var(--text-muted);
    }

    .undo-toast {
        position: fixed;
        bottom: 5rem;
        left: 50%;
        transform: translateX(-50%);
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 0.5rem 0.75rem;
        display: flex;
        align-items: center;
        gap: 0.75rem;
        font-size: 0.8rem;
        color: var(--text);
        z-index: 300;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    }

    .undo-toast-btn {
        background: var(--accent);
        color: white;
        border: none;
        border-radius: 4px;
        padding: 0.25rem 0.6rem;
        font-size: 0.75rem;
        font-weight: 600;
        cursor: pointer;
    }

    .undo-toast-btn:hover {
        background: var(--accent-hover);
    }

    .undo-toast-dismiss {
        background: none;
        border: none;
        color: var(--text-muted);
        font-size: 1rem;
        cursor: pointer;
        padding: 0;
        line-height: 1;
    }

    .undo-toast-dismiss:hover {
        color: var(--text);
    }
</style>
