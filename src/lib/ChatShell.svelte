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
    import { pyodideStore } from './pyodide.js'
    import { initSessionsFromUrl, loadHistoryChunked, sessionStore, CURRENT_BRANCH_KEY } from './sessions.js'
    import { importFromDrive, isDriveImportAvailable } from './drive-import.js'
    import { queueFiles } from './pending-attachments.js'
    import { loadCache as loadSessionCache } from './session-index.js'
    import { kernelRegistry } from './kernel-registry.js'
    import { getActiveAdapter } from './active-adapter.js'
    import { getSessionRuntime, activeTurnCount } from './session-runtime.svelte.js'
    import { setWakeLockDesired } from './wake-lock.js'

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

    // Per-session conversation + streaming state and the agent run loop
    // live in a `SessionRuntime` keyed by branch (session-runtime.svelte.js
    // — see roadmap/concurrent-sessions.md). This shell projects whichever
    // session is foreground via `rt`; view-scoped state (drawers, modals,
    // layout, boot status) stays in this component. `'__boot__'` is a
    // throwaway placeholder runtime until `currentBranch` is resolved.
    let rt = $derived(getSessionRuntime($sessionStore.currentBranch || '__boot__'))
    let settingsOpen = $state(false)
    let sessionsOpen = $state(false)
    let filesOpen = $state(false)
    let agentReady = $state(false)
    let initStatus = $state('')
    let initError = $state('')
    /** @type {'py' | 'ts'} */
    let activeKernel = $state(_resolveActiveKernel())
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
    let tokenModalOpen = $state(false)
    let chapterModalData = $state(null)
    let actionModalIndex = $state(-1)
    let actionModalEvents = $derived(
        actionModalIndex >= 0 && actionModalIndex < rt.messages.length
            ? rt.messages[actionModalIndex].events
            : null
    )
    let actionModalStreaming = $derived(
        actionModalIndex >= 0 && actionModalIndex < rt.messages.length
            ? rt.messages[actionModalIndex].streaming ?? false
            : false
    )
    let configured = $derived($settingsStore.apiKey.length > 0)

    // Keep the screen awake while a turn is in flight, if the user opted
    // in (session-drawer toggle). The wake-lock manager is imperative and
    // re-acquires on `visibilitychange`; we just feed it "desired" here.
    $effect(() => {
        setWakeLockDesired($settingsStore.keepAwake && activeTurnCount() > 0)
    })

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
    let hasAppFiles = $derived(rt.files.some(f => f === 'app' || f.startsWith('app/')))

    function dismissUndoToast() {
        rt.dismissUndoToast()
    }

    let lastInputTokens = $derived.by(() => {
        if (rt.tokenOverride != null) return rt.tokenOverride
        const messages = rt.messages
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
        if (!rt.busy) return
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
                        const { adapter, branch } = await getActiveAdapter()
                        const chunks = await loadHistoryChunked(branch)
                        const target = getSessionRuntime(branch)
                        target.historyChunks = chunks
                        target.messages = chunks.messages
                        target.loaded = true
                        if (target.messages.length && target.messages[target.messages.length - 1].role === 'chaptering') {
                            target.tokenOverride = await adapter.estimateLogTokens(branch)
                        }
                        initStatus = 'Loading files...'
                        target.files = await adapter.listFiles(branch)
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

    // The foreground session is, by definition, seen — clear its
    // "unseen result" badge (set when a turn finishes on a backgrounded
    // session). Re-runs when `rt` changes (foreground switch); only
    // writes, so no reactive loop.
    $effect(() => {
        if (rt) rt.unseen = false
    })

    // Foreground session changed.
    let lastBranch = ''
    $effect(() => {
        const branch = $sessionStore.currentBranch
        if (agentReady && branch && branch !== lastBranch) {
            lastBranch = branch
            // Always scroll the now-foregrounded list to bottom and
            // refresh the preview for the new session (its app may differ).
            scrollKey++
            previewRefreshKey++
            const target = getSessionRuntime(branch)
            // Hydrate from the store ONLY the first time a session opens.
            // An already-loaded runtime holds the authoritative state —
            // live streaming for a running session, or the cached
            // conversation otherwise — so re-reading committed history
            // here would clobber an in-flight turn's uncommitted tail
            // (activity card collapses to "Thinking…" until the next
            // token rebuilds it). undo / chaptering reload explicitly.
            if (!target.loaded) {
                // Branch-explicit throughout: if the user switches again
                // before this async hydration resolves, it must still
                // load `branch` (the session this effect fired for), not
                // whatever's foreground by then.
                loadHistoryChunked(branch).then(async (chunks) => {
                    target.historyChunks = chunks
                    target.messages = chunks.messages
                    target.loaded = true
                    const { adapter } = await getActiveAdapter()
                    if (target.messages.length && target.messages[target.messages.length - 1].role === 'chaptering') {
                        target.tokenOverride = await adapter.estimateLogTokens(branch)
                    } else {
                        target.tokenOverride = null
                    }
                    target.files = await adapter.listFiles(branch)
                })
            }
        }
    })

    // --- Foreground projections of the session runtime --------------
    // Thin wrappers: each reads `rt` (the foreground SessionRuntime) at
    // call time and delegates. The run loop + conversation/streaming
    // state live in the runtime so a session survives the view switching
    // away from it. `agentReady` is a shell/boot concern, threaded in.

    function handleSend(prompt, attachments = []) {
        return rt.send(prompt, attachments, agentReady)
    }

    function handleCancel() {
        rt.cancel()
    }

    function handleUndo(index) {
        return rt.handleUndo(index, agentReady)
    }

    function handleRedoFromToast() {
        return rt.handleRedoFromToast(agentReady)
    }

    function handleChapter() {
        return rt.handleChapter(agentReady)
    }

    function handleLoadMore() {
        rt.handleLoadMore()
    }

    function handleDelete(names, commitHash) {
        return rt.handleDelete(names, commitHash)
    }

    async function handleTokenClick() {
        if (!agentReady) return
        tokenModalOpen = true
        rt.loadTokenHistory()
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
            await rt.handleUpload(written, commitHash)
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
            fileCount={rt.files?.length ?? 0}
            showAppReload={hasAppFiles}
            inputTokens={lastInputTokens}
            chapteringTrigger={$settingsStore.chapteringTrigger}
            {activeKernel}
            hasSessionUpdates={$sessionStore.sessions.some((s) => s.updateUnviewed)}
        />

        {#if historyReady}
            <MessageList messages={rt.messages} busy={rt.busy} {scrollKey} onUndo={handleUndo} hasMore={rt.historyChunks?.hasMore ?? false} onLoadMore={handleLoadMore} onActionOpen={(i) => actionModalIndex = i} onChapterOpen={(msg) => chapterModalData = msg} />
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
                busy={rt.busy}
                cancelling={rt.cancelling}
                sendDisabled={rt.busy || !agentReady || !configured}
                prefill={rt.inputPrefill}
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
        <AppPreview refreshKey={previewRefreshKey + rt.previewTick} />
    {/snippet}
</SplitPane>

<SessionDrawer
    open={sessionsOpen}
    onClose={() => sessionsOpen = false}
/>

<FileDrawer
    open={filesOpen}
    onClose={() => filesOpen = false}
    files={rt.files}
    onDelete={handleDelete}
    onFilesChanged={(f) => rt.files = f}
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

{#if rt.undoToast}
    <div class="undo-toast">
        <span>Undone</span>
        <button class="undo-toast-btn" onclick={handleRedoFromToast}>Redo</button>
        <button class="undo-toast-dismiss" onclick={dismissUndoToast}>&times;</button>
    </div>
{/if}

{#if tokenModalOpen}
    <TokenModal
        tokens={rt.tokenHistory}
        current={lastInputTokens}
        trigger={$settingsStore.chapteringTrigger}
        chaptering={rt.chaptering}
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
