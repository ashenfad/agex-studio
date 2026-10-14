<script>
    /**
     * The session's files under /workspace: a tree to browse, a file
     * opened to read (text, Markdown, or an image), download, or delete,
     * and files to add (uploaded, or from Google Drive) under uploads/.
     */
    import { isDriveImportAvailable, pickFromDrive } from './drive-import.js'
    import { highlightCode } from './highlight.js'
    import { renderMarkdown } from './markdown.js'

    /** @type {{ session: import('./studio.svelte.js').ChatSession, onClose: () => void }} */
    let { session, onClose } = $props()

    const ROOT = '/workspace'
    const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i
    const TYPES = /** @type {Record<string, string>} */ ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' })

    /** A listed path that prefixes another is a directory. */
    const entries = $derived.by(() => {
        const all = new Set(session.files)
        return session.files.map((path) => ({
            path,
            depth: path.split('/').length - 1,
            name: path.split('/').at(-1) ?? path,
            dir: [...all].some((other) => other.startsWith(`${path}/`)),
        }))
    })

    /** @type {{ path: string, text?: string, url?: string, failed?: string } | null} */
    let open = $state(null)

    /** @param {string} path */
    async function view(path) {
        const full = `${ROOT}/${path}`
        try {
            const bytes = await /** @type {NonNullable<typeof session.ws>} */ (session.ws).files.read(full)
            if (IMAGE.test(path)) {
                const ext = /** @type {string} */ (path.split('.').at(-1)).toLowerCase()
                open = { path, url: URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: TYPES[ext] ?? 'application/octet-stream' })) }
            } else {
                open = { path, text: new TextDecoder().decode(bytes) }
            }
        } catch (e) {
            open = { path, failed: e instanceof Error ? e.message : String(e) }
        }
    }

    async function download() {
        if (open === null || session.ws === null) return
        const bytes = await session.ws.files.read(`${ROOT}/${open.path}`)
        const a = document.createElement('a')
        a.href = URL.createObjectURL(new Blob([new Uint8Array(bytes)]))
        a.download = open.path.split('/').at(-1) ?? 'file'
        a.click()
        URL.revokeObjectURL(a.href)
    }

    let confirmingDelete = $state(false)

    /** What came of the last add: the paths added, or what failed. */
    let added = $state('')
    /** @type {HTMLInputElement | undefined} */
    let picker = $state()
    const drive = isDriveImportAvailable()

    /** @param {{ name: string, bytes: Uint8Array }[]} files @param {string[]} [errors] */
    async function add(files, errors = []) {
        try {
            const paths = await session.importFiles(files)
            const done = paths.length > 0 ? `Added ${paths.map((p) => p.replace(`${ROOT}/`, '')).join(', ')}` : ''
            added = [done, ...errors].filter(Boolean).join('; ')
        } catch (e) {
            added = e instanceof Error ? e.message : String(e)
        }
    }

    async function upload() {
        const chosen = [...(picker?.files ?? [])]
        if (picker) picker.value = ''
        await add(await Promise.all(chosen.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))))
    }

    async function fromDrive() {
        try {
            const { files, errors } = await pickFromDrive()
            await add(files, errors)
        } catch (e) {
            added = e instanceof Error ? e.message : String(e)
        }
    }

    async function remove() {
        if (open === null || session.ws === null) return
        await session.ws.files.remove(`${ROOT}/${open.path}`)
        confirmingDelete = false
        open = null
        await session.refreshFiles()
    }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="backdrop" role="presentation" onclick={onClose} onkeydown={(e) => e.key === 'Escape' && onClose()}>
    <div class="drawer" role="dialog" aria-label="Files" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
        <header>
            <h2>Files</h2>
            <button onclick={() => picker?.click()} disabled={session.busy} title="Add files from this device to uploads/">Upload</button>
            {#if drive}
                <button onclick={fromDrive} disabled={session.busy} title="Add files from Google Drive to uploads/">From Drive</button>
            {/if}
            <input bind:this={picker} type="file" multiple hidden onchange={upload} />
            <button class="close" onclick={onClose} aria-label="Close">✕</button>
        </header>
        {#if added}
            <p class="added">{added}</p>
        {/if}
        {#if open === null}
            {#if entries.length === 0}
                <p class="empty">No files yet.</p>
            {:else}
                <ul>
                    {#each entries as e (e.path)}
                        <li style:padding-left={`${e.depth}rem`}>
                            {#if e.dir}
                                <span class="dir">{e.name}/</span>
                            {:else}
                                <button class="file" onclick={() => view(e.path)}>{e.name}</button>
                            {/if}
                        </li>
                    {/each}
                </ul>
            {/if}
        {:else}
            <div class="bar">
                <button onclick={() => { open = null; confirmingDelete = false }}>← Files</button>
                <span class="path">{open.path}</span>
                <button onclick={download}>Download</button>
                {#if confirmingDelete}
                    <button class="danger" onclick={remove}>Delete it</button>
                    <button onclick={() => (confirmingDelete = false)}>Keep</button>
                {:else}
                    <button class="danger" onclick={() => (confirmingDelete = true)}>Delete…</button>
                {/if}
            </div>
            <div class="content">
                {#if open.failed}
                    <p class="empty">{open.failed}</p>
                {:else if open.url}
                    <img src={open.url} alt={open.path} />
                {:else if /\.md$/i.test(open.path)}
                    <div class="markdown">{@html renderMarkdown(open.text ?? '')}</div>
                {:else}
                    <pre><code>{@html highlightCode(open.text ?? '', open.path)}</code></pre>
                {/if}
            </div>
        {/if}
    </div>
</div>

<style>
    .backdrop {
        position: fixed;
        inset: 0;
        background: rgb(0 0 0 / 40%);
        z-index: 10;
        display: flex;
        justify-content: flex-end;
    }
    .drawer {
        background: var(--surface);
        border-left: 1px solid var(--border);
        width: min(40rem, 100vw);
        height: 100%;
        display: flex;
        flex-direction: column;
    }
    header {
        display: flex;
        gap: 0.4rem;
        align-items: center;
        padding: 0.6rem 1rem;
        border-bottom: 1px solid var(--border);
    }
    h2 {
        font-family: var(--font-display);
        font-size: 1.1rem;
        margin-right: auto;
    }
    header button:not(.close) {
        background: var(--bg);
        border: 1px solid var(--border);
        color: var(--text);
        border-radius: 4px;
        padding: 0.2rem 0.6rem;
        font-size: 0.85rem;
        cursor: pointer;
    }
    header button:disabled {
        opacity: 0.5;
        cursor: default;
    }
    .added {
        padding: 0.4rem 1rem;
        border-bottom: 1px solid var(--border);
        color: var(--text-muted);
        font-size: 0.8rem;
    }
    .close {
        background: none;
        border: none;
        color: var(--text);
        cursor: pointer;
    }
    ul {
        list-style: none;
        padding: 0.6rem 1rem;
        overflow-y: auto;
    }
    li {
        padding: 0.15rem 0;
    }
    .dir {
        color: var(--text-muted);
    }
    .file {
        background: none;
        border: none;
        color: var(--text);
        cursor: pointer;
        font: inherit;
        padding: 0;
    }
    .file:hover {
        color: var(--accent);
    }
    .bar {
        display: flex;
        flex-wrap: wrap;
        gap: 0.4rem;
        align-items: center;
        padding: 0.5rem 1rem;
        border-bottom: 1px solid var(--border);
        font-size: 0.85rem;
    }
    .bar button {
        background: var(--bg);
        border: 1px solid var(--border);
        color: var(--text);
        border-radius: 4px;
        padding: 0.2rem 0.6rem;
        cursor: pointer;
    }
    .bar .danger {
        border-color: var(--error);
        color: var(--error);
    }
    .path {
        flex: 1;
        font-family: var(--font-mono);
        color: var(--text-muted);
    }
    .content {
        flex: 1;
        overflow: auto;
        padding: 0.8rem 1rem;
    }
    pre {
        font-family: var(--font-mono);
        font-size: 0.8rem;
        white-space: pre-wrap;
        word-break: break-word;
    }
    img {
        max-width: 100%;
    }
    .empty {
        padding: 1rem;
        color: var(--text-muted);
    }
</style>
