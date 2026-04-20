<script>
    import { uploadFiles, downloadFile, deleteFiles, listFiles } from './agent.js'
    import { importFromDrive, isDriveImportAvailable } from './drive-import.js'
    import FileModal from './FileModal.svelte'

    /** @type {{ open: boolean, onClose: () => void, files: string[], onUpload?: (names: string[], commitHash: string) => void, onDelete?: (names: string[], commitHash: string) => void, onFilesChanged?: (files: string[]) => void }} */
    let { open, onClose, files: rawFiles, onUpload, onDelete, onFilesChanged } = $props()
    let files = $derived(rawFiles ?? [])

    let importing = $state(false)
    const showDriveImport = $derived(isDriveImportAvailable())

    async function handleImportFromDrive() {
        if (importing) return
        importing = true
        try {
            const written = await importFromDrive()
            if (written.length > 0) {
                // Refresh the file list so /downloads/... appear
                onFilesChanged?.(await listFiles())
            }
        } catch (e) {
            console.error('Drive import failed:', e)
        } finally {
            importing = false
        }
    }

    let viewingFile = $state(null)
    let uploading = $state(false)
    let dragOver = $state(false)
    /** @type {Set<string>} */
    let selected = $state(new Set())
    let operating = $state(false)

    let fileInput = $state(null)

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
            for (const path of selected) {
                const b64 = await downloadFile(path)
                const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
                const blob = new Blob([bytes])
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
            const commitHash = await getCurrentCommit()
            const driveNames = names.filter(n => n.startsWith('drive/'))
            const regularNames = names.filter(n => !n.startsWith('drive/'))

            // Unshare drive files by removing matching picks
            if (driveNames.length) {
                const current = await getDrivePicks()
                // Match picks whose name appears as the path component after drive/
                // Handles extensions: drive/Doc.md → pick name "Doc", drive/Slides.pdf → "Slides"
                const driveParts = driveNames.map(n => n.slice('drive/'.length).split('/')[0])
                const updated = current.filter(f =>
                    !driveParts.some(p => p === f.name || p.startsWith(f.name + '.'))
                )
                setDriveFiles(updated)
                await setDrivePicks(updated)
            }

            // Delete regular files
            if (regularNames.length) {
                await deleteFiles(regularNames)
            }

            onDelete?.(names, commitHash)
            selected = new Set()
            onFilesChanged?.(await listFiles())
        } catch (e) {
            console.error('Delete failed:', e)
        } finally {
            operating = false
        }
    }

    async function processFiles(fileList) {
        if (!fileList.length) return
        uploading = true
        try {
            const payload = []
            for (const file of fileList) {
                const buf = await file.arrayBuffer()
                const bytes = new Uint8Array(buf)
                let binary = ''
                for (let j = 0; j < bytes.length; j += 8192) {
                    binary += String.fromCharCode.apply(null, bytes.subarray(j, j + 8192))
                }
                const b64 = btoa(binary)
                payload.push({ name: file.name, data: b64 })
            }
            const commitHash = await getCurrentCommit()
            await uploadFiles(payload)
            onUpload?.(payload.map(f => f.name), commitHash)
        } catch (e) {
            console.error('Upload failed:', e)
        } finally {
            uploading = false
        }
    }

    function handleFileInput(e) {
        processFiles([...e.target.files])
        e.target.value = ''
    }

    function handleDrop(e) {
        e.preventDefault()
        dragOver = false
        processFiles([...e.dataTransfer.files])
    }

    function handleDragOver(e) {
        e.preventDefault()
        dragOver = true
    }

    function handleDragLeave() {
        dragOver = false
    }
</script>

{#if open}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="overlay" onclick={onClose} onkeydown={(e) => e.key === 'Escape' && onClose()}></div>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
        class="drawer"
        class:drag-over={dragOver}
        ondrop={handleDrop}
        ondragover={handleDragOver}
        ondragleave={handleDragLeave}
    >
        <div class="drawer-header">
            <h2>Files</h2>
            <div class="header-actions">
                {#if showDriveImport}
                    <button class="drive-btn" onclick={handleImportFromDrive} disabled={importing}>
                        {importing ? 'Importing...' : 'Import from Drive'}
                    </button>
                {/if}
                <button class="upload-btn" onclick={() => fileInput.click()} disabled={uploading}>
                    {uploading ? 'Uploading...' : 'Upload'}
                </button>
            </div>
            <input
                bind:this={fileInput}
                type="file"
                multiple
                onchange={handleFileInput}
                class="hidden-input"
            />
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
                {#if dragOver}
                    Drop files here
                {:else}
                    No files — drag & drop or click Upload
                {/if}
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
                            onclick={() => viewingFile = f}
                        >
                            {f}
                        </button>
                    </div>
                {/each}
            </div>
        {/if}

        {#if dragOver && files.length > 0}
            <div class="drop-overlay">Drop files here</div>
        {/if}
    </div>

    <FileModal path={viewingFile} onClose={() => viewingFile = null} />
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

    .drawer.drag-over {
        border-left-color: var(--accent);
    }

    .drawer-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 1rem;
    }

    .header-actions {
        display: flex;
        gap: 0.4rem;
    }

    h2 {
        font-size: 1.1rem;
        font-weight: 600;
    }

    .drive-btn {
        background: none;
        border: 1px solid var(--border);
        color: var(--text-muted);
        border-radius: 6px;
        padding: 0.35rem 0.75rem;
        font-size: 0.8rem;
        font-weight: 600;
        cursor: pointer;
    }

    .drive-btn:hover:not(:disabled) {
        background: var(--surface-hover);
        color: var(--text);
    }

    .drive-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .upload-btn {
        background: var(--accent);
        color: white;
        border: none;
        border-radius: 6px;
        padding: 0.35rem 0.75rem;
        font-size: 0.8rem;
        font-weight: 600;
        cursor: pointer;
    }

    .upload-btn:hover:not(:disabled) {
        background: var(--accent-hover);
    }

    .upload-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .hidden-input {
        display: none;
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

    .drop-overlay {
        position: absolute;
        inset: 0;
        background: rgba(0, 0, 0, 0.6);
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--accent);
        font-size: 1rem;
        font-weight: 600;
        border-radius: inherit;
        pointer-events: none;
    }
</style>
