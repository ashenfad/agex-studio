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
    let hasAppFiles = $derived(files.some(f => f === 'app' || f.startsWith('app/')))

    let tokenOverride = $state(null)

    // Undo toast state
    let undoToast = $state(null) // { preCommit, timer }

    function dismissUndoToast() {
        if (undoToast?.timer) clearTimeout(undoToast.timer)
        undoToast = null
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

    // Open settings on first load if no API key — except when the
    // visitor came in via an external-artifact URL.  In that case
    // they're trying to view someone else's published bundle, not
    // configure their own session; popping a settings drawer over
    // the loading artifact is the wrong first impression.  Once
    // the artifact is loaded, a banner inside the chat tells them
    // they need a key to continue the conversation.
    $effect(() => {
        if (!configured && !isExternalEntry) settingsOpen = true
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
                        document.getElementById('static-footer')?.remove()
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
                emissions.push({ kind: 'text', idx: b.idx, text: b.text })
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

    function handleToken(token) {
        // ``turn_complete`` is the explicit end-of-turn signal from
        // Python's ``_on_event`` (fires after ActionEvent lands).  Any
        // lingering ``currentTurn`` is flushed into ``streamingEvents``
        // here; subsequent tokens start a fresh turn.
        if (token.type === 'turn_complete') {
            const snapshot = snapshotTurn()
            if (snapshot && snapshot.emissions.length) {
                streamingEvents = [...streamingEvents, snapshot]
            }
            currentTurn = null
            activeReportText = null
            activeReportIdx = null
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
                const finalText = activeReportText || ''
                if (finalText) {
                    updateBlock(eidx, { kind: 'text', text: finalText })
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
                }
                activeReportText = null
                activeReportIdx = null
            }
        } else if (token.type === 'python') {
            const b = ensureBlock(eidx, 'python')
            updateBlock(eidx, { kind: 'python', code: (b.code || '') + (token.content || '') })
        } else if (token.type === 'ts') {
            // agex-ts code emission — same layout as 'python', different
            // syntax highlighter downstream (EventDetail switches on kind).
            const b = ensureBlock(eidx, 'ts')
            updateBlock(eidx, { kind: 'ts', code: (b.code || '') + (token.content || '') })
        } else if (token.type === 'terminal') {
            const b = ensureBlock(eidx, 'terminal')
            updateBlock(eidx, {
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
        const allEvents = liveSnapshot
            ? [...streamingEvents, liveSnapshot]
            : [...streamingEvents]

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
        if (historyChunks?.loadMore()) {
            messages = historyChunks.messages
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

    async function handleSend(prompt) {
        if (!prompt.trim() || busy || !agentReady) return
        inputPrefill = ''

        const { adapter, branch } = await getActiveAdapter()
        const commitHash = await adapter.getCurrentCommit(branch)

        messages = [...messages, {
            role: 'user',
            content: prompt,
            timestamp: new Date(),
            commit_hash: commitHash,
        }]

        busy = true
        streamingEvents = []
        currentTurn = null
        activeReportText = null
        activeReportIdx = null

        try {
            tokenOverride = null
            const response = await adapter.sendMessage(branch, prompt, { onToken: handleToken })
            const cancelled = response.events.some(e => e.type === 'cancelled')

            // Replace streaming message with final message
            const finalMessages = messages.filter(m => !m.streaming)
            if (cancelled) {
                messages = [...finalMessages, {
                    role: 'agent',
                    content: { type: 'text', content: '' },
                    events: response.events,
                    timestamp: new Date(),
                    cancelled: true,
                }]
            } else {
                messages = [...finalMessages, {
                    role: 'agent',
                    content: response.result,
                    events: response.events,
                    timestamp: new Date(),
                }]
            }

            // Refresh file list, preview, and persist session meta
            files = await adapter.listFiles(branch)
            if (!cancelled) {
                if (response.events.some(e => e.file_actions?.some(fa => fa.path?.startsWith('app/'))))
                    previewRefreshKey++
                const lastAction = [...response.events].reverse().find(e => e.type === 'action' && e.title)
                await persistSessionMeta(lastAction?.title || '')
            }
        } catch (e) {
            const finalMessages = messages.filter(m => !m.streaming)
            messages = [...finalMessages, {
                role: 'agent',
                content: `Error: ${e.message}`,
                timestamp: new Date(),
            }]
        } finally {
            busy = false
            cancelling = false
            streamingEvents = []
            currentTurn = null
            activeReportText = null
            activeReportIdx = null
        }
    }

    function handleCancel() {
        cancelling = true
        cancelTask()
    }
</script>

{#snippet chatContent()}
    <div class="chat-shell">
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
                {busy}
                {cancelling}
                sendDisabled={busy || !agentReady || !configured}
                prefill={inputPrefill}
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
            <div class="warming-area">
                <p>Set your OpenRouter API key in settings to get started.</p>
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
<SplitPane collapsed={!hasAppFiles || !agentReady} {mobileView} onToggleMobileView={() => mobileView = mobileView === 'chat' ? 'app' : 'chat'}>
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
    onUpload={handleUpload}
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
        height: 100%;
        display: flex;
        flex-direction: column;
        max-width: 900px;
        margin: 0 auto;
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
