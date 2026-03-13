<script>
    import { highlightCode } from './highlight.js'
    import { readFile, downloadFile, fileSize } from './agent.js'
    import { tick } from 'svelte'

    /** @type {{ path: string | null, onClose: () => void }} */
    let { path, onClose } = $props()

    const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg'])
    const TEXT_EXTS = new Set([
        '.py', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.json', '.css',
        '.html', '.htm', '.xml', '.md', '.markdown', '.sh', '.bash', '.zsh',
        '.yml', '.yaml', '.sql', '.svelte', '.txt', '.csv', '.tsv', '.log',
        '.cfg', '.ini', '.toml', '.env', '.gitignore', '.dockerfile',
        '.r', '.rs', '.go', '.java', '.c', '.cpp', '.h', '.hpp', '.rb',
    ])

    const PDFJS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174'

    function getExt(p) {
        const dot = p.lastIndexOf('.')
        return dot >= 0 ? p.slice(dot).toLowerCase() : ''
    }

    function getFileName(p) {
        return p.split('/').pop() || p
    }

    function formatSize(bytes) {
        if (bytes < 1024) return `${bytes} B`
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    }

    /** @type {'text' | 'image' | 'pdf' | 'binary'} */
    let fileType = $derived.by(() => {
        if (!path) return 'binary'
        const ext = getExt(path)
        if (ext === '.pdf') return 'pdf'
        if (IMAGE_EXTS.has(ext)) return 'image'
        if (TEXT_EXTS.has(ext)) return 'text'
        return 'binary'
    })

    let content = $state(null)
    let size = $state(null)
    let loading = $state(false)
    let error = $state(null)
    let pdfContainer = $state(null)

    async function loadPdfJs() {
        if (window.pdfjsLib) return window.pdfjsLib
        await new Promise((resolve, reject) => {
            const script = document.createElement('script')
            script.src = `${PDFJS_CDN}/pdf.min.js`
            script.onload = () => resolve()
            script.onerror = () => reject(new Error('Failed to load PDF.js'))
            document.head.appendChild(script)
        })
        if (!window.pdfjsLib) throw new Error('PDF.js not available')
        // Fetch worker script as blob URL to avoid cross-origin worker restrictions
        const resp = await fetch(`${PDFJS_CDN}/pdf.worker.min.js`)
        const blob = new Blob([await resp.text()], { type: 'application/javascript' })
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob)
        return window.pdfjsLib
    }

    async function renderPdf(b64, container) {
        const pdfjsLib = await loadPdfJs()
        const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
        const pdf = await pdfjsLib.getDocument({ data: bytes }).promise
        const containerWidth = container.clientWidth

        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i)
            const baseViewport = page.getViewport({ scale: 1 })
            const scale = Math.min((containerWidth - 48) / baseViewport.width, 2)
            const viewport = page.getViewport({ scale })

            const canvas = document.createElement('canvas')
            canvas.width = viewport.width
            canvas.height = viewport.height
            canvas.style.display = 'block'
            canvas.style.margin = '0 auto 1rem'
            canvas.style.maxWidth = '100%'
            container.appendChild(canvas)

            await page.render({
                canvasContext: canvas.getContext('2d'),
                viewport,
            }).promise
        }
    }

    $effect(() => {
        if (!path) return
        content = null
        size = null
        error = null
        loading = true

        const currentPath = path
        const type = fileType

        if (type === 'text') {
            readFile(currentPath)
                .then(text => { if (path === currentPath) content = text })
                .catch(e => { if (path === currentPath) error = e.message })
                .finally(() => { if (path === currentPath) loading = false })
        } else if (type === 'image') {
            downloadFile(currentPath)
                .then(b64 => {
                    if (path === currentPath) {
                        const ext = getExt(currentPath)
                        const mime = ext === '.svg' ? 'image/svg+xml'
                            : ext === '.gif' ? 'image/gif'
                            : ext === '.webp' ? 'image/webp'
                            : ext === '.png' ? 'image/png'
                            : 'image/jpeg'
                        content = `data:${mime};base64,${b64}`
                    }
                })
                .catch(e => { if (path === currentPath) error = e.message })
                .finally(() => { if (path === currentPath) loading = false })
        } else if (type === 'pdf') {
            downloadFile(currentPath)
                .then(async b64 => {
                    if (path !== currentPath) return
                    content = b64
                    loading = false
                    await tick()
                    if (pdfContainer && path === currentPath) {
                        pdfContainer.innerHTML = ''
                        try {
                            await renderPdf(b64, pdfContainer)
                        } catch (e) {
                            error = e.message
                        }
                    }
                })
                .catch(e => { if (path === currentPath) { error = e.message; loading = false } })
        } else {
            fileSize(currentPath)
                .then(s => { if (path === currentPath) size = s })
                .catch(e => { if (path === currentPath) error = e.message })
                .finally(() => { if (path === currentPath) loading = false })
        }
    })

    function handleKeydown(e) {
        if (e.key === 'Escape') onClose()
    }

    async function handleDownload() {
        try {
            const b64 = await downloadFile(path)
            const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
            const blob = new Blob([bytes])
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = getFileName(path)
            a.click()
            URL.revokeObjectURL(url)
        } catch (e) {
            console.error('Download failed:', e)
        }
    }
</script>

{#if path}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="modal-overlay" onclick={onClose} onkeydown={handleKeydown}>
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div class="modal" onclick={(e) => e.stopPropagation()}>
            <div class="modal-header">
                <span class="modal-path">{path}</span>
                <div class="modal-actions">
                    <button class="action-btn" onclick={handleDownload} title="Download">↓</button>
                    <button class="action-btn close-btn" onclick={onClose} title="Close">×</button>
                </div>
            </div>

            <div class="modal-body">
                {#if loading}
                    <div class="centered">Loading...</div>
                {:else if error}
                    <div class="centered error">Error: {error}</div>
                {:else if fileType === 'text' && content != null}
                    <pre><code>{@html highlightCode(content, path)}</code></pre>
                {:else if fileType === 'image' && content}
                    <div class="image-container">
                        <img src={content} alt={getFileName(path)} />
                    </div>
                {:else if fileType === 'pdf'}
                    <div class="pdf-container" bind:this={pdfContainer}></div>
                {:else if fileType === 'binary'}
                    <div class="centered meta">
                        <div class="meta-name">{getFileName(path)}</div>
                        <div class="meta-ext">{getExt(path) || 'No extension'}</div>
                        {#if size != null}
                            <div class="meta-size">{formatSize(size)}</div>
                        {/if}
                        <button class="download-action" onclick={handleDownload}>Download</button>
                    </div>
                {/if}
            </div>
        </div>
    </div>
{/if}

<style>
    .modal {
        width: 80vw;
        height: 80vh;
        max-width: 1100px;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 10px;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .modal-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0.6rem 1rem;
        border-bottom: 1px solid var(--border);
        gap: 0.5rem;
    }

    .modal-path {
        font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
        font-size: 0.8rem;
        color: var(--text-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;
    }

    .modal-actions {
        display: flex;
        gap: 0.25rem;
        flex-shrink: 0;
    }

    .action-btn {
        background: none;
        border: none;
        color: var(--text-muted);
        font-size: 1.1rem;
        cursor: pointer;
        padding: 0.15rem 0.4rem;
        border-radius: 4px;
        line-height: 1;
    }

    .action-btn:hover {
        background: var(--surface-hover);
        color: var(--text);
    }

    .close-btn {
        font-size: 1.3rem;
    }

    .modal-body {
        flex: 1;
        overflow: auto;
    }

    .modal-body pre {
        margin: 0;
        padding: 1rem 1.25rem;
        font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
        font-size: 0.78rem;
        white-space: pre-wrap;
        word-break: break-word;
        line-height: 1.5;
    }

    .image-container {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 1.5rem;
        height: 100%;
        box-sizing: border-box;
    }

    .image-container img {
        max-width: 100%;
        max-height: 100%;
        object-fit: contain;
        border-radius: 4px;
    }

    .pdf-container {
        padding: 1rem 1.5rem;
    }

    .centered {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 100%;
        color: var(--text-muted);
        font-size: 0.85rem;
    }

    .error {
        color: var(--error, #e53e3e);
    }

    .meta {
        gap: 0.5rem;
    }

    .meta-name {
        font-size: 1.1rem;
        font-weight: 600;
        color: var(--text);
    }

    .meta-ext {
        font-size: 0.85rem;
        color: var(--text-muted);
        text-transform: uppercase;
    }

    .meta-size {
        font-size: 0.9rem;
        color: var(--text-muted);
    }

    .download-action {
        margin-top: 0.75rem;
        background: var(--accent);
        color: white;
        border: none;
        border-radius: 6px;
        padding: 0.4rem 1rem;
        font-size: 0.8rem;
        font-weight: 600;
        cursor: pointer;
    }

    .download-action:hover {
        background: var(--accent-hover);
    }
</style>
