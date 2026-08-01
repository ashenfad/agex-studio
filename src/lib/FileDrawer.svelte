<script>
    import { getActiveAdapter } from './active-adapter.js'
    import { viewingFile } from './viewing-file.js'
    import { bytesToBlob } from './bytes.js'

    /** @type {{ open: boolean, onClose: () => void, files: string[], onDelete?: (names: string[], commitHash: string) => void, onFilesChanged?: (files: string[]) => void }} */
    let { open, onClose, files: rawFiles, onDelete, onFilesChanged } = $props()
    let files = $derived(rawFiles ?? [])

    /** @type {Set<string>} */
    let selected = $state(new Set())
    let operating = $state(false)

    function toggleSelect(path) {
        const next = new Set(selected)
        if (next.has(path)) next.delete(path)
        else next.add(path)
        selected = next
    }

    function clearSelection() {
        selected = new Set()
    }

    async function handleBatchDownload() {
        if (selected.size === 0 || operating) return
        operating = true
        try {
            const { adapter, branch } = await getActiveAdapter()
            for (const path of selected) {
                const bytes = await adapter.readFile(branch, path)
                const blob = bytesToBlob(bytes)
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url
                a.download = path.split('/').pop()
                a.click()
                URL.revokeObjectURL(url)
            }
        } catch (e) {
            console.error('Download failed:', e)
        } finally {
            operating = false
        }
    }

    async function handleBatchDelete() {
        if (selected.size === 0 || operating) return
        const names = [...selected]
        operating = true
        try {
            const { adapter, branch } = await getActiveAdapter()
            const commitHash = await adapter.getCurrentCommit(branch)
            // The legacy `/drive/` live mount is gone — Drive imports
            // now land under `/downloads/` and are deleted like any
            // other VFS file. Filter dropped.
            await adapter.deleteFiles(branch, names)

            onDelete?.(names, commitHash)
            selected = new Set()
            onFilesChanged?.(await adapter.listFiles(branch))
        } catch (e) {
            console.error('Delete failed:', e)
        } finally {
            operating = false
        }
    }

</script>

{#if open}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="overlay" onclick={onClose} onkeydown={(e) => e.key === 'Escape' && onClose()}></div>
    <div class="drawer">
        <div class="drawer-header">
            <h2>Files</h2>
            <!-- File uploads (local + Drive) moved to ChatInput's `+`
                 menu and chat-area drag-drop. The drawer is now a
                 browse-only view: list, select, delete, preview via
                 the shared FileModal. -->
        </div>

        {#if selected.size > 0}
            <div class="selection-bar">
                <span class="selection-count">{selected.size} selected</span>
                <div class="selection-actions">
                    <button class="sel-btn" onclick={handleBatchDownload} disabled={operating} title="Download selected">↓</button>
                    <button class="sel-btn del-btn" onclick={handleBatchDelete} disabled={operating} title="Delete selected">×</button>
                    <button class="sel-btn" onclick={clearSelection} title="Clear selection">Clear</button>
                </div>
            </div>
        {/if}

        {#if files.length === 0}
            <div class="empty">
                No files yet. Use the <strong>+</strong> button in the chat
                input bar (or drag files into the chat area) to add files.
            </div>
        {:else}
            <div class="file-list">
                {#each files as f}
                    <div class="file-row" class:selected={selected.has(f)}>
                        <input
                            type="checkbox"
                            class="file-check"
                            checked={selected.has(f)}
                            onchange={() => toggleSelect(f)}
                        />
                        <button
                            class="file-item"
                            onclick={() => viewingFile.set(f)}
                        >
                            {f}
                        </button>
                    </div>
                {/each}
            </div>
        {/if}

    </div>
    <!-- FileModal lives at App level subscribed to the `viewingFile`
         store; this drawer just sets the store on file-click. -->
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
        right: 0;
        bottom: 0;
        width: 360px;
        max-width: 90vw;
        background: var(--surface);
        border-left: 1px solid var(--border);
        padding: 1.25rem;
        z-index: 101;
        display: flex;
        flex-direction: column;
        overflow-y: auto;
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

    .selection-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0.4rem 0.6rem;
        margin-bottom: 0.5rem;
        background: var(--surface-hover);
        border-radius: 6px;
        font-size: 0.78rem;
    }

    .selection-count {
        color: var(--text-muted);
    }

    .selection-actions {
        display: flex;
        gap: 0.25rem;
    }

    .sel-btn {
        background: none;
        border: 1px solid var(--border);
        color: var(--text-muted);
        border-radius: 4px;
        padding: 0.15rem 0.5rem;
        font-size: 0.75rem;
        cursor: pointer;
    }

    .sel-btn:hover:not(:disabled) {
        background: var(--surface);
        color: var(--text);
    }

    .sel-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .del-btn:hover:not(:disabled) {
        border-color: var(--error, #e53e3e);
        color: var(--error, #e53e3e);
    }

    .empty {
        color: var(--text-muted);
        font-size: 0.85rem;
        text-align: center;
        padding: 2rem 0;
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    .file-list {
        display: flex;
        flex-direction: column;
        gap: 0.15rem;
    }

    .file-row {
        display: flex;
        align-items: center;
    }

    .file-row.selected {
        background: var(--surface-hover);
        border-radius: 4px;
    }

    .file-check {
        margin: 0 0.25rem 0 0.4rem;
        cursor: pointer;
        opacity: 0;
        transition: opacity 0.15s;
        flex-shrink: 0;
    }

    .file-row:hover .file-check,
    .file-check:checked {
        opacity: 1;
    }

    .file-item {
        flex: 1;
        background: none;
        border: none;
        color: var(--text);
        font-size: 0.8rem;
        font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
        padding: 0.4rem 0.6rem;
        border-radius: 4px;
        cursor: pointer;
        text-align: left;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .file-item:hover {
        background: var(--surface-hover);
    }

</style>
