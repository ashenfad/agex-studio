<script>
    import { sessionStore, createSession, switchSession, deleteSession, forkSession, getSessionDebugInfo } from './sessions.js'

    /** @type {{ open: boolean, onClose: () => void }} */
    let { open, onClose } = $props()

    let sessions = $derived($sessionStore.sessions)
    let currentBranch = $derived($sessionStore.currentBranch)

    let storageUsage = $state(null)
    let purgeConfirm = $state(false)
    let purging = $state(false)
    let deleteConfirmBranch = $state(null)
    let debugInfo = $state(null)
    let debugOpen = $state(false)

    $effect(() => {
        if (open) {
            purgeConfirm = false
            deleteConfirmBranch = null
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
        await createSession()
        onClose()
    }

    async function handleFork(e, branch) {
        e.stopPropagation()
        if (branch !== currentBranch) {
            await switchSession(branch)
        }
        await forkSession()
    }

    async function handleSwitch(branch) {
        if (branch === currentBranch) return
        await switchSession(branch)
    }

    async function handleDelete(e, branch) {
        e.stopPropagation()
        if (deleteConfirmBranch !== branch) {
            deleteConfirmBranch = branch
            return
        }
        deleteConfirmBranch = null
        await deleteSession(branch)
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
            <button class="new-btn" onclick={handleNew}>+ New</button>
        </div>

        <div class="session-list">
            {#each sessions as s}
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div
                    class="session-item"
                    class:active={s.branch === currentBranch}
                    onclick={() => handleSwitch(s.branch)}
                    onkeydown={(e) => e.key === 'Enter' && handleSwitch(s.branch)}
                    role="button"
                    tabindex="0"
                >
                    <div class="session-title">{s.title}</div>
                    <div class="session-meta">
                        <span class="session-date">{formatDate(s.updated)}</span>
                        <span class="session-actions">
                            <button
                                class="action-btn"
                                onclick={(e) => handleFork(e, s.branch)}
                                title="Fork session"
                            >
                                fork
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

    .session-meta {
        display: flex;
        align-items: center;
        justify-content: space-between;
    }

    .session-date {
        font-size: 0.7rem;
        color: var(--text-muted);
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
</style>
