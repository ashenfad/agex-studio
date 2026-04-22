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
    import { initAgentBasics, initAgentRich, sendMessage, listFiles, runChaptering, estimateLogTokens, getTokenHistory } from './agent.js'
    import { cancelTask, pyodideStore, startWave3 } from './pyodide.js'
    import { initSessions, loadHistory, loadHistoryChunked, persistSessionMeta, sessionStore, getCurrentCommit, undoToCommit } from './sessions.js'

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

    // Open settings on first load if no API key
    $effect(() => {
        if (!configured) settingsOpen = true
    })

    // historyReady flips once Wave 2 init + history load have completed.
    // Lets us show real chat earlier than agentReady (which waits for
    // the full Wave 3 registration before Send becomes enabled).
    let historyReady = $state(false)

    // Re-init agent when settings change AND Pyodide has reached at
    // least the history-ready stage. Two-phase: Wave-2 init unlocks
    // history; Wave-3 init unlocks Send.
    let lastKey = ''
    let lastModel = ''
    $effect(() => {
        const s = $settingsStore
        // Read pyodideStore so this effect re-runs when stage advances.
        void $pyodideStore.stage
        if (!s.apiKey) return
        if (s.apiKey === lastKey && s.model === lastModel) return
        lastKey = s.apiKey
        lastModel = s.model
        runStartup(s)
    })

    async function runStartup(s) {
        historyReady = false
        agentReady = false
        initError = ''
        try {
            initStatus = 'Loading core packages...'
            await waitForStage('history-ready')

            initStatus = 'Setting up agent...'
            await initAgentBasics(s)
            initStatus = 'Loading sessions...'
            await initSessions()
            initStatus = 'Loading history...'
            historyChunks = await loadHistoryChunked()
            messages = historyChunks.messages
            if (messages.length && messages[messages.length - 1].role === 'chaptering') {
                tokenOverride = await estimateLogTokens()
            }
            initStatus = 'Loading files...'
            files = await listFiles()
            historyReady = true
            document.getElementById('static-footer')?.remove()

            // Now safe to install Wave 3 packages. Doing it earlier
            // would have blocked basics behind it (Pyodide serializes
            // runPythonAsync calls and Wave 3 wheels don't yield often).
            initStatus = 'Loading capabilities...'
            startWave3()
            await waitForStage('send-ready')
            await initAgentRich(s)
            agentReady = true
            initStatus = ''
        } catch (e) {
            console.error('Agent init failed:', e)
            initError = e.message || String(e)
            initStatus = ''
        }
    }

    /** Resolve once pyodide reaches `target` (or higher). */
    function waitForStage(target) {
        const order = ['idle', 'loading', 'history-ready', 'send-ready']
        const targetIdx = order.indexOf(target)
        return new Promise((resolve, reject) => {
            // Svelte stores invoke the subscriber synchronously during
            // `subscribe(...)`, before `unsub` has been assigned. Stash
            // the resolution and call `unsub` after we have it.
            let settled = false
            let unsub = () => { settled = true }
            const handler = (p) => {
                if (settled) return
                if (p.status === 'error') {
                    settled = true
                    unsub()
                    reject(new Error(p.message || 'Pyodide failed'))
                    return
                }
                if (order.indexOf(p.stage) >= targetIdx) {
                    settled = true
                    unsub()
                    resolve()
                }
            }
            unsub = pyodideStore.subscribe(handler)
            // If the initial sync call already settled, the temporary
            // no-op `unsub` was used — re-call the real one now.
            if (settled) unsub()
        })
    }

    // Combined warming message — surfaces whichever phase is active so
    // the user has some signal that things are happening behind the
    // scenes. Empty string once the agent is fully ready.
    let warmingMessage = $derived.by(() => {
        if (agentReady) return ''
        const py = $pyodideStore
        if (py.status === 'error') return ''  // shown as an error notice instead
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
                if (messages.length && messages[messages.length - 1].role === 'chaptering') {
                    tokenOverride = await estimateLogTokens()
                } else {
                    tokenOverride = null
                }
                files = await listFiles()
                previewRefreshKey++
            })
        }
    })

    // Streaming state — accumulates tokens into events for live display
    let streamingEvents = $state([])
    let currentAction = $state(null)
    // Report streaming accumulator — null when no report is being streamed
    let activeReportText = $state(null)
    // File/edit streaming accumulators
    let currentFilePath = $state(null)
    let currentFileContent = $state('')
    let currentFileMode = $state('write')
    let currentEditPath = $state(null)
    let currentEditContent = $state('')

    function flushFileAction() {
        if (currentFilePath && currentAction) {
            const fa = { kind: 'file', path: currentFilePath, content: currentFileContent, mode: currentFileMode }
            currentAction = { ...currentAction, file_actions: [...currentAction.file_actions, fa] }
        }
        currentFilePath = null
        currentFileContent = ''
        currentFileMode = 'write'
    }

    function flushEditAction() {
        if (currentEditPath && currentAction) {
            // Parse SEARCH/REPLACE from accumulated XML content
            const searchMatch = currentEditContent.match(/<SEARCH>([\s\S]*?)<\/SEARCH>/)
            const replaceMatch = currentEditContent.match(/<REPLACE>([\s\S]*?)<\/REPLACE>/)
            const insertAfterMatch = currentEditContent.match(/<INSERT-AFTER>([\s\S]*?)<\/INSERT-AFTER>/)
            const insertBeforeMatch = currentEditContent.match(/<INSERT-BEFORE>([\s\S]*?)<\/INSERT-BEFORE>/)
            const search = searchMatch ? searchMatch[1] : ''
            let content = ''
            let operation = 'replace'
            if (replaceMatch) { content = replaceMatch[1]; operation = 'replace' }
            else if (insertAfterMatch) { content = insertAfterMatch[1]; operation = 'insert-after' }
            else if (insertBeforeMatch) { content = insertBeforeMatch[1]; operation = 'insert-before' }
            const ea = { kind: 'edit', path: currentEditPath, search, content, operation }
            currentAction = { ...currentAction, file_actions: [...currentAction.file_actions, ea] }
        }
        currentEditPath = null
        currentEditContent = ''
    }

    function handleToken(token) {
        // Only a new title signals a new action iteration — everything else
        // (thinking, code, terminal, file, edit) accumulates into the current one.
        if (token.start && token.type === 'title') {
            flushFileAction()
            flushEditAction()
            if (currentAction) {
                streamingEvents = [...streamingEvents, { ...currentAction }]
            }
            currentAction = {
                type: 'action',
                title: '',
                thinking: '',
                report: '',
                code: null,
                terminal: null,
                file_actions: [],
            }
        }

        // Lazily create an action if tokens arrive before a title.
        // Skip done-only tokens with no content (e.g. the final usage-
        // reporting token) — they're bookkeeping, not a new action.
        if (!currentAction) {
            if (token.done && !token.content) return
            currentAction = {
                type: 'action',
                title: '',
                thinking: '',
                report: '',
                code: null,
                terminal: null,
                file_actions: [],
            }
        }

        if (token.type === 'title') {
            currentAction = { ...currentAction, title: currentAction.title + token.content }
        } else if (token.type === 'thinking') {
            currentAction = { ...currentAction, thinking: currentAction.thinking + token.content }
        } else if (token.type === 'report') {
            if (token.start) {
                activeReportText = ''
            }
            // Always accumulate content before checking done — the final
            // token may carry both content and done=true.
            if (token.content) {
                activeReportText = (activeReportText || '') + token.content
                currentAction = { ...currentAction, report: activeReportText }
            }
            if (token.done) {
                // Commit the finished report as a permanent chat message
                const finalText = activeReportText || ''
                if (finalText) {
                    currentAction = { ...currentAction, report: finalText }
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
            }
        } else if (token.type === 'python') {
            currentAction = { ...currentAction, code: (currentAction.code || '') + token.content }
        } else if (token.type === 'terminal') {
            currentAction = { ...currentAction, terminal: (currentAction.terminal || '') + token.content }
        } else if (token.type === 'file') {
            if (token.done) {
                flushFileAction()
            } else if (token.content.startsWith('path=')) {
                // Flush previous file if any
                flushFileAction()
                // Parse metadata: "path=foo.py,mode=append"
                const pathMatch = token.content.match(/path=([^,]+)/)
                const modeMatch = token.content.match(/mode=([^,]+)/)
                currentFilePath = pathMatch ? pathMatch[1] : null
                currentFileMode = modeMatch ? modeMatch[1] : 'write'
                currentFileContent = ''
            } else if (currentFilePath) {
                currentFileContent += token.content
            }
        } else if (token.type === 'edit') {
            if (token.done) {
                flushEditAction()
            } else if (token.content.startsWith('path=')) {
                flushEditAction()
                const pathMatch = token.content.match(/path=([^,]+)/)
                currentEditPath = pathMatch ? pathMatch[1] : null
                currentEditContent = ''
            } else if (currentEditPath) {
                currentEditContent += token.content
            }
        } else if (token.type === 'file_action') {
            // Tool-use wire format emits a single already-structured
            // action token (no streaming assembly needed). It may arrive
            // before the title, between thinking/code, or even after the
            // main python/terminal action has flushed — handle all three.
            if (!token.action) { /* no-op */ }
            else if (currentAction) {
                currentAction = {
                    ...currentAction,
                    file_actions: [...currentAction.file_actions, token.action],
                }
            } else if (
                streamingEvents.length &&
                streamingEvents[streamingEvents.length - 1].type === 'action'
            ) {
                // Main action has already been committed to streamingEvents
                // (e.g. python_action finished before write_file's
                // tool-call end). Attach to that same action.
                const last = streamingEvents[streamingEvents.length - 1]
                const updated = {
                    ...last,
                    file_actions: [...(last.file_actions || []), token.action],
                }
                streamingEvents = [...streamingEvents.slice(0, -1), updated]
            } else {
                // Stray file_action with no surrounding action — stand up a
                // minimal one so it has a home.
                currentAction = {
                    type: 'action',
                    title: '',
                    thinking: '',
                    report: '',
                    code: null,
                    terminal: null,
                    file_actions: [token.action],
                }
            }
        }

        // End-of-action: <PYTHON> and <TERMINAL> are the action's final
        // section, so a done=true on either means this iteration is complete.
        // Flush the currentAction into streamingEvents so the next iteration
        // starts fresh — even if the agent skips its <TITLE> on that turn.
        if (token.done && (token.type === 'python' || token.type === 'terminal')) {
            flushFileAction()
            flushEditAction()
            if (currentAction) {
                streamingEvents = [...streamingEvents, { ...currentAction }]
                currentAction = null
            }
        }

        // Build streaming file_actions including in-progress ones
        let liveFileActions = [...(currentAction?.file_actions || [])]
        if (currentFilePath) {
            liveFileActions.push({ kind: 'file', path: currentFilePath, content: currentFileContent, mode: currentFileMode })
        }

        const liveAction = currentAction
            ? { ...currentAction, file_actions: liveFileActions }
            : null
        const allEvents = liveAction
            ? [...streamingEvents, liveAction]
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
        files = await listFiles()
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
        files = await listFiles()
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
            const preCommit = await getCurrentCommit()
            await undoToCommit(msg.commit_hash)
            historyChunks = await loadHistoryChunked()
            messages = historyChunks.messages
            files = await listFiles()
            previewRefreshKey++
            if (!msg.isMarkdown) inputPrefill = undoneText
            tokenOverride = await estimateLogTokens()
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
            await undoToCommit(preCommit)
            historyChunks = await loadHistoryChunked()
            messages = historyChunks.messages
            files = await listFiles()
            previewRefreshKey++
            inputPrefill = ''
            tokenOverride = await estimateLogTokens()
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
            tokenHistory = await getTokenHistory()
        } catch (e) {
            console.error('Failed to load token history:', e)
        }
    }

    async function handleChapter() {
        if (busy || !agentReady || chaptering) return
        chaptering = true
        try {
            await runChaptering()
            historyChunks = await loadHistoryChunked()
            messages = historyChunks.messages
            tokenOverride = await estimateLogTokens()
            tokenHistory = await getTokenHistory()
        } catch (e) {
            console.error('Chaptering failed:', e)
        } finally {
            chaptering = false
        }
    }

    async function handleSend(prompt) {
        if (!prompt.trim() || busy || !agentReady) return
        inputPrefill = ''

        const commitHash = await getCurrentCommit()

        messages = [...messages, {
            role: 'user',
            content: prompt,
            timestamp: new Date(),
            commit_hash: commitHash,
        }]

        busy = true
        streamingEvents = []
        currentAction = null
        activeReportText = null
        currentFilePath = null
        currentFileContent = ''
        currentFileMode = 'write'
        currentEditPath = null
        currentEditContent = ''

        try {
            tokenOverride = null
            const response = await sendMessage(prompt, handleToken)
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
            files = await listFiles()
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
            currentAction = null
            activeReportText = null
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
        />

        {#if historyReady}
            <MessageList {messages} {busy} {scrollKey} onUndo={handleUndo} hasMore={historyChunks?.hasMore ?? false} onLoadMore={handleLoadMore} onActionOpen={(i) => actionModalIndex = i} onChapterOpen={(msg) => chapterModalData = msg} />
            {#if !agentReady && warmingMessage}
                <div class="status-row">
                    <span class="spinner"></span>
                    <p>{warmingMessage}</p>
                </div>
            {/if}
            <ChatInput
                onSend={handleSend}
                onCancel={handleCancel}
                {busy}
                {cancelling}
                sendDisabled={busy || !agentReady}
                prefill={inputPrefill}
            />
        {:else if !configured}
            <div class="warming-area">
                <p>Set your OpenRouter API key in settings to get started.</p>
            </div>
        {:else if pyodideError}
            <div class="warming-area error">
                <p>Pyodide failed to load: {pyodideError}</p>
            </div>
        {:else if initError}
            <div class="warming-area error">
                <p>Agent setup failed: {initError}</p>
            </div>
        {:else}
            <div class="warming-area">
                <span class="spinner"></span>
                <p>{warmingMessage || 'Loading...'}</p>
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
