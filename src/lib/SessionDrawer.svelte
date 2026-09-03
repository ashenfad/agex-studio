<script>
    import {
        sessionStore,
        createSession,
        switchSession,
        deleteSession,
        forkSession,
        forkSessionFreshChat,
        forkSessionCompact,
        importBundle,
        inspectBundle,
        profilePublishSizes,
        hasSeenPyExperimentalWarning,
        markPyExperimentalWarningSeen,
        updateImportedSession,
        dismissImportedUpdate,
        checkImportedUpdates,
        markImportedUpdatesSeen,
    } from './sessions.js'
    import { peekSessionRuntime } from './session-runtime.svelte.js'
    import { settingsStore } from './settings.js'
    import ForkModal from './ForkModal.svelte'
    import PyWarningModal from './PyWarningModal.svelte'
    import ImportModal from './ImportModal.svelte'
    import DeleteModeModal from './DeleteModeModal.svelte'
    import SessionRow from './SessionRow.svelte'
    import SessionSettingsModal from './SessionSettingsModal.svelte'
    import ExportModal from './ExportModal.svelte'
    import PublishModal from './PublishModal.svelte'
    import TrashSection from './TrashSection.svelte'
    import DrawerFooter from './DrawerFooter.svelte'
    import { createExportFlow } from './export-flow.svelte.js'
    import { createPublishFlow } from './publish-flow.svelte.js'
    import {
        downloadRemoteSession,
        isSyncEnabled,
        keepLocalVersion,
        pushLocalOverRemote,
        refreshRoster,
        useRemoteVersion,
        repushSession,
        setSyncEnabled,
        syncNow,
        syncRosterStore,
        syncStatusStore,
    } from './sync-engine.js'

    /** @type {{ open: boolean, onClose: () => void }} */
    let { open, onClose } = $props()

    let sessions = $derived($sessionStore.sessions)
    // "Kept" apps pinned into their own group at the top — the MVP
    // launcher: starred sessions are always one tap away regardless of
    // how far their chat has slid down the recency list. Both lists keep
    // the store's updated-desc order (filter preserves it).
    let starredSessions = $derived(sessions.filter((s) => s.starred))
    let otherSessions = $derived(sessions.filter((s) => !s.starred))
    let syncConnected = $derived(Boolean($settingsStore.syncRepo && $settingsStore.syncPat))

    // Re-rendered each minute while the drawer is open so the
    // relative "last synced" times don't go stale.
    let nowTick = $state(Date.now())
    $effect(() => {
        if (!open) return
        nowTick = Date.now()
        const timer = setInterval(() => {
            nowTick = Date.now()
        }, 60_000)
        return () => clearInterval(timer)
    })

    // Per-branch resolution state for the inline attention rows.
    let resolvingBranch = $state('')

    async function handleRetrySync(branch) {
        resolvingBranch = branch
        try {
            await syncNow(branch)
        } finally {
            resolvingBranch = ''
        }
    }

    async function handleRepush(branch) {
        resolvingBranch = branch
        try {
            await repushSession(branch)
        } catch (err) {
            console.error('Re-push failed:', err)
        } finally {
            resolvingBranch = ''
        }
    }

    function handleKeepLocal(branch) {
        setSyncEnabled(branch, false)
    }

    // --- Roster / lifecycle actions ---
    let downloadingStub = $state('')

    // Refresh the remote roster whenever the drawer opens (cheap:
    // a couple of GETs; engine no-ops when sync isn't connected).
    $effect(() => {
        if (open) void refreshRoster()
    })

    async function handleStubDownload(branch) {
        downloadingStub = branch
        try {
            await downloadRemoteSession(branch)
        } finally {
            downloadingStub = ''
        }
    }

    /** Run one divergence resolution, holding the row in its busy
     *  state. None of the three needs an arm-then-confirm step: the
     *  old "Take synced" had one because it destroyed local turns
     *  outright, and every path now preserves what it moves away from. */
    async function resolveDivergence(branch, fn, label) {
        if (resolvingBranch) return
        resolvingBranch = branch
        try {
            await fn(branch)
        } catch (err) {
            console.error(`${label} failed:`, err)
        } finally {
            resolvingBranch = ''
        }
    }
    let currentBranch = $derived($sessionStore.currentBranch)

    // On open: mark available updates as seen (clears the Header badge),
    // then re-poll imported sessions for newer gist revisions (lazy /
    // TTL-gated, so most are no-ops).
    $effect(() => {
        if (open) {
            markImportedUpdatesSeen()
            void checkImportedUpdates($settingsStore.githubPat)
        }
    })

    /** @type {string | null} */
    let updatingBranch = $state(null)

    async function handleUpdate(branch) {
        if (updatingBranch) return
        updatingBranch = branch
        try {
            await updateImportedSession(branch)
            // The session switched to the updated/opened version — close
            // the drawer so the user lands on it.
            onClose()
        } catch (e) {
            console.error('Session update failed:', e)
        } finally {
            updatingBranch = null
        }
    }

    // Manual "check for updates" — force-bypasses the lazy TTL on the
    // boot/open checks. Shown only when there are imported sessions.
    let hasImported = $derived(sessions.some((s) => s.imported))
    /** null | 'checking' | a transient result message */
    let checkState = $state(null)
    let checkTimer = null

    async function handleCheckUpdates() {
        if (checkState === 'checking') return
        checkState = 'checking'
        if (checkTimer) clearTimeout(checkTimer)
        try {
            const { updates } = await checkImportedUpdates(
                $settingsStore.githubPat,
                { force: true },
            )
            checkState =
                updates > 0
                    ? `${updates} update${updates === 1 ? '' : 's'} available`
                    : 'Up to date'
        } catch (e) {
            console.error('Update check failed:', e)
            checkState = 'Check failed'
        } finally {
            checkTimer = setTimeout(() => {
                checkState = null
            }, 4000)
        }
    }

    let deleteConfirmBranch = $state(null)
    /** Branch currently being deleted. Set immediately before
     *  `await deleteSession(...)` so the row can show a spinner /
     *  disable interaction; cleared in the surrounding finally. */
    let deletingBranch = $state(null)

    /** Which session's "⋯" overflow menu is currently open. Only
     *  surfaces at the mobile breakpoint (≤768px); on desktop the
     *  three individual icon buttons stay visible and this stays
     *  null. */
    let actionsMenuBranch = $state(null)

    /** Session being edited in the settings modal, or null when closed.
     *  The modal (SessionSettingsModal) owns its own draft fields. */
    let editingSession = $state(null)

    /** Bundle being previewed before import, or null when no file loaded. */
    let importPreview = $state(null)  // { bytes, manifest }
    let importing = $state(false)
    let importError = $state('')

    // Export / publish flows — stage machines live in their own modules
    // (export-flow.svelte.js / publish-flow.svelte.js); ExportModal /
    // PublishModal render them. Launched from the per-session settings
    // modal below.
    const exportFlow = createExportFlow()
    const publishFlow = createPublishFlow()

    /** @type {HTMLInputElement | undefined} */
    let fileInput = $state()

    $effect(() => {
        if (open) {
            deleteConfirmBranch = null
        }
    })


    /** Pending kernel for the experimental-warning modal — set when
     *  the user clicks `+ Py` on a browser that hasn't dismissed the
     *  warning yet. `null` when the modal is closed. */
    let pendingPyConfirm = $state(false)

    /** Whether the "more create options" dropdown is open. The split-
     *  button design keeps `+ New` (TS) as the dominant action and
     *  tucks the experimental py-create behind a chevron edge. */
    let createMenuOpen = $state(false)

    async function handleNew(kernel, opts = {}) {
        if (kernel === 'py' && !hasSeenPyExperimentalWarning()) {
            pendingPyConfirm = true
            return
        }
        try {
            await createSession({ kernel, ...opts })
            onClose()
        } catch (e) {
            console.error('Failed to create session:', e)
        }
    }

    async function confirmPyCreate() {
        markPyExperimentalWarningSeen()
        pendingPyConfirm = false
        try {
            await createSession({ kernel: 'py' })
            onClose()
        } catch (e) {
            console.error('Failed to create session:', e)
        }
    }

    // ForkModal state. We collect the source-branch title at
    // click time so the modal stays purely presentational — given
    // a title + a confirm callback, it doesn't reach into the
    // session store itself.
    let forkModalOpen = $state(false)
    let forkSourceBranch = $state(null)

    /** @type {{ title: string, kernel: string } | null} */
    let forkSourceInfo = $derived.by(() => {
        if (!forkSourceBranch) return null
        const s = $sessionStore.sessions.find((x) => x.branch === forkSourceBranch)
        if (!s) return null
        return { title: s.title || 'New Chat', kernel: s.kernel || 'py' }
    })

    /** Size estimates for the compact-copy option; null while
     *  loading (the option works without numbers). */
    let forkEstimates = $state(null)

    async function handleFork(e, branch) {
        e.stopPropagation()
        forkSourceBranch = branch
        forkEstimates = null
        forkModalOpen = true
        const session = $sessionStore.sessions.find((x) => x.branch === branch)
        if (session?.kernel !== 'ts') return
        try {
            const sized = await profilePublishSizes(branch)
            // Guard against the modal having moved on to another
            // session (or closed) while we profiled.
            if (forkModalOpen && forkSourceBranch === branch) {
                forkEstimates = sized?.estimates ?? null
            }
        } catch (err) {
            console.warn('fork size profile failed:', err)
        }
    }

    async function handleForkConfirm(mode, opts) {
        const branch = forkSourceBranch
        if (!branch) return
        try {
            if (branch !== currentBranch) {
                await switchSession(branch)
            }
            if (mode === 'fresh') {
                await forkSessionFreshChat()
            } else if (mode === 'compact') {
                await forkSessionCompact({ images: opts?.images ?? 'downsample' })
            } else {
                await forkSession()
            }
            forkModalOpen = false
            forkSourceBranch = null
        } catch (err) {
            console.error('Failed to fork session:', err)
            // Leave the modal open so the user can retry / cancel
            // rather than silently losing their click.
        }
    }

    async function handleSwitch(branch) {
        if (branch === currentBranch) return
        try {
            await switchSession(branch)
        } catch (e) {
            console.error('Failed to switch session:', e)
        }
    }

    /** Delete-mode modal for synced sessions: { branch, title, mode }
     *  where mode is 'device' (remove locally, keep shared) or
     *  'everywhere' (archive to trash, propagate). null = closed. */
    let deleteModal = $state(null)

    async function handleDelete(e, branch) {
        e.stopPropagation()
        const s = sessions.find((x) => x.branch === branch)
        // Synced ts sessions carry two delete meanings (this device vs
        // everywhere) — open the chooser. Local-only sessions have a
        // single meaning, so keep the lightweight two-tap inline confirm.
        if (s && syncConnected && s.kernel === 'ts' && isSyncEnabled(branch)) {
            deleteConfirmBranch = null
            closeActionsMenu()
            // Same precedence as the session list: user-curated name
            // wins over the agent-generated title.
            deleteModal = { branch, title: s.name || s.title || 'this session', mode: 'device' }
            return
        }
        if (deleteConfirmBranch !== branch) {
            deleteConfirmBranch = branch
            return
        }
        deleteConfirmBranch = null
        await runDelete(branch)
    }

    /** Shared delete execution + row spinner. The delete includes the
     *  kvgit orphan sweep (see ts-agent.js deleteBranch), which can run
     *  for a multi-MB session — without the spinner the row just sits
     *  silent. */
    async function runDelete(branch, opts) {
        deletingBranch = branch
        try {
            await deleteSession(branch, opts)
        } catch (e) {
            console.error('Failed to delete session:', e)
        } finally {
            deletingBranch = null
        }
    }

    async function confirmDeleteModal() {
        if (!deleteModal) return
        const { branch, mode } = deleteModal
        deleteModal = null
        await runDelete(branch, { mode })
    }

    /** Toggle the mobile "⋯" overflow menu for a given session row.
     *  Tapping the same row's button again closes it; opening one
     *  row's menu while another is open closes the other. */
    function toggleActionsMenu(e, branch) {
        e.stopPropagation()
        actionsMenuBranch = actionsMenuBranch === branch ? null : branch
        // Reset any in-flight delete confirm when opening a fresh
        // menu so the destructive item shows its initial label.
        if (actionsMenuBranch !== branch) deleteConfirmBranch = null
    }

    function closeActionsMenu() {
        actionsMenuBranch = null
    }

    // Export / publish launch from the settings modal: close it first,
    // then hand the session to the flow.
    function handleSettingsExport(session) {
        editingSession = null
        exportFlow.start(session)
    }

    function handleSettingsPublish(session) {
        editingSession = null
        publishFlow.start(session)
    }

    function handleEdit(e, session) {
        e.stopPropagation()
        editingSession = session
    }

    function openImportPicker() {
        importError = ''
        fileInput?.click()
    }

    async function handleFileSelected(e) {
        const file = e.target.files?.[0]
        e.target.value = ''  // reset so same file re-select fires change
        if (!file) return
        importError = ''
        try {
            const bytes = new Uint8Array(await file.arrayBuffer())
            const manifest = await inspectBundle(bytes)
            importPreview = { bytes, manifest }
        } catch (err) {
            console.error('Failed to read bundle:', err)
            importError = `Could not read bundle: ${err.message || err}`
        }
    }

    function closeImportPreview() {
        if (importing) return
        importPreview = null
        importError = ''
    }

    async function handleConfirmImport() {
        if (!importPreview || importing) return
        importing = true
        try {
            await importBundle(importPreview.bytes)
            importPreview = null
            onClose()
        } catch (err) {
            console.error('Failed to import bundle:', err)
            importError = `Import failed: ${err.message || err}`
        } finally {
            importing = false
        }
    }

</script>

{#if open}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="overlay" onclick={onClose} onkeydown={(e) => e.key === 'Escape' && onClose()}></div>
    <div class="drawer">
        <div class="drawer-header">
            <h2>Sessions</h2>
            <div class="header-actions">
                <button class="header-btn" onclick={openImportPicker} title="Import a bundle">Import</button>
                <div class="split-btn-group">
                    <button
                        class="new-btn kernel-ts split-btn-main"
                        onclick={() => handleNew('ts')}
                        title="New TypeScript session (recommended)"
                    >+ New</button>
                    <button
                        class="split-btn-edge"
                        onclick={() => (createMenuOpen = !createMenuOpen)}
                        title="More create options"
                        aria-label="More create options"
                        aria-expanded={createMenuOpen}
                    >
                        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="3 5 6 8 9 5"></polyline>
                        </svg>
                    </button>
                    {#if createMenuOpen}
                        <!-- svelte-ignore a11y_no_static_element_interactions -->
                        <div
                            class="split-menu-backdrop"
                            onclick={() => (createMenuOpen = false)}
                            onkeydown={(e) => e.key === 'Escape' && (createMenuOpen = false)}
                        ></div>
                        <div class="split-menu" role="menu">
                            <button
                                class="split-menu-item"
                                role="menuitem"
                                onclick={() => { createMenuOpen = false; handleNew('py') }}
                            >
                                <span class="split-menu-item-label">Python session</span>
                                <span class="split-menu-item-tag">experimental</span>
                            </button>
                            {#if syncConnected}
                                <!-- Only worth offering when sync is on;
                                     without it every session is already
                                     local-only and the item would be a
                                     no-op that implies otherwise. -->
                                <button
                                    class="split-menu-item"
                                    role="menuitem"
                                    title="Stays on this device — never uploaded to the sync repo"
                                    onclick={() => { createMenuOpen = false; handleNew('ts', { sync: false }) }}
                                >
                                    <span class="split-menu-item-label">Local-only session</span>
                                    <span class="split-menu-item-tag">not synced</span>
                                </button>
                            {/if}
                        </div>
                    {/if}
                </div>
            </div>
        </div>
        <input
            bind:this={fileInput}
            type="file"
            accept=".agex,.zip,application/zip"
            style="display: none"
            onchange={handleFileSelected}
        />
        {#if importError}
            <div class="import-error">{importError}</div>
        {/if}

        {#if hasImported}
            <div class="update-check-bar">
                <button
                    class="update-check-btn"
                    onclick={handleCheckUpdates}
                    disabled={checkState === 'checking'}
                    title="Check imported sessions for newer gist revisions"
                >{checkState === 'checking' ? 'Checking…' : 'Check for updates'}</button>
                {#if checkState && checkState !== 'checking'}
                    <span class="update-check-status">{checkState}</span>
                {/if}
            </div>
        {/if}

        {#snippet sessionRow(s)}
            {@const rt = peekSessionRuntime(s.branch)}
            <SessionRow
                session={s}
                active={s.branch === currentBranch}
                runtime={rt}
                syncStatus={$syncStatusStore[s.branch]}
                {syncConnected}
                localOnly={syncConnected && s.kernel === 'ts' && !isSyncEnabled(s.branch)}
                {nowTick}
                canDelete={sessions.length > 1}
                updating={updatingBranch === s.branch}
                resolving={resolvingBranch === s.branch}
                deleting={deletingBranch === s.branch}
                deleteBusy={!!deletingBranch}
                deleteArmed={deleteConfirmBranch === s.branch}
                menuOpen={actionsMenuBranch === s.branch}
                onSwitch={() => handleSwitch(s.branch)}
                onFork={(e) => handleFork(e, s.branch)}
                onEdit={(e) => handleEdit(e, s)}
                onDelete={(e) => handleDelete(e, s.branch)}
                onUpdate={() => handleUpdate(s.branch)}
                onDismissUpdate={() => dismissImportedUpdate(s.branch)}
                onPushLocal={() => resolveDivergence(s.branch, pushLocalOverRemote, 'Push local over remote')}
                onUseRemote={() => resolveDivergence(s.branch, useRemoteVersion, 'Use remote version')}
                onKeepThisDevice={() => resolveDivergence(s.branch, keepLocalVersion, 'Keep local version')}
                onRetrySync={() => handleRetrySync(s.branch)}
                onRepush={() => handleRepush(s.branch)}
                onKeepLocal={() => handleKeepLocal(s.branch)}
                onToggleMenu={(e) => toggleActionsMenu(e, s.branch)}
                onCloseMenu={closeActionsMenu}
            />
        {/snippet}

        <div class="session-list">
            {#if starredSessions.length > 0}
                <!-- Pinned "Apps" group: kept ts+app sessions, always at
                     the top so they don't slide away as chats age. -->
                <div class="group-label">Apps</div>
                {#each starredSessions as s (s.branch)}
                    {@render sessionRow(s)}
                {/each}
                {#if otherSessions.length > 0}
                    <div class="group-label">Recent</div>
                {/if}
            {/if}
            {#each otherSessions as s (s.branch)}
                {@render sessionRow(s)}
            {/each}

            <!-- Cloud stubs: sessions that exist in the sync repo but
                 not on this device. Download materializes them. -->
            {#if syncConnected}
                {#each $syncRosterStore.remoteOnly as r (r.branch)}
                    <div class="session-item cloud-stub">
                        <div class="stub-title">☁ {r.title || 'Cloud session'}</div>
                        <div class="session-meta">
                            <span class="session-date"><code>{r.branch}</code></span>
                            <button
                                class="action-btn stub-download"
                                disabled={downloadingStub === r.branch}
                                onclick={() => handleStubDownload(r.branch)}
                            >
                                {downloadingStub === r.branch
                                    ? $syncStatusStore[r.branch]?.detail || 'Downloading…'
                                    : 'Download'}
                            </button>
                        </div>
                    </div>
                {/each}
            {/if}
        </div>

        <TrashSection {syncConnected} />

        <!-- Gallery entry — sits below the session list. Opens the
             static `/gallery/` page in the same tab; users return to
             the editor via the gallery's own "Open editor" button.
             Hidden when the gallery JSON is empty would be nice but
             requires a fetch; for the very small steady-state size
             (a handful of items), always-show is fine. -->
        <a class="gallery-link" href="/gallery/">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="3" y="3" width="7" height="7" rx="1"></rect>
                <rect x="14" y="3" width="7" height="7" rx="1"></rect>
                <rect x="3" y="14" width="7" height="7" rx="1"></rect>
                <rect x="14" y="14" width="7" height="7" rx="1"></rect>
            </svg>
            <span>Browse gallery</span>
            <span class="gallery-link-chevron">→</span>
        </a>


        <DrawerFooter />
    </div>
{/if}

{#if exportFlow.state}
    <ExportModal flow={exportFlow} />
{/if}

{#if publishFlow.state}
    <PublishModal flow={publishFlow} />
{/if}

{#if importPreview}
    <ImportModal
        preview={importPreview}
        {importing}
        error={importError}
        onCancel={closeImportPreview}
        onConfirm={handleConfirmImport}
    />
{/if}

{#if pendingPyConfirm}
    <PyWarningModal
        onCancel={() => (pendingPyConfirm = false)}
        onConfirm={confirmPyCreate}
    />
{/if}

{#if editingSession}
    <SessionSettingsModal
        session={editingSession}
        {syncConnected}
        actionsBusy={!!exportFlow.state || !!publishFlow.state}
        onClose={() => editingSession = null}
        onExport={handleSettingsExport}
        onPublish={handleSettingsPublish}
    />
{/if}

<ForkModal
    open={forkModalOpen}
    sourceTitle={forkSourceInfo?.title ?? ''}
    compactDisabled={forkSourceInfo?.kernel !== 'ts'}
    compactDisabledReason="Compact copies are available for TypeScript sessions."
    compactEstimates={forkEstimates}
    onClose={() => { forkModalOpen = false; forkSourceBranch = null }}
    onConfirm={handleForkConfirm}
/>

{#if deleteModal}
    <DeleteModeModal
        sessionTitle={deleteModal.title}
        bind:mode={deleteModal.mode}
        onCancel={() => deleteModal = null}
        onConfirm={confirmDeleteModal}
    />
{/if}

<style>
    .overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.5);
        z-index: 100;
    }

    .drawer {
        position: fixed;
        top: 0;
        left: 0;
        bottom: 0;
        width: 300px;
        max-width: 85vw;
        background: var(--surface);
        border-right: 1px solid var(--border);
        padding: 1.25rem;
        z-index: 101;
        display: flex;
        flex-direction: column;
    }

    .drawer-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 1rem;
    }

    h2 {
        font-size: 1.1rem;
        font-weight: 600;
    }

    .new-btn {
        color: white;
        border: none;
        border-radius: 6px;
        padding: 0.35rem 0.6rem;
        font-size: 0.8rem;
        font-weight: 600;
        cursor: pointer;
    }

    /* Split-button group: primary `+ New` (creates TS) plus a small
       chevron edge that opens a dropdown for alternates (currently
       just py-experimental). Visual hierarchy is firmly on the
       primary action; py-create is one click further in but
       discoverable via the chevron affordance.

       The two buttons render as visually fused — shared height,
       borderless seam between them, single rounded rectangle
       enclosing both. Chevron stays in the TS kernel color so the
       group reads as a single unit. */
    .split-btn-group {
        position: relative;
        display: inline-flex;
        align-items: stretch;
    }

    .new-btn.kernel-ts {
        background: #3b82f6;
    }

    .new-btn.kernel-ts:hover {
        background: #2563eb;
    }

    .split-btn-main {
        border-top-right-radius: 0;
        border-bottom-right-radius: 0;
    }

    .split-btn-edge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0 0.4rem;
        background: #3b82f6;
        color: white;
        border: none;
        border-left: 1px solid color-mix(in srgb, #ffffff 20%, transparent);
        border-top-right-radius: 6px;
        border-bottom-right-radius: 6px;
        cursor: pointer;
    }

    .split-btn-edge:hover {
        background: #2563eb;
    }

    .split-btn-edge svg {
        flex-shrink: 0;
    }

    /* Dropdown menu sits below the split button, aligned to the
       right edge so it stays inside the drawer on narrow viewports.
       Backdrop is a full-viewport overlay that catches click-out
       without forcing us to wire a document-level listener. */
    .split-menu-backdrop {
        position: fixed;
        inset: 0;
        z-index: 200;
    }

    .split-menu {
        position: absolute;
        top: calc(100% + 0.3rem);
        right: 0;
        z-index: 201;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 6px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
        min-width: 220px;
        padding: 0.25rem;
    }

    .split-menu-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.6rem;
        width: 100%;
        padding: 0.45rem 0.6rem;
        background: none;
        color: var(--text);
        border: none;
        border-radius: 4px;
        font-size: 0.85rem;
        text-align: left;
        cursor: pointer;
    }

    .split-menu-item:hover {
        background: var(--surface-hover);
    }

    .split-menu-item-label {
        color: var(--text);
        white-space: nowrap;
    }

    .split-menu-item-tag {
        font-size: 0.65rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        padding: 0.1rem 0.35rem;
        border-radius: 3px;
        background: color-mix(in srgb, var(--warning) 18%, transparent);
        color: var(--warning);
        white-space: nowrap;
    }

    .header-actions {
        display: flex;
        align-items: center;
        gap: 0.4rem;
    }

    .header-btn {
        background: none;
        color: var(--text-muted);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 0.3rem 0.6rem;
        font-size: 0.75rem;
        font-weight: 500;
        cursor: pointer;
    }

    .header-btn:hover {
        color: var(--text);
        border-color: var(--text-muted);
    }

    .import-error {
        margin: 0 0 0.5rem 0;
        padding: 0.4rem 0.6rem;
        background: color-mix(in srgb, var(--error) 15%, transparent);
        border: 1px solid var(--error);
        border-radius: 4px;
        color: var(--error);
        font-size: 0.72rem;
    }

    .session-list {
        flex: 1;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
    }

    /* Section header for the Apps / Recent grouping. Quiet — uppercase
       micro-label, not a heavy divider — so it organizes without
       competing with the session rows. The first one drops its top
       margin so the list doesn't open with a gap. */
    .group-label {
        font-size: 0.62rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-muted);
        padding: 0.15rem 0.75rem;
        margin-top: 0.5rem;
    }

    .group-label:first-child {
        margin-top: 0;
    }

    .session-item {
        padding: 0.6rem 0.75rem;
        border-radius: 6px;
        cursor: pointer;
        display: flex;
        flex-direction: column;
        gap: 0.2rem;
        /* `relative` so the mobile overflow button can absolute-
           anchor to the row's top-right corner without stretching
           the meta line (the button's 44px touch target was
           pushing inactive vs active rows to different heights). */
        position: relative;
    }

    .session-item:hover {
        background: var(--surface-hover);
    }

    /* Manual "check for updates" bar — shown only when ≥1 imported
       session exists. Forces a check past the lazy TTL. */
    .update-check-bar {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.3rem 1rem 0;
    }

    .update-check-btn {
        background: none;
        border: 1px solid var(--border);
        color: var(--text-muted);
        border-radius: 4px;
        padding: 0.18rem 0.5rem;
        font-size: 0.72rem;
        cursor: pointer;
    }

    .update-check-btn:hover:not(:disabled) {
        color: var(--text);
        background: var(--surface-hover);
    }

    .update-check-btn:disabled { opacity: 0.6; cursor: default; }

    .update-check-status {
        font-size: 0.72rem;
        color: var(--text-muted);
    }

    .session-meta {
        display: flex;
        align-items: center;
        justify-content: space-between;
    }

    .session-date {
        font-size: 0.7rem;
        color: var(--text-muted);
    }

    .cloud-stub {
        opacity: 0.75;
        border-style: dashed;
    }

    .stub-title {
        font-size: 0.9rem;
        color: var(--text-muted);
    }

    .stub-download {
        font-size: 0.75rem;
    }

    .action-btn {
        background: none;
        border: none;
        color: var(--text-muted);
        font-size: 0.65rem;
        cursor: pointer;
        padding: 0 0.2rem;
        line-height: 1;
    }

    .action-btn:hover {
        color: var(--accent);
    }

    /* Gallery entry — sits below the session list, above the debug
       section. Reads as "another place to go" in the same drawer
       context; subdued (no accent color) so it doesn't compete with
       active-session styling above it. */
    .gallery-link {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.55rem 0.75rem;
        margin-top: 0.75rem;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: transparent;
        color: var(--text-muted);
        text-decoration: none;
        font-size: 0.85rem;
        transition: color 0.15s, border-color 0.15s, background 0.15s;
    }

    .gallery-link:hover {
        color: var(--text);
        background: var(--surface-hover);
        border-color: color-mix(in srgb, var(--accent) 30%, var(--border));
    }

    .gallery-link-chevron {
        margin-left: auto;
        opacity: 0.6;
    }

    .gallery-link:hover .gallery-link-chevron {
        opacity: 1;
    }

</style>
