<script>
    import { highlightCode } from './highlight.js'
    import { renderMarkdown } from './markdown.js'
    import { getActiveAdapter } from './active-adapter.js'
    import { tick } from 'svelte'
    import Papa from 'papaparse'
    import { formatBytes, bytesToBlob } from './bytes.js'

    /** @type {{ path: string | null, onClose: () => void }} */
    let { path, onClose } = $props()

    const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg'])
    const CSV_EXTS = new Set(['.csv', '.tsv'])
    const MARKDOWN_EXTS = new Set(['.md', '.markdown'])
    const TEXT_EXTS = new Set([
        '.py', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.json', '.css',
        '.html', '.htm', '.xml', '.sh', '.bash', '.zsh',
        '.yml', '.yaml', '.sql', '.svelte', '.txt', '.csv', '.tsv', '.log',
        '.cfg', '.ini', '.toml', '.env', '.gitignore', '.dockerfile',
        '.r', '.rs', '.go', '.java', '.c', '.cpp', '.h', '.hpp', '.rb',
    ])

    const PDFJS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174'

    // Preview caps for text-like files. Large CSVs/logs were crashing
    // the modal because the full file was read, decoded, papa-parsed,
    // and rendered as one big `{#each}` (no virtualization). Three
    // tiers of defense:
    //   - HARD_READ_CAP: above this size, skip the read entirely and
    //     show download-only. Protects against true OOM on giant files.
    //   - PREVIEW_BYTES: cap of bytes we hand to the decoder. The full
    //     bytes were already in memory from the read, so this is about
    //     bounding decode + render cost, not RAM at read time.
    //   - PREVIEW_CSV_ROWS: papaparse `preview` option, hard-stops the
    //     parser after this many rows even within the byte cap.
    const HARD_READ_CAP = 50 * 1024 * 1024     // 50 MB
    const PREVIEW_BYTES = 1 * 1024 * 1024      // 1 MB of head
    const PREVIEW_CSV_ROWS = 5000

    function getExt(p) {
        const dot = p.lastIndexOf('.')
        return dot >= 0 ? p.slice(dot).toLowerCase() : ''
    }

    function getFileName(p) {
        return p.split('/').pop() || p
    }

    /** @type {'text' | 'markdown' | 'csv' | 'image' | 'pdf' | 'binary'} */
    let fileType = $derived.by(() => {
        if (!path) return 'binary'
        const ext = getExt(path)
        if (ext === '.pdf') return 'pdf'
        if (IMAGE_EXTS.has(ext)) return 'image'
        if (CSV_EXTS.has(ext)) return 'csv'
        if (MARKDOWN_EXTS.has(ext)) return 'markdown'
        if (TEXT_EXTS.has(ext)) return 'text'
        return 'binary'
    })

    function parseCsv(text) {
        if (!text) return null
        const result = Papa.parse(text.trim(), {
            header: false,
            skipEmptyLines: true,
            preview: PREVIEW_CSV_ROWS,
        })
        if (!result.data || result.data.length === 0) return null
        return { header: result.data[0], rows: result.data.slice(1) }
    }

    let content = $state(null)
    let size = $state(null)
    let loading = $state(false)
    let error = $state(null)
    let pdfContainer = $state(null)

    // Declared after `content`: `$derived` bodies are lazy, so the
    // previous ordering (above the `$state` it reads) happened to work,
    // but it's a temporal-dead-zone hazard the moment anything reads
    // this during init.
    let parsedCsv = $derived(fileType === 'csv' && content ? parseCsv(content) : null)

    // Truncation banner state. Set when we cap a text/csv preview so
    // the user knows there's more behind what's shown.
    /** @type {{ shownBytes: number, fullBytes: number, kind: 'bytes' | 'rows' } | null} */
    let truncated = $state(null)
    /** @type {boolean} */
    let tooLargeToPreview = $state(false)

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

    async function renderPdf(bytes, container) {
        const pdfjsLib = await loadPdfJs()
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
        truncated = null
        tooLargeToPreview = false

        const currentPath = path
        const type = fileType

        // Track blob URLs we create so we can revoke them when path
        // changes — Blob URLs don't get GC'd automatically.  Also
        // track a `cancelled` flag so that if the effect tears down
        // *during* an await (e.g. user clicks another file before
        // readFile resolves), the post-await branch can short-circuit
        // and revoke any URL it had time to create.
        let createdBlobUrl = null
        let cancelled = false

        const run = async () => {
            try {
                const { adapter, branch } = await getActiveAdapter()
                if (cancelled) return

                if (type === 'text' || type === 'csv' || type === 'markdown') {
                    // Probe size first so we can refuse oversized files
                    // before attempting the full read (read alone could
                    // OOM on multi-GB files even before decode/parse).
                    const fullSize = await adapter.fileSize(branch, currentPath)
                    if (cancelled) return
                    if (fullSize > HARD_READ_CAP) {
                        size = fullSize
                        tooLargeToPreview = true
                        return
                    }
                    const bytes = await adapter.readFile(branch, currentPath)
                    if (cancelled) return
                    // Cap before decode: even a successful read of a 40 MB
                    // CSV will hang the renderer if we let papa-parse it
                    // and Svelte render every row. Bytes are already in
                    // memory at this point — slicing is just bounding the
                    // downstream cost, not RAM at read time.
                    let head = bytes
                    if (bytes.length > PREVIEW_BYTES) {
                        head = bytes.subarray(0, PREVIEW_BYTES)
                        truncated = {
                            shownBytes: head.length,
                            fullBytes: bytes.length,
                            kind: 'bytes',
                        }
                    }
                    content = new TextDecoder('utf-8', { fatal: false }).decode(head)
                    // For CSVs, papaparse `preview: PREVIEW_CSV_ROWS`
                    // hard-stops the parser. If we didn't already mark
                    // a byte-truncation banner and we hit the row cap,
                    // surface it as a row-cap banner instead.
                    if (type === 'csv' && truncated === null) {
                        const parsed = parseCsv(content)
                        if (parsed && parsed.rows.length >= PREVIEW_CSV_ROWS - 1) {
                            truncated = {
                                shownBytes: head.length,
                                fullBytes: bytes.length,
                                kind: 'rows',
                            }
                        }
                    }
                } else if (type === 'image') {
                    const bytes = await adapter.readFile(branch, currentPath)
                    if (cancelled) return
                    const ext = getExt(currentPath)
                    const mime = ext === '.svg' ? 'image/svg+xml'
                        : ext === '.gif' ? 'image/gif'
                        : ext === '.webp' ? 'image/webp'
                        : ext === '.png' ? 'image/png'
                        : 'image/jpeg'
                    createdBlobUrl = URL.createObjectURL(bytesToBlob(bytes, mime))
                    if (cancelled) {
                        // Effect torn down between createObjectURL and
                        // assignment — clean up the just-leaked URL.
                        URL.revokeObjectURL(createdBlobUrl)
                        createdBlobUrl = null
                        return
                    }
                    content = createdBlobUrl
                } else if (type === 'pdf') {
                    const bytes = await adapter.readFile(branch, currentPath)
                    if (cancelled) return
                    content = 'pdf'  // truthy sentinel; we render into pdfContainer below
                    loading = false
                    await tick()
                    if (cancelled) return
                    if (pdfContainer) {
                        pdfContainer.innerHTML = ''
                        await renderPdf(bytes, pdfContainer)
                    }
                    return  // skip the finally-loading toggle; already handled
                } else {
                    const s = await adapter.fileSize(branch, currentPath)
                    if (cancelled) return
                    size = s
                }
            } catch (e) {
                if (!cancelled) error = e.message
            } finally {
                if (!cancelled) loading = false
            }
        }
        run()

        // Cleanup on path change / unmount: mark cancelled, then
        // revoke whatever blob URL exists. The cancelled flag closes
        // the race where `run()` is in the middle of an await; the
        // post-await branches re-check `cancelled` and short-circuit.
        return () => {
            cancelled = true
            if (createdBlobUrl) URL.revokeObjectURL(createdBlobUrl)
        }
    })

    function handleKeydown(e) {
        if (e.key === 'Escape') onClose()
    }

    async function handleDownload() {
        try {
            const { adapter, branch } = await getActiveAdapter()
            const bytes = await adapter.readFile(branch, path)
            const blob = bytesToBlob(bytes)
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
                {:else if tooLargeToPreview}
                    <div class="centered meta">
                        <div class="meta-name">{getFileName(path)}</div>
                        <div class="meta-ext">Too large to preview</div>
                        {#if size != null}
                            <div class="meta-size">{formatBytes(size)}</div>
                        {/if}
                        <div class="meta-hint">Files over {formatBytes(HARD_READ_CAP)} are download-only.</div>
                        <button class="download-action" onclick={handleDownload}>Download</button>
                    </div>
                {:else if fileType === 'csv' && parsedCsv}
                    {#if truncated}
                        <div class="truncation-banner">
                            Showing first {parsedCsv.rows.length.toLocaleString()} rows
                            ({formatBytes(truncated.shownBytes)} of {formatBytes(truncated.fullBytes)}).
                            <button class="banner-action" onclick={handleDownload}>Download full file</button>
                        </div>
                    {/if}
                    <div class="table-container">
                        <table>
                            <thead>
                                <tr>
                                    {#each parsedCsv.header as col}
                                        <th>{col}</th>
                                    {/each}
                                </tr>
                            </thead>
                            <tbody>
                                {#each parsedCsv.rows as row}
                                    <tr>
                                        {#each row as cell}
                                            <td>{cell}</td>
                                        {/each}
                                    </tr>
                                {/each}
                            </tbody>
                        </table>
                    </div>
                {:else if fileType === 'markdown' && content != null}
                    {#if truncated}
                        <div class="truncation-banner">
                            Showing first {formatBytes(truncated.shownBytes)} of {formatBytes(truncated.fullBytes)}.
                            <button class="banner-action" onclick={handleDownload}>Download full file</button>
                        </div>
                    {/if}
                    <div class="markdown markdown-body">{@html renderMarkdown(content)}</div>
                {:else if fileType === 'text' && content != null}
                    {#if truncated}
                        <div class="truncation-banner">
                            Showing first {formatBytes(truncated.shownBytes)} of {formatBytes(truncated.fullBytes)}.
                            <button class="banner-action" onclick={handleDownload}>Download full file</button>
                        </div>
                    {/if}
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
                            <div class="meta-size">{formatBytes(size)}</div>
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

    .table-container {
        overflow: auto;
        height: 100%;
        padding: 0.5rem;
    }

    table {
        border-collapse: collapse;
        font-size: 0.75rem;
        font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
        white-space: nowrap;
        width: max-content;
    }

    th, td {
        padding: 0.3rem 0.6rem;
        border: 1px solid var(--border);
        text-align: left;
        max-width: 300px;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    th {
        background: var(--surface-hover);
        font-weight: 600;
        position: sticky;
        top: 0;
        z-index: 1;
    }

    tr:hover td {
        background: var(--surface-hover);
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

    /* Document-read mode: looser spacing, bigger headings, themed
       accent colors. Layers on top of the shared `.markdown` rules
       in app.css — only overrides that differ from the chat baseline
       live here. */
    .markdown-body {
        padding: 1.25rem 1.5rem;
        font-size: 0.88rem;
        line-height: 1.65;
        color: var(--text);
    }

    .markdown-body :global(h1),
    .markdown-body :global(h2),
    .markdown-body :global(h3),
    .markdown-body :global(h4) {
        margin: 1.25em 0 0.5em;
        line-height: 1.3;
    }
    .markdown-body :global(h1) { font-size: 1.4em; }
    .markdown-body :global(h2) { font-size: 1.2em; }
    .markdown-body :global(h3) { font-size: 1.05em; }

    .markdown-body :global(p) { margin: 0.6em 0; }

    .markdown-body :global(ul),
    .markdown-body :global(ol) {
        margin: 0.5em 0;
        padding-left: 1.5em;
    }
    .markdown-body :global(li) { margin: 0.2em 0; }

    /* Inline code + code blocks use the themed surface-hover
       background instead of the chat baseline's rgba overlay. */
    .markdown-body :global(code) {
        background: var(--surface-hover);
        padding: 0.15em 0.35em;
        font-size: 0.85em;
    }
    .markdown-body :global(pre) {
        margin: 0.75em 0;
        padding: 0.75rem 1rem;
        background: var(--surface-hover);
    }

    .markdown-body :global(blockquote) {
        margin: 0.75em 0;
        padding: 0.25em 1em;
        border-left: 3px solid var(--border);
        background: none;
        color: var(--text-muted);
        border-radius: 0;
    }

    .markdown-body :global(a) { color: var(--accent); }

    .markdown-body :global(hr) {
        border: none;
        border-top: 1px solid var(--border);
        margin: 1em 0;
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

    .meta-hint {
        font-size: 0.75rem;
        color: var(--text-muted);
        max-width: 320px;
        text-align: center;
    }

    /* Sticky banner above the table / pre / markdown body when we've
       truncated the preview. Stays visible while the user scrolls
       through the head so they don't forget there's more behind it. */
    .truncation-banner {
        position: sticky;
        top: 0;
        z-index: 2;
        display: flex;
        align-items: center;
        gap: 0.6rem;
        padding: 0.45rem 0.85rem;
        background: var(--surface-hover);
        border-bottom: 1px solid var(--border);
        font-size: 0.75rem;
        color: var(--text-muted);
    }

    .banner-action {
        background: none;
        border: 1px solid var(--border);
        color: var(--text);
        font-size: 0.7rem;
        padding: 0.15rem 0.5rem;
        border-radius: 4px;
        cursor: pointer;
        margin-left: auto;
    }

    .banner-action:hover {
        background: var(--surface);
        border-color: var(--accent);
        color: var(--accent);
    }
</style>
