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
    import { initAgent, sendMessage, listFiles, runChaptering, estimateLogTokens, getTokenHistory } from './agent.js'
    import { cancelTask } from './pyodide.js'
    import { initSessions, loadHistory, loadHistoryChunked, persistSessionMeta, sessionStore, getCurrentCommit, undoToCommit } from './sessions.js'
    import { tryRestore, refreshIfNeeded } from './google-auth.js'
    import { onMount } from 'svelte'

    // Refresh stale Google token on first user interaction (click/key)
    onMount(() => {
        function onFirstGesture() {
            refreshIfNeeded().catch(() => {})
            document.removeEventListener('click', onFirstGesture)
            document.removeEventListener('keydown', onFirstGesture)
            window.removeEventListener('blur', onFirstGesture)
        }
        document.addEventListener('click', onFirstGesture, { once: true })
        document.addEventListener('keydown', onFirstGesture, { once: true })
        // Clicking inside the iframe doesn't bubble to document, but blurs the parent window
        window.addEventListener('blur', onFirstGesture, { once: true })

        // Refresh app preview when Google auth completes (e.g. after re-auth)
        function onGoogleToken() { previewRefreshKey++ }
        window.addEventListener('google-auth-token', onGoogleToken)
        return () => window.removeEventListener('google-auth-token', onGoogleToken)
    })

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

    // Re-init agent when settings change
    let lastKey = ''
    let lastModel = ''
    $effect(() => {
        const s = $settingsStore
        if (s.apiKey && (s.apiKey !== lastKey || s.model !== lastModel)) {
            lastKey = s.apiKey
            lastModel = s.model
            agentReady = false
            initError = ''
            initStatus = 'Setting up agent...'
            initAgent(s).then(async () => {
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
                agentReady = true
                // Silently restore Google token if previously connected
                tryRestore().catch(() => {})
            }).catch((e) => {
                console.error('Agent init failed:', e)
                initError = e.message || String(e)
                initStatus = ''
            })
        }
    })

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
                code: null,
                terminal: null,
                file_actions: [],
            }
        }

        // Lazily create an action if tokens arrive before a title
        if (!currentAction) {
            currentAction = {
                type: 'action',
                title: '',
                thinking: '',
                code: null,
                terminal: null,
                file_actions: [],
            }
        }

        if (token.type === 'title') {
            currentAction = { ...currentAction, title: currentAction.title + token.content }
        } else if (token.type === 'thinking') {
            currentAction = { ...currentAction, thinking: currentAction.thinking + token.content }
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
        const streamMsg = {
            role: 'agent',
            content: '',
            events: allEvents,
            timestamp: new Date(),
            streaming: true,
        }
        const lastMsg = messages[messages.length - 1]
        if (lastMsg?.streaming) {
            messages = [...messages.slice(0, -1), streamMsg]
        } else {
            messages = [...messages, streamMsg]
        }
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
        busy = true
        try {
            await undoToCommit(msg.commit_hash)
            historyChunks = await loadHistoryChunked()
            messages = historyChunks.messages
            files = await listFiles()
            previewRefreshKey++
            if (!msg.isMarkdown) inputPrefill = undoneText
            tokenOverride = await estimateLogTokens()
        } catch (e) {
            console.error('Undo failed:', e)
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
            onChapterClick={handleTokenClick}
            {configured}
            fileCount={files?.length ?? 0}
            inputTokens={lastInputTokens}
            chapteringTrigger={$settingsStore.chapteringTrigger}
        />

        {#if !configured}
            <div class="notice">
                <p>Set your OpenRouter API key to get started.</p>
            </div>
        {:else if initError}
            <div class="notice error">
                <p>Agent setup failed: {initError}</p>
            </div>
        {:else if !agentReady}
            <div class="notice">
                <span class="spinner"></span>
                <p>{initStatus || 'Initializing...'}</p>
            </div>
        {:else}
            <MessageList {messages} {busy} {scrollKey} onUndo={handleUndo} hasMore={historyChunks?.hasMore ?? false} onLoadMore={handleLoadMore} onActionOpen={(i) => actionModalIndex = i} onChapterOpen={(msg) => chapterModalData = msg} />
            <ChatInput onSend={handleSend} onCancel={handleCancel} {busy} {cancelling} disabled={busy || !agentReady} prefill={inputPrefill} />
        {/if}
    </div>
{/snippet}

<SplitPane collapsed={!hasAppFiles} {mobileView} onToggleMobileView={() => mobileView = mobileView === 'chat' ? 'app' : 'chat'}>
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

    .notice {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        color: var(--text-muted);
        font-size: 0.85rem;
        gap: 0.5rem;
    }

    .notice.error {
        color: #e74c3c;
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
</style>
