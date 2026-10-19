<script>
    /**
     * A file of the session's, opened to read: text highlighted,
     * Markdown rendered (its ```mermaid blocks drawn), an image shown; downloaded or deleted from here.
     * One that isn't there (moved, deleted, a folder) says so instead.
     */
    import { errorText } from './errors.js'
    import Dialog from './Dialog.svelte'
    import { highlightCode } from './highlight.js'
    import { untrack } from 'svelte'
    import { fileLinkTarget, renderMarkdown } from './markdown.js'
    import { renderMermaidBlocks } from './mermaid.js'

    /** @type {{ session: import('./session.svelte.js').ChatSession, path: string, onClose: () => void }} */
    let { session, path, onClose } = $props()

    const ROOT = '/workspace'
    /** The file shown, relative to /workspace: `path`, until a link in a
     *  Markdown file opens another. */
    let shown = $state(untrack(() => path))
    $effect.pre(() => {
        shown = path
    })
    /** The folder the shown file's relative links start from. */
    const folder = $derived(`${ROOT}/${shown}`.replace(/\/[^/]*$/, ''))

    /** A link in a Markdown file to another workspace file opens it here.
     *  @param {MouseEvent} e */
    function follow(e) {
        const a = e.target instanceof Element ? e.target.closest('a[data-ws-path]') : null
        if (a === null) return
        e.preventDefault()
        const next = fileLinkTarget(a.getAttribute('data-ws-path'))
        if (next !== null) shown = next
    }
    const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i
    const TYPES = /** @type {Record<string, string>} */ ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' })

    /** @type {{ text?: string, url?: string, failed?: string } | null} */
    let content = $state(null)
    /** The rendered Markdown, when the file shown is Markdown.
     *  @type {HTMLElement | undefined} */
    let rendered = $state()

    // the diagrams in each Markdown file shown, once it's on the page
    $effect(() => {
        void content
        if (rendered != null) void renderMermaidBlocks(rendered)
    })
    let confirmingDelete = $state(false)

    $effect(() => {
        const ws = session.ws
        /** @type {string | null} */
        let url = null
        content = null
        void (async () => {
            try {
                const bytes = await /** @type {NonNullable<typeof ws>} */ (ws).files.read(`${ROOT}/${shown}`)
                if (IMAGE.test(shown)) {
                    const ext = /** @type {string} */ (shown.split('.').at(-1)).toLowerCase()
                    url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: TYPES[ext] ?? 'application/octet-stream' }))
                    content = { url }
                } else {
                    content = { text: new TextDecoder().decode(bytes) }
                }
            } catch (e) {
                content = { failed: unreadable(e) }
            }
        })()
        return () => {
            if (url !== null) URL.revokeObjectURL(url)
        }
    })

    /** Why the file can't be shown, in the person's terms.
     *  @param {unknown} e */
    function unreadable(e) {
        const code = e instanceof Error && 'code' in e ? e.code : null
        if (code === 'ENOENT' || code === 'ENOTDIR') return `There's no file at ${shown} now: it may have been moved, renamed or deleted.`
        if (code === 'EISDIR') return `${shown} is a folder, not a file: the Files tab shows what's in it.`
        return `This file can't be read: ${errorText(e)}`
    }

    async function download() {
        if (session.ws === null) return
        const bytes = await session.ws.files.read(`${ROOT}/${shown}`)
        const a = document.createElement('a')
        a.href = URL.createObjectURL(new Blob([new Uint8Array(bytes)]))
        a.download = shown.split('/').at(-1) ?? 'file'
        a.click()
        URL.revokeObjectURL(a.href)
    }

    async function remove() {
        if (session.ws === null) return
        await session.ws.files.remove(`${ROOT}/${shown}`)
        await session.refreshFiles()
        onClose()
    }
</script>

<Dialog label={shown} {onClose} width="60rem" tall fill>
    {#snippet heading()}
        <span class="path">{shown}</span>
        {#if !content?.failed}
            <button class="act" onclick={download}>Download</button>
            {#if confirmingDelete}
                <button class="act danger" onclick={remove}>Delete it</button>
                <button class="act" onclick={() => (confirmingDelete = false)}>Keep</button>
            {:else}
                <button class="act danger" onclick={() => (confirmingDelete = true)} disabled={session.busy} title={session.busy ? 'A turn is running' : 'Delete this file'}>Delete…</button>
            {/if}
        {/if}
    {/snippet}
    {#if content === null}
        <p class="empty">Reading…</p>
    {:else if content.failed}
        <p class="empty">{content.failed}</p>
    {:else if content.url}
        <img src={content.url} alt={shown} />
    {:else if /\.md$/i.test(shown)}
        <!-- a click on a link inside, which the keyboard reaches and opens as a link -->
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div class="markdown" bind:this={rendered} onclick={follow}>{@html renderMarkdown(content.text ?? '', { linkBase: folder })}</div>
    {:else}
        <pre><code>{@html highlightCode(content.text ?? '', shown)}</code></pre>
    {/if}
</Dialog>

<style>
    .path {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-family: var(--font-mono);
        font-size: 0.85rem;
        color: var(--text-muted);
    }
    .act {
        background: var(--bg);
        border: 1px solid var(--border);
        color: var(--text);
        border-radius: 4px;
        padding: 0.2rem 0.6rem;
        font: inherit;
        font-size: 0.85rem;
        cursor: pointer;
    }
    .act:disabled {
        opacity: 0.5;
        cursor: default;
    }
    .danger {
        border-color: var(--error);
        color: var(--error);
    }
    pre {
        font-family: var(--font-mono);
        font-size: 0.8rem;
        white-space: pre-wrap;
        word-break: break-word;
        margin: 0;
    }
    img {
        max-width: 100%;
    }
    .empty {
        color: var(--text-muted);
    }
</style>
