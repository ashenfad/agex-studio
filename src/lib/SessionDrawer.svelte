<script>
    import {
        sessionStore,
        createSession,
        switchSession,
        deleteSession,
        forkSession,
        getSessionDebugInfo,
        setSessionMeta,
        exportBundle,
        importBundle,
        inspectBundle,
        getBundleStats,
        resetAppStorage,
        getAppStorageSize,
    } from './sessions.js'

    /** @type {{ open: boolean, onClose: () => void }} */
    let { open, onClose } = $props()

    let sessions = $derived($sessionStore.sessions)
    let currentBranch = $derived($sessionStore.currentBranch)

    let storageUsage = $state(null)
    let purgeConfirm = $state(false)
    let purging = $state(false)
    let deleteConfirmBranch = $state(null)
    let settingsResetConfirm = $state(false)
    let debugInfo = $state(null)
    let debugOpen = $state(false)

    /** Session being edited in the meta modal, or null when closed. */
    let editingSession = $state(null)
    /** Current draft values in the meta modal. */
    let editName = $state('')
    let editDescription = $state('')
    let savingMeta = $state(false)

    /** Bundle being previewed before import, or null when no file loaded. */
    let importPreview = $state(null)  // { bytes, manifest }
    let importing = $state(false)
    let importError = $state('')

    /**
     * Export modal state machine:
     *   null              — modal closed
     *   { stage: 'loading', session }      — computing stats
     *   { stage: 'preview', session, stats }
     *   { stage: 'progress', session, stats, phase, done, total }
     *   { stage: 'done',    session, stats, manifest, bytes }
     *   { stage: 'error',   session, message }
     */
    let exportState = $state(null)

    /** @type {HTMLInputElement | undefined} */
    let fileInput = $state()

    $effect(() => {
        if (open) {
            purgeConfirm = false
            deleteConfirmBranch = null
            settingsResetConfirm = false
            debugInfo = null
            navigator.storage?.estimate?.().then(est => {
                storageUsage = est.usage ?? null
            }).catch(() => {})
        }
    })

    // Re-fetch debug info when the active session changes
    $effect(() => {
        if (debugOpen && currentBranch) {
            debugInfo = null
            getSessionDebugInfo(currentBranch).then(info => {
                debugInfo = info
            }).catch(e => {
                debugInfo = { error: e.message }
            })
        }
    })

    async function toggleDebug() {
        debugOpen = !debugOpen
        if (debugOpen && currentBranch) {
            debugInfo = null
            try {
                debugInfo = await getSessionDebugInfo(currentBranch)
            } catch (e) {
                debugInfo = { error: e.message }
            }
        }
    }

    function formatBytes(bytes) {
        if (bytes < 1024) return `${bytes} B`
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    }

    async function handlePurge() {
        if (!purgeConfirm) {
            purgeConfirm = true
            return
        }
        purging = true
        try {
            // Delete all IndexedDB databases (session data).
            // Settings and API keys live in localStorage and are preserved.
            const dbs = await indexedDB.databases()
            await Promise.all(dbs.map(db =>
                new Promise((resolve) => {
                    const req = indexedDB.deleteDatabase(db.name)
                    req.onsuccess = resolve
                    req.onerror = resolve
                    req.onblocked = resolve  // worker holds connection
                })
            ))
            // Reload to re-initialize with clean state
            window.location.reload()
        } catch {
            purging = false
            purgeConfirm = false
        }
    }

    async function handleNew() {
        try {
            await createSession()
            onClose()
        } catch (e) {
            console.error('Failed to create session:', e)
        }
    }

    async function handleFork(e, branch) {
        e.stopPropagation()
        try {
            if (branch !== currentBranch) {
                await switchSession(branch)
            }
            await forkSession()
        } catch (e) {
            console.error('Failed to fork session:', e)
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

    async function handleDelete(e, branch) {
        e.stopPropagation()
        if (deleteConfirmBranch !== branch) {
            deleteConfirmBranch = branch
            return
        }
        deleteConfirmBranch = null
        try {
            await deleteSession(branch)
        } catch (e) {
            console.error('Failed to delete session:', e)
        }
    }

    async function handleSettingsReset() {
        if (!editingSession) return
        if (!settingsResetConfirm) {
            settingsResetConfirm = true
            return
        }
        settingsResetConfirm = false
        try {
            await resetAppStorage(editingSession.branch)
            // The session list has been refreshed; pick up the zeroed
            // app_storage_bytes so the conditional reset-row hides.
            editingSession = sessions.find(s => s.branch === editingSession.branch) || editingSession
        } catch (err) {
            console.error('Failed to reset app storage:', err)
        }
    }

    function handleSettingsExport() {
        if (!editingSession) return
        const target = editingSession
        closeEdit()
        // Fire the existing export flow (preview → progress → done).
        handleExport({ stopPropagation: () => {} }, target)
    }

    function handleEdit(e, session) {
        e.stopPropagation()
        editingSession = session
        editName = session.name || ''
        editDescription = session.description || ''
    }

    function closeEdit() {
        editingSession = null
        editName = ''
        editDescription = ''
        settingsResetConfirm = false
    }

    async function handleExport(e, session) {
        e.stopPropagation()
        if (exportState) return
        exportState = { stage: 'loading', session }
        try {
            const stats = await getBundleStats(session.branch)
            exportState = { stage: 'preview', session, stats }
        } catch (err) {
            console.error('Failed to read bundle stats:', err)
            exportState = { stage: 'error', session, message: err.message || String(err) }
        }
    }

    function closeExport() {
        if (exportState?.stage === 'progress') return  // don't allow closing mid-export
        exportState = null
    }

    async function confirmExport() {
        if (!exportState || exportState.stage !== 'preview') return
        const { session, stats } = exportState
        exportState = { stage: 'progress', session, stats, phase: 'walking', done: 0, total: 0 }
        try {
            const { bytes, manifest } = await exportBundle(session.branch, (p) => {
                if (exportState?.stage === 'progress') {
                    exportState = { ...exportState, phase: p.phase, done: p.done, total: p.total }
                }
            })
            exportState = { stage: 'done', session, stats, manifest, bytes }
            triggerDownload(session, manifest, bytes)
        } catch (err) {
            console.error('Failed to export bundle:', err)
            exportState = { stage: 'error', session, message: err.message || String(err) }
        }
    }

    function triggerDownload(session, manifest, bytes) {
        const label = (manifest.name || session.title || session.branch).trim() || session.branch
        const safe = label.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'session'
        const blob = new Blob([bytes], { type: 'application/zip' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${safe}.agex`
        document.body.appendChild(a)
        a.click()
        a.remove()
        URL.revokeObjectURL(url)
    }

    function phaseLabel(phase) {
        switch (phase) {
            case 'walking': return 'Walking history'
            case 'packing-commits': return 'Packing commits'
            case 'packing-nodes': return 'Packing nodes'
            case 'packing-blobs': return 'Packing blobs'
            case 'finalizing': return 'Finalizing'
            default: return phase
        }
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

    async function handleSaveMeta(e) {
        e?.preventDefault?.()
        if (!editingSession || savingMeta) return
        savingMeta = true
        try {
            await setSessionMeta(
                editingSession.branch,
                editName.trim(),
                editDescription.trim(),
            )
            closeEdit()
        } catch (err) {
            console.error('Failed to save session meta:', err)
        } finally {
            savingMeta = false
        }
    }

    function formatDate(iso) {
        if (!iso) return ''
        const d = new Date(iso)
        const now = new Date()
        const diff = now.getTime() - d.getTime()
        if (diff < 60000) return 'just now'
        if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
        if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
        if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`
        return d.toLocaleDateString()
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
                <button class="new-btn" onclick={handleNew}>+ New</button>
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

        <div class="session-list">
            {#each sessions as s (s.branch)}
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div
                    class="session-item"
                    class:active={s.branch === currentBranch}
                    onclick={() => handleSwitch(s.branch)}
                    onkeydown={(e) => e.key === 'Enter' && handleSwitch(s.branch)}
                    role="button"
                    tabindex="0"
                >
                    <div class="session-title">
                        {s.name || s.title}
                    </div>
                    {#if s.description}
                        <div class="session-description" title={s.description}>{s.description}</div>
                    {/if}
                    <div class="session-meta">
                        <span class="session-date">
                            {formatDate(s.updated)}
                            {#if s.app_storage_bytes > 0}
                                <span class="app-storage-badge" title="App save data: {formatBytes(s.app_storage_bytes)}">· app</span>
                            {/if}
                        </span>
                        <span class="session-actions">
                            <button
                                class="action-btn"
                                onclick={(e) => handleFork(e, s.branch)}
                                title="Fork session"
                            >
                                fork
                            </button>
                            <button
                                class="action-btn icon-btn"
                                onclick={(e) => handleEdit(e, s)}
                                title="Session settings"
                                aria-label="Session settings"
                            >
                                &#9881;
                            </button>
                            {#if sessions.length > 1}
                                <button
                                    class="action-btn delete"
                                    class:confirm={deleteConfirmBranch === s.branch}
                                    onclick={(e) => handleDelete(e, s.branch)}
                                    title="Delete session"
                                >
                                    {deleteConfirmBranch === s.branch ? 'delete?' : '\u00d7'}
                                </button>
                            {/if}
                        </span>
                    </div>
                </div>
            {/each}
        </div>

        <div class="debug-section">
            <button class="debug-toggle" onclick={toggleDebug}>
                {debugOpen ? '▾' : '▸'} Debug
            </button>
            {#if debugOpen}
                <div class="debug-panel">
                    {#if debugInfo?.error}
                        <div class="debug-row error">{debugInfo.error}</div>
                    {:else if debugInfo}
                        <div class="debug-row"><span class="debug-label">Branch</span> <span class="debug-value mono">{debugInfo.branch}</span></div>
                        <div class="debug-row"><span class="debug-label">HEAD</span> <span class="debug-value mono">{debugInfo.commit ?? '(none)'}</span></div>
                        <div class="debug-row"><span class="debug-label">Commits</span> <span class="debug-value">{debugInfo.commits}</span></div>
                        <div class="debug-row"><span class="debug-label">Keys (total)</span> <span class="debug-value">{debugInfo.keys_total}</span></div>
                        <div class="debug-row"><span class="debug-label">HEAD size</span> <span class="debug-value">{formatBytes(debugInfo.bytes)}</span></div>
                        {#if debugInfo.top_keys?.length > 0}
                            <div class="debug-row" style="margin-top: 0.3rem"><span class="debug-label">Top keys by size</span></div>
                            <div class="debug-top-keys">
                                {#each debugInfo.top_keys as entry}
                                    <div class="debug-row">
                                        <span class="debug-value mono" style="flex:1; text-align:left">{entry.key}</span>
                                        <span class="debug-value">{formatBytes(entry.bytes)}</span>
                                    </div>
                                {/each}
                            </div>
                        {/if}
                        {#if debugInfo.keys.length > 0}
                            <div class="debug-row" style="margin-top: 0.3rem"><span class="debug-label">User keys</span></div>
                            <div class="debug-keys">
                                {#each debugInfo.keys as key}
                                    <span class="debug-key">{key}</span>
                                {/each}
                            </div>
                        {/if}
                    {:else}
                        <div class="debug-row">Loading...</div>
                    {/if}
                </div>
            {/if}
        </div>

        <div class="drawer-footer">
            {#if storageUsage !== null}
                <span class="storage-usage" title="Includes cached packages">{formatBytes(storageUsage)} used (incl. cache)</span>
            {/if}
            <button
                class="purge-btn"
                class:confirm={purgeConfirm}
                onclick={handlePurge}
                disabled={purging}
            >
                {#if purging}
                    Purging...
                {:else if purgeConfirm}
                    Confirm purge?
                {:else}
                    Purge all data
                {/if}
            </button>
        </div>
    </div>
{/if}

{#if exportState}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
        class="modal-overlay"
        onclick={closeExport}
        onkeydown={(e) => e.key === 'Escape' && closeExport()}
    ></div>
    <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-header">
            <h3>Export Session</h3>
        </div>

        {#if exportState.stage === 'loading'}
            <div class="modal-body">
                <div class="stage-loading">Reading session...</div>
            </div>
        {:else if exportState.stage === 'preview'}
            <div class="modal-body">
                <div class="preview-field">
                    <span class="field-label">Name</span>
                    <div class="preview-value">
                        {exportState.stats.name || exportState.stats.title || '(untitled)'}
                    </div>
                </div>
                {#if exportState.stats.description}
                    <div class="preview-field">
                        <span class="field-label">Description</span>
                        <div class="preview-value preview-description">
                            {exportState.stats.description}
                        </div>
                    </div>
                {/if}
                <div class="preview-field">
                    <span class="field-label">Contents</span>
                    <div class="preview-value preview-stats">
                        {exportState.stats.commits} commits{#if exportState.stats.app_storage_bytes > 0} · {formatBytes(exportState.stats.app_storage_bytes)} app save data{/if}
                    </div>
                </div>
                <div class="preview-hint">
                    Downloads a self-contained <code>.agex</code> bundle you can share, archive, or re-import as a new session.
                </div>
            </div>
            <div class="modal-actions">
                <button type="button" class="btn-cancel" onclick={closeExport}>Cancel</button>
                <button type="button" class="btn-save" onclick={confirmExport}>Export</button>
            </div>
        {:else if exportState.stage === 'progress'}
            <div class="modal-body">
                <div class="progress-label">{phaseLabel(exportState.phase)}</div>
                <div class="progress-bar">
                    <div
                        class="progress-fill"
                        class:indeterminate={!exportState.total}
                        style={exportState.total
                            ? `width: ${Math.round((exportState.done / exportState.total) * 100)}%`
                            : ''}
                    ></div>
                </div>
                <div class="progress-counts">
                    {#if exportState.total}
                        {exportState.done} / {exportState.total}
                    {:else}
                        working...
                    {/if}
                </div>
            </div>
        {:else if exportState.stage === 'done'}
            <div class="modal-body">
                <div class="stage-done">
                    <div class="done-check">✓</div>
                    <div class="done-message">
                        Bundle downloaded.
                    </div>
                    <div class="preview-stats">
                        {exportState.manifest.stats?.commits ?? 0} commits ·
                        {formatBytes(exportState.bytes.length)}
                    </div>
                </div>
            </div>
            <div class="modal-actions">
                <button type="button" class="btn-save" onclick={closeExport}>Close</button>
            </div>
        {:else if exportState.stage === 'error'}
            <div class="modal-body">
                <div class="import-error">{exportState.message}</div>
            </div>
            <div class="modal-actions">
                <button type="button" class="btn-cancel" onclick={closeExport}>Close</button>
            </div>
        {/if}
    </div>
{/if}

{#if importPreview}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="modal-overlay" onclick={closeImportPreview} onkeydown={(e) => e.key === 'Escape' && closeImportPreview()}></div>
    <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-header">
            <h3>Import Bundle</h3>
        </div>
        <div class="modal-body">
            <div class="preview-field">
                <span class="field-label">Name</span>
                <div class="preview-value">{importPreview.manifest.name || '(untitled)'}</div>
            </div>
            {#if importPreview.manifest.description}
                <div class="preview-field">
                    <span class="field-label">Description</span>
                    <div class="preview-value preview-description">{importPreview.manifest.description}</div>
                </div>
            {/if}
            {#if importPreview.manifest.author}
                <div class="preview-field">
                    <span class="field-label">Author</span>
                    <div class="preview-value">{importPreview.manifest.author}</div>
                </div>
            {/if}
            <div class="preview-field">
                <span class="field-label">Contents</span>
                <div class="preview-value preview-stats">
                    {importPreview.manifest.stats?.commits ?? 0} commits ·
                    {importPreview.manifest.stats?.blobs ?? 0} blobs ·
                    {formatBytes(importPreview.bytes.length)}
                </div>
            </div>
            {#if importError}
                <div class="import-error">{importError}</div>
            {/if}
        </div>
        <div class="modal-actions">
            <button type="button" class="btn-cancel" onclick={closeImportPreview} disabled={importing}>Cancel</button>
            <button type="button" class="btn-save" onclick={handleConfirmImport} disabled={importing}>
                {importing ? 'Importing...' : 'Import as new session'}
            </button>
        </div>
    </div>
{/if}

{#if editingSession}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="modal-overlay" onclick={closeEdit} onkeydown={(e) => e.key === 'Escape' && closeEdit()}></div>
    <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-header">
            <h3>Session Settings</h3>
        </div>
        <form onsubmit={handleSaveMeta}>
            <div class="modal-body">
                <div class="section-label">Details</div>
                <label class="field">
                    <span class="field-label">Name</span>
                    <input
                        type="text"
                        bind:value={editName}
                        placeholder={editingSession.title}
                        autofocus
                    />
                    <div class="field-hint">Custom label for this session. If blank, the agent-generated title ({editingSession.title}) is used.</div>
                </label>
                <label class="field">
                    <span class="field-label">Description</span>
                    <textarea
                        bind:value={editDescription}
                        placeholder="What is this session for?"
                        rows="4"
                    ></textarea>
                    <div class="field-hint">Shown when sharing this session as an artifact.</div>
                </label>

                <div class="section-divider"></div>
                <div class="section-label">Actions</div>
                <div class="action-row">
                    <button
                        type="button"
                        class="btn-action"
                        onclick={handleSettingsExport}
                        disabled={!!exportState}
                    >
                        Export bundle
                    </button>
                    <div class="action-hint">Download this session as a shareable <code>.agex</code> file.</div>
                </div>
                {#if editingSession.app_storage_bytes > 0}
                    <div class="action-row">
                        <button
                            type="button"
                            class="btn-action destructive"
                            class:confirm={settingsResetConfirm}
                            onclick={handleSettingsReset}
                        >
                            {settingsResetConfirm ? 'Confirm reset?' : 'Reset app data'}
                        </button>
                        <div class="action-hint">
                            Clear {formatBytes(editingSession.app_storage_bytes)} of app
                            save data. The agent's code is preserved.
                        </div>
                    </div>
                {/if}
            </div>
            <div class="modal-actions">
                <button type="button" class="btn-cancel" onclick={closeEdit}>Cancel</button>
                <button type="submit" class="btn-save" disabled={savingMeta}>
                    {savingMeta ? 'Saving...' : 'Save'}
                </button>
            </div>
        </form>
    </div>
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
        background: var(--accent);
        color: white;
        border: none;
        border-radius: 6px;
        padding: 0.35rem 0.75rem;
        font-size: 0.8rem;
        font-weight: 600;
        cursor: pointer;
    }

    .new-btn:hover {
        background: var(--accent-hover);
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

    .preview-field {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
    }

    .preview-value {
        font-size: 0.85rem;
        color: var(--text);
    }

    .preview-description {
        white-space: pre-wrap;
        line-height: 1.4;
    }

    .preview-stats {
        font-size: 0.75rem;
        color: var(--text-muted);
    }

    .preview-hint {
        font-size: 0.72rem;
        color: var(--text-muted);
        line-height: 1.4;
    }

    .preview-hint code {
        background: var(--input-bg, var(--surface));
        padding: 0.05rem 0.25rem;
        border-radius: 3px;
        font-size: 0.7rem;
    }

    .stage-loading {
        font-size: 0.85rem;
        color: var(--text-muted);
        padding: 0.5rem 0;
    }

    .progress-label {
        font-size: 0.8rem;
        color: var(--text);
        margin-bottom: 0.4rem;
    }

    .progress-bar {
        height: 6px;
        background: var(--input-bg, var(--surface));
        border-radius: 3px;
        overflow: hidden;
        position: relative;
    }

    .progress-fill {
        height: 100%;
        background: var(--accent);
        transition: width 0.15s ease-out;
    }

    .progress-fill.indeterminate {
        width: 30%;
        animation: progress-indeterminate 1.2s ease-in-out infinite;
    }

    @keyframes progress-indeterminate {
        0% { transform: translateX(-100%); }
        100% { transform: translateX(400%); }
    }

    .progress-counts {
        font-size: 0.72rem;
        color: var(--text-muted);
        margin-top: 0.35rem;
        text-align: right;
    }

    .stage-done {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.35rem;
        padding: 0.4rem 0;
    }

    .done-check {
        font-size: 2rem;
        color: var(--accent);
        line-height: 1;
    }

    .done-message {
        font-size: 0.9rem;
        color: var(--text);
    }

    .session-list {
        flex: 1;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
    }

    .session-item {
        padding: 0.6rem 0.75rem;
        border-radius: 6px;
        cursor: pointer;
        display: flex;
        flex-direction: column;
        gap: 0.2rem;
    }

    .session-item:hover {
        background: var(--surface-hover);
    }

    .session-item.active {
        background: var(--surface-hover);
        border-left: 2px solid var(--accent);
    }

    .session-title {
        font-size: 0.85rem;
        font-weight: 500;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .session-description {
        font-size: 0.72rem;
        color: var(--text-muted);
        margin-top: 0.15rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
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

    .app-storage-badge {
        color: var(--accent);
        opacity: 0.6;
        margin-left: 0.15rem;
    }

    .action-btn.confirm {
        color: var(--accent);
        font-weight: 600;
        opacity: 1;
    }

    .session-actions {
        display: flex;
        gap: 0.3rem;
        opacity: 0;
    }

    .session-item:hover .session-actions {
        opacity: 1;
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

    .action-btn.delete {
        font-size: 1rem;
    }

    .action-btn.delete:hover {
        color: var(--error);
    }

    .action-btn.delete.confirm {
        color: var(--error);
        font-size: 0.65rem;
        font-weight: 600;
        opacity: 1;
    }

    .action-btn.icon-btn {
        font-size: 0.9rem;
        line-height: 1;
    }

    .section-label {
        font-size: 0.68rem;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.06em;
        font-weight: 600;
        margin-bottom: 0.15rem;
    }

    .section-divider {
        height: 1px;
        background: var(--border);
        margin: 0.3rem -1.1rem 0.8rem -1.1rem;
    }

    .action-row {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        margin-bottom: 0.4rem;
    }

    .action-row:last-child {
        margin-bottom: 0;
    }

    .btn-action {
        align-self: flex-start;
        padding: 0.4rem 0.75rem;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--surface);
        color: var(--text);
        font-size: 0.78rem;
        font-family: inherit;
        cursor: pointer;
    }

    .btn-action:hover:not(:disabled) {
        border-color: var(--text-muted);
    }

    .btn-action:disabled {
        opacity: 0.5;
        cursor: default;
    }

    .btn-action.destructive {
        color: var(--error);
        border-color: color-mix(in srgb, var(--error) 40%, var(--border));
    }

    .btn-action.destructive.confirm {
        background: color-mix(in srgb, var(--error) 15%, transparent);
        border-color: var(--error);
        font-weight: 600;
    }

    .action-hint {
        font-size: 0.7rem;
        color: var(--text-muted);
        line-height: 1.35;
    }

    .action-hint code {
        background: var(--input-bg, var(--surface));
        padding: 0.02rem 0.25rem;
        border-radius: 3px;
        font-size: 0.68rem;
    }

    .debug-section {
        border-top: 1px solid var(--border);
        padding-top: 0.5rem;
        margin-top: 0.5rem;
    }

    .debug-toggle {
        background: none;
        border: none;
        color: var(--text-muted);
        font-size: 0.7rem;
        cursor: pointer;
        padding: 0;
    }

    .debug-toggle:hover {
        color: var(--text);
    }

    .debug-panel {
        margin-top: 0.4rem;
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
    }

    .debug-row {
        display: flex;
        justify-content: space-between;
        font-size: 0.7rem;
        color: var(--text-muted);
    }

    .debug-row.error {
        color: var(--error);
    }

    .debug-label {
        font-weight: 500;
    }

    .debug-value {
        text-align: right;
    }

    .debug-value.mono {
        font-family: monospace;
        font-size: 0.65rem;
    }

    .debug-top-keys {
        display: flex;
        flex-direction: column;
        gap: 0.1rem;
        max-height: 160px;
        overflow-y: auto;
    }

    .debug-keys {
        display: flex;
        flex-wrap: wrap;
        gap: 0.2rem;
        margin-top: 0.15rem;
        max-height: 120px;
        overflow-y: auto;
    }

    .debug-key {
        font-size: 0.6rem;
        font-family: monospace;
        background: var(--input-bg);
        padding: 0.1rem 0.3rem;
        border-radius: 3px;
        color: var(--text-muted);
    }

    .drawer-footer {
        border-top: 1px solid var(--border);
        padding-top: 0.75rem;
        margin-top: 0.5rem;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
    }

    .storage-usage {
        font-size: 0.7rem;
        color: var(--text-muted);
    }

    .purge-btn {
        background: none;
        border: 1px solid var(--border);
        color: var(--text-muted);
        font-size: 0.7rem;
        padding: 0.3rem 0.6rem;
        border-radius: 4px;
        cursor: pointer;
        margin-left: auto;
    }

    .purge-btn:hover {
        color: var(--error);
        border-color: var(--error);
    }

    .purge-btn.confirm {
        color: var(--error);
        border-color: var(--error);
        font-weight: 600;
    }

    .purge-btn:disabled {
        opacity: 0.5;
        cursor: default;
    }

    /* -- Edit session modal -- */

    .modal-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.5);
        z-index: 200;
    }

    .modal {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: min(440px, calc(100% - 2rem));
        max-height: calc(100% - 2rem);
        overflow: auto;
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: 8px;
        z-index: 201;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
    }

    .modal-header {
        padding: 0.9rem 1.1rem;
        border-bottom: 1px solid var(--border);
    }

    .modal-header h3 {
        margin: 0;
        font-size: 0.95rem;
        font-weight: 600;
    }

    .modal-body {
        padding: 1.1rem;
        display: flex;
        flex-direction: column;
        gap: 1rem;
    }

    .field {
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
    }

    .field-label {
        font-size: 0.75rem;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.05em;
    }

    .field input,
    .field textarea {
        padding: 0.5rem 0.6rem;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--surface);
        color: var(--text);
        font-size: 0.85rem;
        font-family: inherit;
        resize: vertical;
    }

    .field-hint {
        font-size: 0.7rem;
        color: var(--text-muted);
        line-height: 1.35;
    }

    .modal-actions {
        display: flex;
        justify-content: flex-end;
        gap: 0.5rem;
        padding: 0.9rem 1.1rem;
        border-top: 1px solid var(--border);
    }

    .btn-cancel,
    .btn-save {
        padding: 0.45rem 0.85rem;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--surface);
        color: var(--text);
        font-size: 0.82rem;
        cursor: pointer;
    }

    .btn-save {
        background: var(--accent, var(--text));
        color: var(--bg);
        border-color: var(--accent, var(--text));
    }

    .btn-save:disabled {
        opacity: 0.5;
        cursor: default;
    }

    .btn-cancel:hover:not(:disabled),
    .btn-save:hover:not(:disabled) {
        filter: brightness(1.1);
    }
</style>
